// Applies supported Claw artifact installers through existing OpenClaw install paths.
import { dirname, isAbsolute, resolve } from "node:path";
import { runPluginInstallCommand } from "../cli/plugins-install-command.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { pluginArtifactKeyFromInstallRecord } from "./artifact-identity.js";
import { artifactKeyFor } from "./provenance.js";
import type { ClawApplyPlan, ClawApplyPlanEntry, ClawDiagnostic } from "./types.js";

export class ClawArtifactApplyError extends Error {
  constructor(readonly diagnostics: ClawDiagnostic[]) {
    super("Claw artifact apply failed");
  }
}

export type ClawArtifactInstallerResult = {
  directArtifactKeys: Set<string>;
  createdArtifactKeys: Set<string>;
  installedArtifactKeys: Set<string>;
};

type ClawArtifactInstallerDeps = {
  loadInstalledPluginIndexInstallRecords?: typeof loadInstalledPluginIndexInstallRecords;
  runPluginInstallCommand?: typeof runPluginInstallCommand;
};

function isLocalAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\");
}

function resolveLocalSelector(selector: string, sourcePath?: string): string {
  const trimmed = selector.trim();
  const lower = trimmed.toLowerCase();
  let localPath: string | undefined;
  if (lower.startsWith("npm-pack:")) {
    localPath = trimmed.slice("npm-pack:".length).trim();
  } else if (lower.startsWith("file:")) {
    localPath = trimmed.slice("file:".length).trim();
  } else if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
    localPath = trimmed;
  }
  if (!localPath) {
    return selector;
  }
  if (isLocalAbsolutePath(localPath)) {
    return localPath;
  }
  return resolve(sourcePath ? dirname(sourcePath) : process.cwd(), localPath);
}

function artifactEntries(plan: ClawApplyPlan): ClawApplyPlanEntry[] {
  return plan.entries.filter(
    (entry) =>
      !entry.blocked &&
      entry.phase === "artifact" &&
      entry.action === "installArtifact" &&
      entry.artifact?.installSurface === "plugins",
  );
}

function directPluginArtifactKeys(records: Record<string, PluginInstallRecord>): Set<string> {
  const keys = new Set<string>();
  for (const [pluginId, record] of Object.entries(records)) {
    const key = pluginArtifactKeyFromInstallRecord(pluginId, record);
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

function createInstallerRuntime(runtime: RuntimeEnv, diagnostics: ClawDiagnostic[]): RuntimeEnv {
  return {
    log: (value) => runtime.log(value),
    error: (value) => {
      diagnostics.push({
        level: "error",
        code: "artifact_install_failed",
        path: "$.entries",
        message: String(value),
      });
      runtime.error(value);
    },
    exit: (code) => {
      throw new ClawArtifactApplyError([
        ...diagnostics,
        {
          level: "error",
          code: "artifact_install_exit",
          path: "$.entries",
          message: `Artifact installer exited with code ${code}.`,
        },
      ]);
    },
  };
}

export async function applyClawArtifactInstallers(
  plan: ClawApplyPlan,
  options: {
    sourcePath?: string;
    runtime?: RuntimeEnv;
    deps?: ClawArtifactInstallerDeps;
  } = {},
): Promise<ClawArtifactInstallerResult> {
  const deps = options.deps ?? {};
  const loadRecords =
    deps.loadInstalledPluginIndexInstallRecords ?? loadInstalledPluginIndexInstallRecords;
  const installPlugin = deps.runPluginInstallCommand ?? runPluginInstallCommand;
  const runtime = options.runtime ?? defaultRuntime;
  const diagnostics: ClawDiagnostic[] = [];
  const before = directPluginArtifactKeys(await loadRecords());
  const directArtifactKeys = new Set<string>();
  const createdArtifactKeys = new Set<string>();
  const installedArtifactKeys = new Set<string>();

  for (const entry of artifactEntries(plan)) {
    const artifactKey = artifactKeyFor(entry, options.sourcePath ?? plan.claw.sourcePath);
    if (before.has(artifactKey)) {
      directArtifactKeys.add(artifactKey);
      continue;
    }

    await installPlugin({
      raw: resolveLocalSelector(
        entry.artifact?.selector ?? entry.target ?? entry.id,
        options.sourcePath,
      ),
      opts: {},
      invalidateRuntimeCache: false,
      runtime: createInstallerRuntime(runtime, diagnostics),
    });
    installedArtifactKeys.add(artifactKey);
  }

  const after = directPluginArtifactKeys(await loadRecords());
  for (const key of installedArtifactKeys) {
    if (!after.has(key)) {
      throw new ClawArtifactApplyError([
        {
          level: "error",
          code: "artifact_install_record_missing",
          path: "$.entries",
          message: `Artifact installer completed but did not record expected plugin artifact ${key}.`,
        },
      ]);
    }
    if (!before.has(key)) {
      createdArtifactKeys.add(key);
    }
  }

  return { directArtifactKeys, createdArtifactKeys, installedArtifactKeys };
}
