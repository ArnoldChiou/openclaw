// Applies Claw workspace-owned files with bounded, root-confined file IO.
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { root as fsSafeRoot, FsSafeError } from "../infra/fs-safe.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type {
  ClawApplyPlan,
  ClawApplyPlanEntry,
  ClawDiagnostic,
  PersistedClawWorkspaceFileRef,
} from "./types.js";

const CLAW_WORKSPACE_FILE_REF_SCHEMA_VERSION = "openclaw.clawWorkspaceFileRef.v1" as const;
const MAX_CLAW_WORKSPACE_FILE_BYTES = 1024 * 1024;

type ExistingWorkspaceFileRefRow = {
  claw_id: string;
  entry_id: string;
  target_path: string;
  workspace_root: string;
  content_sha256: string;
  applied_at_ms: number;
};

type PreparedWorkspaceFile = {
  entry: ClawApplyPlanEntry;
  entryIndex: number;
  targetPath: string;
  sourcePath: string;
  content: Buffer;
  contentSha256: string;
  operation: PersistedClawWorkspaceFileRef["operation"];
  existingRef?: ExistingWorkspaceFileRefRow;
};

export class ClawWorkspaceApplyError extends Error {
  readonly diagnostics: ClawDiagnostic[];

  constructor(diagnostics: ClawDiagnostic[]) {
    super("Claw workspace file apply failed");
    this.name = "ClawWorkspaceApplyError";
    this.diagnostics = diagnostics;
  }
}

function workspaceEntries(plan: ClawApplyPlan): ClawApplyPlanEntry[] {
  return plan.entries.filter(
    (entry) =>
      !entry.blocked &&
      entry.phase === "workspace" &&
      (entry.action === "writeWorkspaceFile" || entry.action === "writePersonaFile"),
  );
}

function diagnostic(
  _entry: ClawApplyPlanEntry,
  code: string,
  message: string,
  entryIndex: number,
): ClawDiagnostic {
  return { level: "error", code, path: `$.entries[${entryIndex}]`, message };
}

function contentSha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function asBuffer(value: Buffer | Uint8Array | string): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

