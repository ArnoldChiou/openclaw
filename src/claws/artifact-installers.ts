// Applies supported Claw artifact installers through existing OpenClaw install paths.
import fs from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { runPluginInstallCommand } from "../cli/plugins-install-command.js";
import { getRuntimeConfig, readConfigFileSnapshot } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveFileNpmSpecToLocalPath } from "../infra/plugin-install-specs.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { resolveWorkspaceSkillInstallDir } from "../skills/lifecycle/archive-install.js";
import {
  installSkillFromClawHub,
  readClawHubSkillsLockfileStatusSync,
  resolveClawHubSkillStatusLinkSync,
} from "../skills/lifecycle/clawhub.js";
import {
  installSkillFromSource,
  isSkillSourceInstallSpec,
} from "../skills/lifecycle/source-install.js";
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
  installSkillFromClawHub?: typeof installSkillFromClawHub;
  installSkillFromSource?: typeof installSkillFromSource;
  readClawHubSkillsLockfileStatusSync?: typeof readClawHubSkillsLockfileStatusSync;
  readSkillSourceOrigin?: typeof readSkillSourceOrigin;
  resolveClawHubSkillStatusLinkSync?: typeof resolveClawHubSkillStatusLinkSync;
  resolveSkillsWorkspaceDir?: typeof resolveSkillsWorkspaceDir;
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

function skillArtifactEntries(plan: ClawApplyPlan): ClawApplyPlanEntry[] {
  return artifactEntries(plan).filter((entry) => entry.artifact?.installSurface === "skills");
}

