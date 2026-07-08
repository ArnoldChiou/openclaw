// Applies supported Claw artifact installers through existing OpenClaw install paths.
import { dirname, isAbsolute, resolve } from "node:path";
import { runPluginInstallCommand } from "../cli/plugins-install-command.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveFileNpmSpecToLocalPath } from "../infra/plugin-install-specs.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { pluginInstallRecordMatchesClawArtifact } from "./artifact-identity.js";
import { artifactKeyFor } from "./provenance.js";
import type { ClawApplyPlan, ClawApplyPlanEntry, ClawDiagnostic } from "./types.js";

export class ClawArtifactApplyError extends Error {
  constructor(
    readonly diagnostics: ClawDiagnostic[],
    readonly partialResult?: ClawArtifactInstallerResult,
  ) {
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

type EnabledPluginMatcher = Pick<ReadonlySet<string>, "has">;

function isLocalAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\");
}

function splitLocalGitSelector(selector: string): { base: string; refSuffix: string } | undefined {
  const trimmed = selector.trim();
  if (!trimmed.toLowerCase().startsWith("git:")) {
    return undefined;
  }
  const body = trimmed.slice("git:".length).trim();
  if (!(body.startsWith("./") || body.startsWith("../"))) {
    return undefined;
  }
  const hashIndex = body.lastIndexOf("#");
  if (hashIndex > 0) {
    return { base: body.slice(0, hashIndex), refSuffix: body.slice(hashIndex) };
  }
  const atIndex = body.lastIndexOf("@");
  if (atIndex > 0) {
    return { base: body.slice(0, atIndex), refSuffix: body.slice(atIndex) };
  }
  return { base: body, refSuffix: "" };
}

function resolveLocalSelector(selector: string, sourcePath?: string): string {
  const trimmed = selector.trim();
  const lower = trimmed.toLowerCase();
  const localGit = splitLocalGitSelector(trimmed);
  if (localGit) {
    const resolvedBase = resolve(sourcePath ? dirname(sourcePath) : process.cwd(), localGit.base);
    return `git:file://${resolvedBase}${localGit.refSuffix}`;
  }
  let localPath: string | undefined;
  let prefix = "";
  if (lower.startsWith("npm-pack:")) {
    localPath = trimmed.slice("npm-pack:".length).trim();
    prefix = "npm-pack:";
  } else if (lower.startsWith("file:")) {
    const fileSpec = resolveFileNpmSpecToLocalPath(trimmed);
    localPath = fileSpec?.ok ? fileSpec.path : trimmed.slice("file:".length).trim();
  } else if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
    localPath = trimmed;
  }
  if (!localPath) {
    return selector;
  }
  const resolvedPath = isLocalAbsolutePath(localPath)
    ? localPath
    : resolve(sourcePath ? dirname(sourcePath) : process.cwd(), localPath);
  return `${prefix}${resolvedPath}`;
}

function artifactEntries(plan: ClawApplyPlan): ClawApplyPlanEntry[] {
  return plan.entries.filter(
    (entry) => !entry.blocked && entry.phase === "artifact" && entry.action === "installArtifact",
  );
}

function pluginArtifactEntries(plan: ClawApplyPlan): ClawApplyPlanEntry[] {
  return artifactEntries(plan).filter((entry) => entry.artifact?.installSurface === "plugins");
}

function unsupportedArtifactEntries(plan: ClawApplyPlan): ClawApplyPlanEntry[] {
  return artifactEntries(plan).filter(
    (entry) => entry.required !== false && entry.artifact?.installSurface !== "plugins",
  );
}

function hasMatchingPluginInstallRecord(
  entry: ClawApplyPlanEntry,
  records: Record<string, PluginInstallRecord>,
  sourcePath?: string,
  enabledPluginIds?: EnabledPluginMatcher,
): boolean {
  return Object.entries(records).some(([pluginId, record]) => {
    if (enabledPluginIds && !enabledPluginIds.has(pluginId)) {
      return false;
    }
    return pluginInstallRecordMatchesClawArtifact(entry, record, sourcePath);
  });
}