async function prepareWorkspaceFile(params: {
  entry: ClawApplyPlanEntry;
  entryIndex: number;
  manifestRoot: string;
  workspaceRoot: string;
  clawId: string;
  existingRef?: ExistingWorkspaceFileRefRow;
  targetRefs: ExistingWorkspaceFileRefRow[];
}): Promise<PreparedWorkspaceFile | ClawDiagnostic> {
  const { entry, entryIndex, manifestRoot, workspaceRoot, clawId, existingRef, targetRefs } =
    params;
  if (!entry.source) {
    return diagnostic(
      entry,
      "missing_workspace_source",
      "Workspace file entry is missing a source path.",
      entryIndex,
    );
  }
  if (!entry.target) {
    return diagnostic(
      entry,
      "missing_workspace_target",
      "Workspace file entry is missing a target path.",
      entryIndex,
    );
  }

  try {
    const manifestFiles = await fsSafeRoot(manifestRoot, {
      hardlinks: "reject",
      maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
      symlinks: "reject",
    });
    const content = asBuffer(
      await manifestFiles.readBytes(entry.source, { maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES }),
    );
    const sourcePath = await manifestFiles.resolve(entry.source);
    const workspace = await fsSafeRoot(workspaceRoot, {
      hardlinks: "reject",
      maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
      symlinks: "reject",
    });
    const targetPath = await workspace.resolve(entry.target);
    const sameClawTargetRef = targetRefs.find(
      (ref) => ref.target_path === targetPath && ref.claw_id === clawId,
    );
    const managedRef = existingRef ?? sameClawTargetRef;
    const otherOwner = targetRefs.find(
      (ref) => ref.target_path === targetPath && ref.claw_id !== clawId,
    );
    if (otherOwner) {
      return diagnostic(
        entry,
        "workspace_file_owned_by_other_claw",
        `Workspace target ${JSON.stringify(entry.target)} is already managed by Claw ${JSON.stringify(otherOwner.claw_id)}.`,
        entryIndex,
      );
    }
    let operation: PersistedClawWorkspaceFileRef["operation"] = "created";
    if (await workspace.exists(entry.target)) {
      const existing = asBuffer(
        await workspace.readBytes(entry.target, { maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES }),
      );
      if (!existing.equals(content)) {
        const existingHash = contentSha256(existing);
        const managedPreviousContent =
          managedRef?.workspace_root === workspaceRoot &&
          managedRef.target_path === targetPath &&
          managedRef.content_sha256 === existingHash;
        if (!managedPreviousContent) {
          return diagnostic(
            entry,
            "workspace_file_conflict",
            `Workspace target ${JSON.stringify(entry.target)} already exists with different content.`,
            entryIndex,
          );
        }
        operation = "updated";
      } else {
        operation = "unchanged";
      }
    }
    return {
      entry,
      entryIndex,
      targetPath,
      sourcePath,
      content,
      contentSha256: contentSha256(content),
      operation,
      ...(managedRef ? { existingRef: managedRef } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof FsSafeError ? `workspace_file_${error.code}` : "workspace_file_io_error";
    return diagnostic(entry, code, message, entryIndex);
  }
}

async function prepareWorkspaceFiles(params: {
  plan: ClawApplyPlan;
  manifestRoot: string;
  workspaceRoot: string;
  existingRefs: Map<string, ExistingWorkspaceFileRefRow>;
  targetRefs: ExistingWorkspaceFileRefRow[];
}): Promise<PreparedWorkspaceFile[]> {
  const prepared: PreparedWorkspaceFile[] = [];
  const diagnostics: ClawDiagnostic[] = [];
  for (const entry of workspaceEntries(params.plan)) {
    const entryIndex = params.plan.entries.indexOf(entry);
    const result = await prepareWorkspaceFile({
      entry,
      entryIndex,
      manifestRoot: params.manifestRoot,
      workspaceRoot: params.workspaceRoot,
      clawId: params.plan.claw.id,
      existingRef: params.existingRefs.get(entry.id),
      targetRefs: params.targetRefs,
    });
    if ("level" in result) {
      diagnostics.push(result);
    } else {
      prepared.push(result);
    }
  }
  const targetsByPath = new Map<string, PreparedWorkspaceFile>();
  for (const item of prepared) {
    const existing = targetsByPath.get(item.targetPath);
    if (existing) {
      diagnostics.push(
        diagnostic(
          item.entry,
          "duplicate_workspace_target",
          `Workspace target ${JSON.stringify(item.entry.target)} duplicates entry ${JSON.stringify(existing.entry.id)}.`,
          item.entryIndex,
        ),
      );
      continue;
    }
    targetsByPath.set(item.targetPath, item);
  }
  if (diagnostics.length > 0) {
    throw new ClawWorkspaceApplyError(diagnostics);
  }
  return prepared;
}

function toPersistedRef(params: {
  plan: ClawApplyPlan;
  prepared: PreparedWorkspaceFile;
  workspaceRoot: string;
  existingRef?: ExistingWorkspaceFileRefRow;
  nowMs: number;
}): PersistedClawWorkspaceFileRef {
  const { plan, prepared, workspaceRoot, existingRef, nowMs } = params;
  return {
    schemaVersion: CLAW_WORKSPACE_FILE_REF_SCHEMA_VERSION,
    clawId: plan.claw.id,
    clawVersion: plan.claw.version,
    entryId: prepared.entry.id,
    kind: prepared.entry.kind,
    targetPath: prepared.targetPath,
    workspaceRoot,
    sourcePath: prepared.sourcePath,
    contentSha256: prepared.contentSha256,
    operation: prepared.operation,
    ...(prepared.entry.provenanceRecord === "workspaceFile.installRecord"
      ? { provenanceRecord: prepared.entry.provenanceRecord }
      : {}),
    appliedAtMs: (existingRef ?? prepared.existingRef)?.applied_at_ms ?? nowMs,
    updatedAtMs: nowMs,
  };
}

function readWorkspaceRefsForRoot(
  workspaceRoot: string,
  options: OpenClawStateDatabaseOptions,
): ExistingWorkspaceFileRefRow[] {
  const database = openOpenClawStateDatabase(options);
  return database.db
    .prepare(
      `SELECT claw_id, entry_id, target_path, workspace_root, content_sha256, applied_at_ms
         FROM claw_workspace_file_refs
        WHERE workspace_root = ?`,
    )
    .all(workspaceRoot) as ExistingWorkspaceFileRefRow[];
}

function deleteStaleWorkspaceRefs(
  db: DatabaseSync,
  clawId: string,
  workspaceRoot: string,
  currentEntryIds: string[],
): void {
  if (currentEntryIds.length === 0) {
    db.prepare(`DELETE FROM claw_workspace_file_refs WHERE claw_id = ? AND workspace_root = ?`).run(
      clawId,
      workspaceRoot,
    );
    return;
  }
  const placeholders = currentEntryIds.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM claw_workspace_file_refs
      WHERE claw_id = ?
        AND workspace_root = ?
        AND entry_id NOT IN (${placeholders})`,
  ).run(clawId, workspaceRoot, ...currentEntryIds);
}

function workspaceRootFsSafeOptions() {
  return { hardlinks: "reject" as const, symlinks: "reject" as const };
}

function workspaceDiagnosticFromError(
  entry: ClawApplyPlanEntry,
  entryIndex: number,
  error: unknown,
): ClawDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof FsSafeError ? `workspace_file_${error.code}` : "workspace_file_io_error";
  return diagnostic(entry, code, message, entryIndex);
}

async function canonicalWorkspaceRootForNoopApply(workspaceRoot: string): Promise<string> {
  try {
    const workspace = await fsSafeRoot(workspaceRoot, workspaceRootFsSafeOptions());
    return workspace.rootReal;
  } catch {
    return workspaceRoot;
  }
}

function persistSuccessfulWorkspaceRefs(
  refs: PersistedClawWorkspaceFileRef[],
  options: OpenClawStateDatabaseOptions,
): void {
  if (refs.length === 0) {
    return;
  }
  runOpenClawStateWriteTransaction(({ db }) => {
    for (const ref of refs) {
      upsertWorkspaceRef(db, ref);
    }
  }, options);
}

function upsertWorkspaceRef(db: DatabaseSync, ref: PersistedClawWorkspaceFileRef): void {
  db.prepare(
    `INSERT INTO claw_workspace_file_refs (
       claw_id, entry_id, schema_version, claw_version, kind, target_path,
       workspace_root, source_path, content_sha256, operation, provenance_record,
       applied_at_ms, updated_at_ms
     ) VALUES (
       @claw_id, @entry_id, @schema_version, @claw_version, @kind, @target_path,
       @workspace_root, @source_path, @content_sha256, @operation, @provenance_record,
       @applied_at_ms, @updated_at_ms
     )
     ON CONFLICT(claw_id, workspace_root, entry_id) DO UPDATE SET
       schema_version = excluded.schema_version,
       claw_version = excluded.claw_version,
       kind = excluded.kind,
       target_path = excluded.target_path,
       workspace_root = excluded.workspace_root,
       source_path = excluded.source_path,
       content_sha256 = excluded.content_sha256,
       operation = excluded.operation,
       provenance_record = excluded.provenance_record,
       updated_at_ms = excluded.updated_at_ms`,
  ).run({
    claw_id: ref.clawId,
    entry_id: ref.entryId,
    schema_version: ref.schemaVersion,
    claw_version: ref.clawVersion,
    kind: ref.kind,
    target_path: ref.targetPath,
    workspace_root: ref.workspaceRoot,
    source_path: ref.sourcePath,
    content_sha256: ref.contentSha256,
    operation: ref.operation,
    provenance_record: ref.provenanceRecord ?? null,
    applied_at_ms: ref.appliedAtMs,
    updated_at_ms: ref.updatedAtMs,
  });
}

export async function applyClawWorkspaceFiles(
  plan: ClawApplyPlan,
  options: OpenClawStateDatabaseOptions & {
    sourcePath?: string;
    workspaceRoot?: string;
    nowMs?: number;
  } = {},
): Promise<PersistedClawWorkspaceFileRef[]> {
  const entries = workspaceEntries(plan);
  const requestedWorkspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  if (entries.length === 0) {
    const workspaceRoot = await canonicalWorkspaceRootForNoopApply(requestedWorkspaceRoot);
    runOpenClawStateWriteTransaction(({ db }) => {
      deleteStaleWorkspaceRefs(db, plan.claw.id, workspaceRoot, []);
    }, options);
    return [];
  }
  let workspace: Awaited<ReturnType<typeof fsSafeRoot>>;
  try {
    workspace = await fsSafeRoot(requestedWorkspaceRoot, workspaceRootFsSafeOptions());
  } catch (error) {
    throw new ClawWorkspaceApplyError(
      entries.map((entry) =>
        workspaceDiagnosticFromError(entry, plan.entries.indexOf(entry), error),
      ),
    );
  }
  const workspaceRoot = workspace.rootReal;
  const sourcePath = options.sourcePath ?? plan.claw.sourcePath;
  const manifestRoot = sourcePath ? dirname(sourcePath) : process.cwd();
  const nowMs = options.nowMs ?? Date.now();
  const targetRefs = readWorkspaceRefsForRoot(workspaceRoot, options);
  const existingRefs = new Map(
    targetRefs
      .filter((row) => row.claw_id === plan.claw.id)
      .map((row) => [row.entry_id, row] as const),
  );
  const prepared = await prepareWorkspaceFiles({
    plan,
    manifestRoot,
    workspaceRoot,
    existingRefs,
    targetRefs,
  });
  const refs = prepared.map((item) =>
    toPersistedRef({
      plan,
      prepared: item,
      workspaceRoot,
      existingRef: existingRefs.get(item.entry.id),
      nowMs,
    }),
  );
  const refsByEntryId = new Map(refs.map((ref) => [ref.entryId, ref] as const));
  const appliedRefs: PersistedClawWorkspaceFileRef[] = [];
  for (const item of prepared) {
    if (item.operation !== "unchanged") {
      try {
        await workspace.write(item.entry.target ?? item.entry.id, item.content, {
          mkdir: true,
          overwrite: item.operation === "updated",
        });
      } catch (error) {
        persistSuccessfulWorkspaceRefs(appliedRefs, options);
        const message = error instanceof Error ? error.message : String(error);
        const code =
          error instanceof FsSafeError ? `workspace_file_${error.code}` : "workspace_file_io_error";
        throw new ClawWorkspaceApplyError([diagnostic(item.entry, code, message, item.entryIndex)]);
      }
    }
    const ref = refsByEntryId.get(item.entry.id);
    if (ref && item.operation !== "unchanged") {
      appliedRefs.push(ref);
    }
  }

  runOpenClawStateWriteTransaction(({ db }) => {
    deleteStaleWorkspaceRefs(
      db,
      plan.claw.id,
      workspaceRoot,
      entries.map((entry) => entry.id),
    );
    for (const ref of refs) {
      upsertWorkspaceRef(db, ref);
    }
  }, options);
  return refs;
}
