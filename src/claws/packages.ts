import { runPluginInstallCommand } from "../cli/plugins-install-command.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { installSkillFromClawHub } from "../skills/lifecycle/clawhub.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { persistClawPackageRef, type PersistedClawPackageRef } from "./provenance.js";
import type { ClawAddPlan, ClawAddPlanAction, ClawPackage } from "./types.js";

export class ClawPackageInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly installedPackages: PersistedClawPackageRef[],
  ) {
    super(message);
    this.name = "ClawPackageInstallError";
  }
}

type PackageInstallerDeps = {
  installSkill?: typeof installSkillFromClawHub;
  installPlugin?: typeof runPluginInstallCommand;
  persistPackageRef?: typeof persistClawPackageRef;
};

function packageFromAction(action: ClawAddPlanAction): ClawPackage {
  const details = action.details as Partial<ClawPackage> | undefined;
  if (details?.kind !== "skill" && details?.kind !== "plugin") {
    throw new Error(`Package action ${JSON.stringify(action.id)} has no valid package kind.`);
  }
  if (details.source !== "clawhub" || !details.ref || !details.version) {
    throw new Error(`Package action ${JSON.stringify(action.id)} is not a pinned ClawHub package.`);
  }
  return {
    kind: details.kind,
    source: details.source,
    ref: details.ref,
    version: details.version,
  };
}

function installerRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return {
    log: (value) => runtime.log(value),
    error: (value) => runtime.error(value),
    exit: (code) => {
      throw new Error(`Plugin installer exited with code ${code}.`);
    },
  };
}

export async function installClawPackages(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    deps?: PackageInstallerDeps;
    runtime?: RuntimeEnv;
    nowMs?: number;
  } = {},
): Promise<PersistedClawPackageRef[]> {
  const deps = options.deps ?? {};
  const installSkill = deps.installSkill ?? installSkillFromClawHub;
  const installPlugin = deps.installPlugin ?? runPluginInstallCommand;
  const persistPackageRef = deps.persistPackageRef ?? persistClawPackageRef;
  const runtime = options.runtime ?? defaultRuntime;
  const installedPackages: PersistedClawPackageRef[] = [];

  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    try {
      const pkg = packageFromAction(action);
      if (pkg.kind === "skill") {
        const result = await installSkill({
          workspaceDir: plan.agent.workspace,
          slug: pkg.ref,
          version: pkg.version,
          logger: {
            info: (message) => runtime.log(message),
            warn: (message) => runtime.log(message),
          },
        });
        if (!result.ok) {
          throw new Error(result.error);
        }
      } else {
        await installPlugin({
          raw: `clawhub:${pkg.ref}@${pkg.version}`,
          opts: {},
          invalidateRuntimeCache: false,
          runtime: installerRuntime(runtime),
        });
      }
      installedPackages.push(persistPackageRef(plan, pkg, options));
    } catch (error) {
      throw new ClawPackageInstallError(
        "package_install_failed",
        error instanceof Error ? error.message : String(error),
        installedPackages,
      );
    }
  }

  return installedPackages;
}

export function clawPackageRefMatchesPluginInstall(
  ref: PersistedClawPackageRef,
  pluginId: string,
  record: PluginInstallRecord,
): boolean {
  if (ref.kind !== "plugin" || ref.source !== "clawhub" || record.source !== "clawhub") {
    return false;
  }
  const installedRef =
    record.clawhubPackage ?? record.spec?.replace(/^clawhub:/i, "").replace(/@[^@]+$/, "");
  const installedVersion = record.version ?? record.resolvedVersion;
  return (installedRef ?? pluginId) === ref.ref && installedVersion === ref.version;
}