async function readEnabledPluginIds(): Promise<EnabledPluginMatcher | undefined> {
  try {
    const snapshot = await readConfigFileSnapshot();
    const config = snapshot.sourceConfig ?? snapshot.config;
    const plugins = config.plugins;
    if (plugins?.enabled === false) {
      return new Set();
    }
    const allow = plugins?.allow ?? [];
    const deny = new Set(plugins?.deny ?? []);
    const entries = plugins?.entries ?? {};
    const pluginEntries = Object.entries(entries);
    if (allow.length === 0 && deny.size === 0 && pluginEntries.length === 0) {
      return undefined;
    }
    if (allow.length === 0) {
      if (deny.size === 0 && pluginEntries.every(([, entry]) => entry?.enabled !== false)) {
        return undefined;
      }
      return {
        has: (pluginId: string) => !deny.has(pluginId) && entries[pluginId]?.enabled !== false,
      };
    }
    const enabled = new Set(allow);
    for (const [pluginId, entry] of pluginEntries) {
      if (entry?.enabled === true && allow.includes(pluginId)) {
        enabled.add(pluginId);
      }
    }
    for (const pluginId of deny) {
      enabled.delete(pluginId);
    }
    for (const [pluginId, entry] of pluginEntries) {
      if (entry?.enabled === false) {
        enabled.delete(pluginId);
      }
    }
    return enabled;
  } catch {
    return undefined;
  }
}

function createInstallerRuntime(
  runtime: RuntimeEnv,
  diagnostics: ClawDiagnostic[],
  options: { quiet?: boolean } = {},
): RuntimeEnv {
  return {
    log: (value) => {
      if (!options.quiet) {
        runtime.log(value);
      }
    },
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
    quiet?: boolean;
  } = {},
): Promise<ClawArtifactInstallerResult> {
  const deps = options.deps ?? {};
  const loadRecords =
    deps.loadInstalledPluginIndexInstallRecords ?? loadInstalledPluginIndexInstallRecords;
  const installPlugin = deps.runPluginInstallCommand ?? runPluginInstallCommand;
  const runtime = options.runtime ?? defaultRuntime;
  const diagnostics: ClawDiagnostic[] = [];
  const unsupportedEntries = unsupportedArtifactEntries(plan);
  if (unsupportedEntries.length > 0) {
    throw new ClawArtifactApplyError(
      unsupportedEntries.map((entry) => ({
        level: "error",
        code: "artifact_install_surface_unsupported",
        path: `$.entries[${plan.entries.indexOf(entry)}]`,
        message: `Claw artifact ${entry.id} uses install surface ${entry.artifact?.installSurface ?? entry.kind}, which is not supported by mutating apply yet.`,
      })),
    );
  }
  const entries = pluginArtifactEntries(plan);
  const sourcePath = options.sourcePath ?? plan.claw.sourcePath;
  let currentRecords = await loadRecords();
  let enabledPluginIds = await readEnabledPluginIds();
  const directArtifactKeys = new Set<string>();
  const createdArtifactKeys = new Set<string>();
  const installedArtifactKeys = new Set<string>();
  const installedEntries = new Map<string, ClawApplyPlanEntry>();
  const satisfiedArtifactKeys = new Set<string>();

  for (const entry of entries) {
    const artifactKey = artifactKeyFor(entry, sourcePath);
    if (satisfiedArtifactKeys.has(artifactKey)) {
      continue;
    }
    if (hasMatchingPluginInstallRecord(entry, currentRecords, sourcePath, enabledPluginIds)) {
      satisfiedArtifactKeys.add(artifactKey);
      continue;
    }

    const partialResult = () => ({
      directArtifactKeys,
      createdArtifactKeys,
      installedArtifactKeys,
    });
    try {
      await installPlugin({
        raw: resolveLocalSelector(entry.artifact?.selector ?? entry.target ?? entry.id, sourcePath),
        opts: { pluginOnly: true },
        invalidateRuntimeCache: false,
        runtime: createInstallerRuntime(runtime, diagnostics, { quiet: options.quiet }),
      });
    } catch (error) {
      if (error instanceof ClawArtifactApplyError) {
        throw new ClawArtifactApplyError(error.diagnostics, partialResult());
      }
      throw error;
    }
    installedArtifactKeys.add(artifactKey);
    installedEntries.set(artifactKey, entry);
    satisfiedArtifactKeys.add(artifactKey);
    currentRecords = await loadRecords();
    enabledPluginIds = await readEnabledPluginIds();
    createdArtifactKeys.add(artifactKey);
    const missingInstalledKey = [...installedEntries].find(
      ([, installedEntry]) =>
        !hasMatchingPluginInstallRecord(
          installedEntry,
          currentRecords,
          sourcePath,
          enabledPluginIds,
        ),
    )?.[0];
    if (missingInstalledKey) {
      createdArtifactKeys.delete(missingInstalledKey);
      installedArtifactKeys.delete(missingInstalledKey);
      throw new ClawArtifactApplyError(
        [
          {
            level: "error",
            code: "artifact_install_record_missing",
            path: "$.entries",
            message: `Artifact installer completed but did not record expected plugin artifact ${missingInstalledKey}.`,
          },
        ],
        partialResult(),
      );
    }
  }

  return { directArtifactKeys, createdArtifactKeys, installedArtifactKeys };
}