function unsupportedArtifactEntries(plan: ClawApplyPlan): ClawApplyPlanEntry[] {
  return artifactEntries(plan).filter(
    (entry) =>
      entry.required !== false &&
      entry.artifact?.installSurface !== "plugins" &&
      entry.artifact?.installSurface !== "skills",
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

function resolveSkillsWorkspaceDir(): {
  config: ReturnType<typeof getRuntimeConfig>;
  workspaceDir: string;
} {
  const config = getRuntimeConfig();
  const agentId =
    resolveAgentIdByWorkspacePath(config, process.cwd()) ?? resolveDefaultAgentId(config);
  return {
    config,
    workspaceDir: resolveAgentWorkspaceDir(config, agentId),
  };
}

type ClawHubSkillTarget = {
  installRef: string;
  slug: string;
  ownerHandle?: string;
  version?: string;
};

function stripClawHubSkillVersion(ref: string, version?: string): string {
  if (version && ref.endsWith(`@${version}`)) {
    return ref.slice(0, -`@${version}`.length);
  }
  if (!ref.startsWith("@")) {
    return ref.replace(/@[^/@]+$/, "");
  }
  const slashIndex = ref.indexOf("/");
  if (slashIndex < 0) {
    return ref;
  }
  const owner = ref.slice(0, slashIndex + 1);
  const slug = ref.slice(slashIndex + 1).replace(/@[^/@]+$/, "");
  return `${owner}${slug}`;
}

function parseClawHubSkillSelector(entry: ClawApplyPlanEntry): ClawHubSkillTarget | undefined {
  const artifact = entry.artifact;
  const selector = artifact?.selector?.trim() ?? "";
  if (!selector.toLowerCase().startsWith("clawhub:")) {
    return undefined;
  }
  const ref = selector.slice("clawhub:".length).trim();
  if (!ref) {
    return undefined;
  }
  const installRef = stripClawHubSkillVersion(ref, artifact?.version);
  if (installRef.startsWith("@")) {
    const slashIndex = installRef.indexOf("/");
    if (slashIndex <= 1 || slashIndex === installRef.length - 1) {
      return undefined;
    }
    return {
      installRef,
      ownerHandle: installRef.slice(1, slashIndex),
      slug: installRef.slice(slashIndex + 1),
      ...(artifact?.version ? { version: artifact.version } : {}),
    };
  }
  if (installRef.includes("/")) {
    return undefined;
  }
  return {
    installRef,
    slug: installRef,
    ...(artifact?.version ? { version: artifact.version } : {}),
  };
}

function readTrackedClawHubSkill(
  entry: ClawApplyPlanEntry,
  workspaceDir: string,
  deps: ClawArtifactInstallerDeps,
): { installed: boolean } {
  const target = parseClawHubSkillSelector(entry);
  if (!target) {
    return { installed: false };
  }
  const readLock = deps.readClawHubSkillsLockfileStatusSync ?? readClawHubSkillsLockfileStatusSync;
  const lock = readLock(workspaceDir);
  if (lock.kind !== "found") {
    return { installed: false };
  }
  const readStatus = deps.resolveClawHubSkillStatusLinkSync ?? resolveClawHubSkillStatusLinkSync;
  const status = readStatus({
    workspaceDir,
    skillDir: resolveWorkspaceSkillInstallDir(workspaceDir, target.slug),
    skillKey: target.slug,
    lockRead: lock,
  });
  if (!status?.valid || status.slug !== target.slug) {
    return { installed: false };
  }
  if (target.ownerHandle && status.ownerHandle !== target.ownerHandle) {
    return { installed: false };
  }
  if (target.version && status.installedVersion !== target.version) {
    return { installed: false };
  }
  return { installed: true };
}

type SkillSourceOrigin = {
  version: 1;
  source: "path" | "git";
  spec: string;
  slug: string;
};

async function readSkillSourceOrigin(skillDir: string): Promise<SkillSourceOrigin | undefined> {
  try {
    const raw = await fs.readFile(resolve(skillDir, ".openclaw", "source-origin.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<SkillSourceOrigin>;
    if (
      parsed.version === 1 &&
      (parsed.source === "path" || parsed.source === "git") &&
      typeof parsed.spec === "string" &&
      typeof parsed.slug === "string"
    ) {
      return {
        version: 1,
        source: parsed.source,
        spec: parsed.spec,
        slug: parsed.slug,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function hasMatchingSkillInstall(
  entry: ClawApplyPlanEntry,
  workspaceDir: string,
  deps: ClawArtifactInstallerDeps,
  sourcePath?: string,
): Promise<boolean> {
  if (entry.artifact?.source === "clawhub") {
    return readTrackedClawHubSkill(entry, workspaceDir, deps).installed;
  }
  if (entry.artifact?.source === "path" || entry.artifact?.source === "git") {
    const readOrigin = deps.readSkillSourceOrigin ?? readSkillSourceOrigin;
    const origin = await readOrigin(resolveWorkspaceSkillInstallDir(workspaceDir, entry.id));
    const selector = resolveLocalSelector(
      entry.artifact?.selector ?? entry.target ?? entry.id,
      sourcePath,
    );
    return (
      origin?.source === entry.artifact.source &&
      origin.slug === entry.id &&
      origin.spec === selector
    );
  }
  return false;
}

function unsupportedSkillEntry(entry: ClawApplyPlanEntry): ClawDiagnostic | undefined {
  const source = entry.artifact?.source;
  if (source === "clawhub" || source === "path" || source === "git") {
    return undefined;
  }
  return {
    level: "error",
    code: "skill_artifact_source_unsupported",
    path: "$.entries",
    message: `Claw skill artifact ${entry.id} uses selector ${entry.artifact?.selector ?? entry.target ?? entry.id}, which is not supported by mutating apply yet.`,
  };
}

function invalidClawHubSkillSelectorDiagnostic(entry: ClawApplyPlanEntry): ClawDiagnostic {
  return {
    level: "error",
    code: "skill_artifact_selector_invalid",
    path: "$.entries",
    message: `Claw skill artifact ${entry.id} uses invalid ClawHub selector ${entry.artifact?.selector ?? entry.target ?? entry.id}.`,
  };
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
  const installSkillHub = deps.installSkillFromClawHub ?? installSkillFromClawHub;
  const installSkillSource = deps.installSkillFromSource ?? installSkillFromSource;
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
  const pluginEntries = pluginArtifactEntries(plan);
  const skillEntries = skillArtifactEntries(plan);
  const sourcePath = options.sourcePath ?? plan.claw.sourcePath;
  let currentRecords = await loadRecords();
  let enabledPluginIds = await readEnabledPluginIds();
  const directArtifactKeys = new Set<string>();
  const createdArtifactKeys = new Set<string>();
  const installedArtifactKeys = new Set<string>();
  const installedEntries = new Map<string, ClawApplyPlanEntry>();
  const satisfiedArtifactKeys = new Set<string>();
  const partialResult = () => ({
    directArtifactKeys,
    createdArtifactKeys,
    installedArtifactKeys,
  });

  if (skillEntries.length > 0) {
    const unsupportedSkillDiagnostics = skillEntries
      .filter((entry) => entry.required !== false)
      .map(unsupportedSkillEntry)
      .filter((diagnostic): diagnostic is ClawDiagnostic => Boolean(diagnostic));
    if (unsupportedSkillDiagnostics.length > 0) {
      throw new ClawArtifactApplyError(unsupportedSkillDiagnostics, partialResult());
    }
    const { config, workspaceDir } = (deps.resolveSkillsWorkspaceDir ?? resolveSkillsWorkspaceDir)();
    for (const entry of skillEntries) {
      const artifactKey = artifactKeyFor(entry, sourcePath);
      if (satisfiedArtifactKeys.has(artifactKey)) {
        continue;
      }
      if (unsupportedSkillEntry(entry)) {
        continue;
      }
      if (await hasMatchingSkillInstall(entry, workspaceDir, deps, sourcePath)) {
        installedArtifactKeys.add(artifactKey);
        satisfiedArtifactKeys.add(artifactKey);
        continue;
      }
      const selector = resolveLocalSelector(
        entry.artifact?.selector ?? entry.target ?? entry.id,
        sourcePath,
      );
      const clawHubTarget = parseClawHubSkillSelector({
        ...entry,
        artifact: entry.artifact ? { ...entry.artifact, selector } : entry.artifact,
      });
      let result:
        | Awaited<ReturnType<typeof installSkillFromClawHub>>
        | Awaited<ReturnType<typeof installSkillFromSource>>;
      if (entry.artifact?.source === "clawhub") {
        if (!clawHubTarget) {
          throw new ClawArtifactApplyError(
            [invalidClawHubSkillSelectorDiagnostic(entry)],
            partialResult(),
          );
        }
        result = await installSkillHub({
          workspaceDir,
          slug: clawHubTarget.installRef,
          ...(clawHubTarget.version ? { version: clawHubTarget.version } : {}),
          acknowledgeClawHubRisk: true,
          logger: {
            info: (message) => {
              if (!options.quiet) {
                runtime.log(message);
              }
            },
            warn: (message) => {
              if (!options.quiet) {
                runtime.log(message);
              }
            },
          },
          config,
        });
      } else if (isSkillSourceInstallSpec(selector)) {
        result = await installSkillSource({
          workspaceDir,
          spec: selector,
          slug: entry.id,
          logger: {
            info: (message) => {
              if (!options.quiet) {
                runtime.log(message);
              }
            },
            warn: (message) => {
              if (!options.quiet) {
                runtime.log(message);
              }
            },
          },
          config,
        });
      } else {
        throw new ClawArtifactApplyError(
          [unsupportedSkillEntry(entry)].filter(Boolean) as ClawDiagnostic[],
          partialResult(),
        );
      }
      if (!result.ok) {
        throw new ClawArtifactApplyError(
          [
            {
              level: "error",
              code: "skill_artifact_install_failed",
              path: `$.entries[${plan.entries.indexOf(entry)}]`,
              message: result.error,
            },
          ],
          partialResult(),
        );
      }
      installedArtifactKeys.add(artifactKey);
      createdArtifactKeys.add(artifactKey);
      satisfiedArtifactKeys.add(artifactKey);
    }
  }

  for (const entry of pluginEntries) {
    const artifactKey = artifactKeyFor(entry, sourcePath);
    if (satisfiedArtifactKeys.has(artifactKey)) {
      continue;
    }
    if (hasMatchingPluginInstallRecord(entry, currentRecords, sourcePath, enabledPluginIds)) {
      installedArtifactKeys.add(artifactKey);
      satisfiedArtifactKeys.add(artifactKey);
      continue;
    }

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
