// Builds read-only Claw update/reconcile plans from persisted Claw state.
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { root as fsSafeRoot, FsSafeError } from "../infra/fs-safe.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { readClawStatus, type ClawStatusRecord } from "./lifecycle-state.js";
import { artifactKeyFor, type PersistedClawArtifactRef } from "./provenance.js";
import {
  CLAW_UPDATE_PLAN_SCHEMA_VERSION,
  type ClawApplyPlan,
  type ClawApplyPlanEntry,
  type ClawDiagnostic,
  type ClawUpdatePlan,
  type ClawUpdatePlanEntry,
  type PersistedClawWorkspaceFileRef,
} from "./types.js";
import { MAX_CLAW_WORKSPACE_FILE_BYTES } from "./workspace.js";

function sha256(content: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function diagnostic(code: string, message: string, path = "$"): ClawDiagnostic {
  return { level: "error", code, path, message };
}

function summary(entries: ClawUpdatePlanEntry[]): ClawUpdatePlan["summary"] {
  return {
    totalEntries: entries.length,
    added: entries.filter((entry) => entry.action === "add").length,
    changed: entries.filter((entry) => entry.action === "change").length,
    removed: entries.filter((entry) => entry.action === "remove").length,
    unchanged: entries.filter((entry) => entry.action === "unchanged").length,
    manual: entries.filter((entry) => entry.action === "manual").length,
    blocked: entries.filter((entry) => entry.blocked).length,
    skippedUnsupported: entries.filter((entry) => entry.action === "skipUnsupported").length,
  };
}

function emptyPlan(params: {
  clawId: string;
  targetPlan?: ClawApplyPlan;
  found: boolean;
  diagnostics: ClawDiagnostic[];
}): ClawUpdatePlan {
  return {
    schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
    dryRun: true,
    mutationAllowed: false,
    claw: {
      id: params.clawId,
      ...(params.targetPlan ? { targetVersion: params.targetPlan.claw.version } : {}),
      ...(params.targetPlan?.claw.sourcePath
        ? { targetSourcePath: params.targetPlan.claw.sourcePath }
        : {}),
    },
    found: params.found,
    summary: summary([]),
    entries: [],
    diagnostics: params.diagnostics,
  };
}

export async function canonicalWorkspaceRoot(workspaceRoot?: string): Promise<string | undefined> {
  if (!workspaceRoot) {
    return undefined;
  }
  const requested = resolve(workspaceRoot);
  try {
    const workspace = await fsSafeRoot(requested, {
      hardlinks: "reject",
      maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
      symlinks: "reject",
    });
    return workspace.rootReal;
  } catch {
    return requested;
  }
}

function artifactUpdateEntry(params: {
  target: ClawApplyPlanEntry;
  current?: PersistedClawArtifactRef;
  desiredArtifactKey: string;
}): ClawUpdatePlanEntry {
  const { target, current, desiredArtifactKey } = params;
  if (!current) {
    return {
      id: target.id,
      kind: target.kind,
      required: target.required,
      phase: "artifact",
      action: "add",
      ...(target.target ? { target: target.target } : {}),
      desired: {
        artifactKey: desiredArtifactKey,
        selector: target.artifact?.selector,
        version: target.artifact?.version,
      },
      blocked: false,
      reason: "Target Claw adds a supported package-like artifact entry.",
    };
  }
  const action = current.artifactKey === desiredArtifactKey ? "unchanged" : "change";
  return {
    id: target.id,
    kind: target.kind,
    required: target.required,
    phase: "artifact",
    action,
    ...(target.target ? { target: target.target } : {}),
    current: {
      artifactKey: current.artifactKey,
      selector: current.selector,
      version: current.version,
    },
    desired: {
      artifactKey: desiredArtifactKey,
      selector: target.artifact?.selector,
      version: target.artifact?.version,
    },
    blocked: false,
    reason:
      action === "unchanged"
        ? "Persisted artifact ref already matches the target Claw entry."
        : "Target Claw changes this package-like artifact entry.",
  };
}

function removedArtifactEntry(ref: PersistedClawArtifactRef): ClawUpdatePlanEntry {
  return {
    id: ref.entryId,
    kind: ref.kind,
    required: false,
    phase: "artifact",
    action: "remove",
    current: {
      artifactKey: ref.artifactKey,
      selector: ref.selector,
      version: ref.version,
    },
    blocked: false,
    reason:
      "Target Claw no longer contains this artifact entry; update apply would release the Claw ref without silently uninstalling the artifact.",
  };
}

async function readSourceHash(sourcePath: string, entry: ClawApplyPlanEntry): Promise<string> {
  if (!entry.source) {
    throw new Error("Workspace entry is missing a source path.");
  }
  const sourceRoot = await fsSafeRoot(dirname(sourcePath), {
    hardlinks: "reject",
    maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  const content = await sourceRoot.readBytes(entry.source, {
    maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
  });
  return sha256(Buffer.isBuffer(content) ? content : Buffer.from(content));
}

async function readLocalWorkspaceHash(
  workspaceRoot: string,
  target: string,
): Promise<{
  state: "missing" | "present" | "unknown";
  hash?: string;
  targetPath?: string;
}> {
  try {
    const workspace = await fsSafeRoot(workspaceRoot, {
      hardlinks: "reject",
      maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
      symlinks: "reject",
    });
    const targetPath = await workspace.resolve(target);
    if (!(await workspace.exists(target))) {
      return { state: "missing", targetPath };
    }
    const content = await workspace.readBytes(target, { maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES });
    return {
      state: "present",
      hash: sha256(Buffer.isBuffer(content) ? content : Buffer.from(content)),
      targetPath,
    };
  } catch (error) {
    if (error instanceof FsSafeError) {
      return { state: "unknown" };
    }
    throw error;
  }
}

function localState(params: {
  current?: PersistedClawWorkspaceFileRef;
  desiredHash: string;
  local: { state: "missing" | "present" | "unknown"; hash?: string };
}): NonNullable<ClawUpdatePlanEntry["local"]> {
  const { current, desiredHash, local } = params;
  if (local.state === "missing") {
    return { state: "missing" };
  }
  if (local.state === "unknown" || !local.hash) {
    return { state: "unknown" };
  }
  if (current && local.hash === current.contentSha256) {
    return { state: "matchesCurrent", contentSha256: local.hash };
  }
  if (local.hash === desiredHash) {
    return { state: "matchesDesired", contentSha256: local.hash };
  }
  return { state: "modified", contentSha256: local.hash };
}

async function workspaceUpdateEntry(params: {
  target: ClawApplyPlanEntry;
  sourcePath: string;
  workspaceRoot?: string;
  current?: PersistedClawWorkspaceFileRef;
}): Promise<ClawUpdatePlanEntry> {
  const { target, sourcePath, current } = params;
  try {
    const desiredHash = await readSourceHash(sourcePath, target);
    const workspaceRoot = params.workspaceRoot ?? current?.workspaceRoot ?? process.cwd();
    const local = target.target
      ? await readLocalWorkspaceHash(workspaceRoot, target.target)
      : { state: "unknown" as const };
    const state = localState({ current, desiredHash, local });
    const currentDetails = current
      ? {
          contentSha256: current.contentSha256,
          targetPath: current.targetPath,
        }
      : undefined;
    const desiredDetails = {
      contentSha256: desiredHash,
      ...(local.targetPath ? { targetPath: local.targetPath } : {}),
    };
    if (state.state === "modified" || state.state === "unknown") {
      return {
        id: target.id,
        kind: target.kind,
        required: target.required,
        phase: "workspace",
        action: "manual",
        ...(target.target ? { target: target.target } : {}),
        ...(target.source ? { source: target.source } : {}),
        ...(currentDetails ? { current: currentDetails } : {}),
        desired: desiredDetails,
        local: state,
        blocked: false,
        reason:
          "Local workspace content cannot be updated automatically because it differs from the recorded managed hash or could not be verified.",
      };
    }
    if (!current) {
      return {
        id: target.id,
        kind: target.kind,
        required: target.required,
        phase: "workspace",
        action: "add",
        ...(target.target ? { target: target.target } : {}),
        ...(target.source ? { source: target.source } : {}),
        desired: desiredDetails,
        local: state,
        blocked: false,
        reason: "Target Claw adds a managed workspace or persona file.",
      };
    }
    const targetPathChanged = Boolean(
      current.targetPath &&
      desiredDetails.targetPath &&
      current.targetPath !== desiredDetails.targetPath,
    );
    const action =
      current.contentSha256 === desiredHash && state.state !== "missing" && !targetPathChanged
        ? "unchanged"
        : "change";
    return {
      id: target.id,
      kind: target.kind,
      required: target.required,
      phase: "workspace",
      action,
      ...(target.target ? { target: target.target } : {}),
      ...(target.source ? { source: target.source } : {}),
      current: currentDetails,
      desired: desiredDetails,
      local: state,
      blocked: false,
      reason:
        action === "unchanged"
          ? "Persisted workspace ref and local content already match the target Claw entry."
          : "Target Claw changes, moves, or restores this managed workspace or persona file.",
    };
  } catch (error) {
    return {
      id: target.id,
      kind: target.kind,
      required: target.required,
      phase: "workspace",
      action: target.required ? "blocked" : "manual",
      ...(target.target ? { target: target.target } : {}),
      ...(target.source ? { source: target.source } : {}),
      blocked: target.required,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function removedWorkspaceEntry(
  ref: PersistedClawWorkspaceFileRef,
): Promise<ClawUpdatePlanEntry> {
  const localTarget = isAbsolute(ref.targetPath)
    ? relative(ref.workspaceRoot, ref.targetPath)
    : ref.targetPath;
  const local = await readLocalWorkspaceHash(ref.workspaceRoot, localTarget);
  const localDetails = localState({ current: ref, desiredHash: ref.contentSha256, local });
  const autoRemove = localDetails.state === "matchesCurrent" || localDetails.state === "missing";
  return {
    id: ref.entryId,
    kind: ref.kind,
    required: false,
    phase: "workspace",
    action: autoRemove ? "remove" : "manual",
    target: ref.targetPath,
    current: {
      contentSha256: ref.contentSha256,
      targetPath: ref.targetPath,
    },
    local: localDetails,
    blocked: false,
    reason: autoRemove
      ? "Target Claw no longer contains this managed workspace entry; update apply can release the ref and remove unchanged managed content."
      : "Target Claw no longer contains this managed workspace entry, but local edits must be preserved manually.",
  };
}

function unsupportedEntry(target: ClawApplyPlanEntry): ClawUpdatePlanEntry {
  const required = target.required;
  return {
    id: target.id,
    kind: target.kind,
    required,
    phase: "unsupported",
    action: required ? "blocked" : "skipUnsupported",
    ...(target.target ? { target: target.target } : {}),
    ...(target.source ? { source: target.source } : {}),
    blocked: required,
    reason: required
      ? "Target Claw contains a required unsupported entry that blocks update apply."
      : "Target Claw contains an optional unsupported entry that update apply would skip.",
  };
}

export async function buildClawUpdatePlan(params: {
  clawId: string;
  targetPlan: ClawApplyPlan;
  targetSourcePath?: string;
  workspaceRoot?: string;
  stateOptions?: OpenClawStateDatabaseOptions;
}): Promise<ClawUpdatePlan> {
  const status = readClawStatus(params.clawId, params.stateOptions);
  const record: ClawStatusRecord | undefined = status.records.find(
    (item) => item.clawId === params.clawId,
  );
  if (!record) {
    return emptyPlan({
      clawId: params.clawId,
      targetPlan: params.targetPlan,
      found: false,
      diagnostics: [
        diagnostic(
          "claw_not_found",
          `No persisted Claw state found for ${JSON.stringify(params.clawId)}.`,
        ),
      ],
    });
  }
  if (params.targetPlan.claw.id !== params.clawId) {
    return {
      ...emptyPlan({
        clawId: params.clawId,
        targetPlan: params.targetPlan,
        found: true,
        diagnostics: [
          diagnostic(
            "target_claw_mismatch",
            `Target Claw id ${JSON.stringify(params.targetPlan.claw.id)} does not match applied Claw ${JSON.stringify(params.clawId)}.`,
          ),
        ],
      }),
      claw: {
        id: params.clawId,
        currentVersion: record.clawVersion,
        targetVersion: params.targetPlan.claw.version,
        currentSourcePath: record.sourcePath,
        targetSourcePath: params.targetSourcePath ?? params.targetPlan.claw.sourcePath,
      },
    };
  }

  const sourcePath = params.targetSourcePath ?? params.targetPlan.claw.sourcePath;
  const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
  const workspaceRefs = workspaceRoot
    ? record.workspaceFiles.filter((ref) => ref.workspaceRoot === workspaceRoot)
    : record.workspaceFiles;
  const currentArtifacts = new Map(record.artifacts.map((ref) => [ref.entryId, ref] as const));
  const workspaceRefsByEntryId = new Map<string, PersistedClawWorkspaceFileRef[]>();
  for (const ref of workspaceRefs) {
    const refs = workspaceRefsByEntryId.get(ref.entryId) ?? [];
    refs.push(ref);
    workspaceRefsByEntryId.set(ref.entryId, refs);
  }
  const targetArtifactEntryIds = new Set(
    params.targetPlan.entries
      .filter((entry) => !entry.blocked && entry.phase === "artifact")
      .map((entry) => entry.id),
  );
  const targetWorkspaceEntryIds = new Set(
    params.targetPlan.entries
      .filter((entry) => !entry.blocked && entry.phase === "workspace")
      .map((entry) => entry.id),
  );
  const entries: ClawUpdatePlanEntry[] = [];

  for (const entry of params.targetPlan.entries) {
    if (entry.phase === "unsupported" || entry.blocked || entry.action === "skipUnsupported") {
      entries.push(unsupportedEntry(entry));
      continue;
    }
    if (entry.phase === "artifact") {
      entries.push(
        artifactUpdateEntry({
          target: entry,
          current: currentArtifacts.get(entry.id),
          desiredArtifactKey: artifactKeyFor(entry, sourcePath),
        }),
      );
      continue;
    }
    if (entry.phase === "workspace") {
      if (!sourcePath) {
        entries.push({
          id: entry.id,
          kind: entry.kind,
          required: entry.required,
          phase: "workspace",
          action: entry.required ? "blocked" : "manual",
          blocked: entry.required,
          reason: "Update planning requires the target Claw source path for workspace entries.",
        });
        continue;
      }
      const currentRefs = workspaceRefsByEntryId.get(entry.id) ?? [];
      if (currentRefs.length === 0) {
        const roots: Array<string | undefined> = workspaceRoot
          ? [workspaceRoot]
          : [...new Set(workspaceRefs.map((ref) => ref.workspaceRoot))];
        for (const root of roots.length > 0 ? roots : [undefined]) {
          entries.push(
            await workspaceUpdateEntry({
              target: entry,
              sourcePath,
              workspaceRoot: root,
            }),
          );
        }
        continue;
      }
      for (const current of currentRefs) {
        entries.push(
          await workspaceUpdateEntry({
            target: entry,
            sourcePath,
            workspaceRoot: workspaceRoot ?? current.workspaceRoot,
            current,
          }),
        );
      }
      continue;
    }
    entries.push(unsupportedEntry(entry));
  }

  for (const ref of record.artifacts) {
    if (!targetArtifactEntryIds.has(ref.entryId)) {
      entries.push(removedArtifactEntry(ref));
    }
  }
  for (const ref of workspaceRefs) {
    if (!targetWorkspaceEntryIds.has(ref.entryId)) {
      entries.push(await removedWorkspaceEntry(ref));
    }
  }

  return {
    schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
    dryRun: true,
    mutationAllowed: false,
    claw: {
      id: params.clawId,
      currentVersion: record.clawVersion,
      targetVersion: params.targetPlan.claw.version,
      currentSourcePath: record.sourcePath,
      targetSourcePath: sourcePath,
    },
    found: true,
    summary: summary(entries),
    entries,
    diagnostics: params.targetPlan.diagnostics,
  };
}
