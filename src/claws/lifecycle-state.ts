// Reads and removes persisted Claw lifecycle state.
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { root as fsSafeRoot, FsSafeError } from "../infra/fs-safe.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { PersistedClawArtifactRef } from "./provenance.js";
import type { PersistedClawWorkspaceFileRef } from "./types.js";

const CLAW_STATUS_SCHEMA_VERSION = "openclaw.clawStatus.v1" as const;
const CLAW_REMOVE_RESULT_SCHEMA_VERSION = "openclaw.clawRemoveResult.v1" as const;
const MAX_REMOVE_WORKSPACE_FILE_BYTES = 1024 * 1024;

type ApplyRecordRow = {
  claw_id: string;
  schema_version: string;
  claw_version: string;
  source_path: string | null;
  feed_json: string | null;
  applied_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

type ArtifactRefRow = {
  claw_id: string;
  claw_version: string;
  entry_id: string;
  kind: string;
  artifact_key: string;
  selector: string;
  install_surface: string;
  source: string;
  package_name: string | null;
  version: string | null;
  provenance_record: string | null;
  ownership_json: string;
  applied_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

type WorkspaceRefRow = {
  claw_id: string;
  claw_version: string;
  entry_id: string;
  kind: string;
  target_path: string;
  workspace_root: string;
  source_path: string;
  content_sha256: string;
  operation: "created" | "updated" | "unchanged";
  provenance_record: string | null;
  applied_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

type ExistingArtifactRefRow = { claw_id: string; entry_id: string };
type PlannedWorkspaceFile = RemovedWorkspaceFile & { expectedSha256?: string };

export type ClawStatusRecord = {
  clawId: string;
  clawVersion?: string;
  sourcePath?: string;
  feed?: unknown;
  appliedAtMs?: number;
  updatedAtMs?: number;
  artifacts: PersistedClawArtifactRef[];
  workspaceFiles: PersistedClawWorkspaceFileRef[];
};

export type ClawStatusResult = {
  schemaVersion: typeof CLAW_STATUS_SCHEMA_VERSION;
  records: ClawStatusRecord[];
  summary: {
    claws: number;
    artifactRefs: number;
    workspaceFileRefs: number;
  };
};

export type RemovedWorkspaceFile = {
  entryId: string;
  targetPath: string;
  workspaceRoot: string;
  action:
    | "deleted"
    | "missing"
    | "retainedModified"
    | "error"
    | "dryRunDelete"
    | "dryRunRetainModified";
  message?: string;
};

export type ClawRemoveResult = {
  schemaVersion: typeof CLAW_REMOVE_RESULT_SCHEMA_VERSION;
  dryRun: boolean;
  clawId: string;
  found: boolean;
  summary: {
    artifactRefsRemoved: number;
    workspaceFileRefsRemoved: number;
    workspaceFilesDeleted: number;
    workspaceFilesRetained: number;
    errors: number;
  };
  artifactRefs: PersistedClawArtifactRef[];
  workspaceFiles: RemovedWorkspaceFile[];
};

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok?: unknown } | undefined;
  return row?.ok === 1;
}

function rowToArtifactRef(row: ArtifactRefRow): PersistedClawArtifactRef {
  return {
    schemaVersion: "openclaw.clawArtifactRef.v1",
    clawId: row.claw_id,
    clawVersion: row.claw_version,
    entryId: row.entry_id,
    kind: row.kind,
    artifactKey: row.artifact_key,
    selector: row.selector,
    installSurface: row.install_surface,
    source: row.source,
    ...(row.package_name ? { packageName: row.package_name } : {}),
    ...(row.version ? { version: row.version } : {}),
    ...(row.provenance_record ? { provenanceRecord: row.provenance_record } : {}),
    ownership: JSON.parse(row.ownership_json) as PersistedClawArtifactRef["ownership"],
    appliedAtMs: Number(row.applied_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function rowToWorkspaceRef(row: WorkspaceRefRow): PersistedClawWorkspaceFileRef {
  return {
    schemaVersion: "openclaw.clawWorkspaceFileRef.v1",
    clawId: row.claw_id,
    clawVersion: row.claw_version,
    entryId: row.entry_id,
    kind: row.kind,
    targetPath: row.target_path,
    workspaceRoot: row.workspace_root,
    sourcePath: row.source_path,
    contentSha256: row.content_sha256,
    operation: row.operation,
    ...(row.provenance_record === "workspaceFile.installRecord"
      ? { provenanceRecord: row.provenance_record }
      : {}),
    appliedAtMs: Number(row.applied_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function readApplyRecords(db: DatabaseSync, clawId?: string): ApplyRecordRow[] {
  if (!tableExists(db, "claw_apply_records")) {
    return [];
  }
  const sql =
    "SELECT claw_id, schema_version, claw_version, source_path, feed_json, applied_at_ms, updated_at_ms FROM claw_apply_records";
  return (
    clawId
      ? db.prepare(`${sql} WHERE claw_id = ? ORDER BY claw_id`).all(clawId)
      : db.prepare(`${sql} ORDER BY claw_id`).all()
  ) as ApplyRecordRow[];
}

function readArtifactRefs(db: DatabaseSync, clawId?: string): PersistedClawArtifactRef[] {
  if (!tableExists(db, "claw_artifact_refs")) {
    return [];
  }
  const sql = `SELECT claw_id, claw_version, entry_id, kind, artifact_key, selector,
                     install_surface, source, package_name, version, provenance_record,
                     ownership_json, applied_at_ms, updated_at_ms
                FROM claw_artifact_refs`;
  const rows = (
    clawId
      ? db.prepare(`${sql} WHERE claw_id = ? ORDER BY entry_id`).all(clawId)
      : db.prepare(`${sql} ORDER BY claw_id, entry_id`).all()
  ) as ArtifactRefRow[];
  return rows.map(rowToArtifactRef);
}

function readWorkspaceRefs(db: DatabaseSync, clawId?: string): PersistedClawWorkspaceFileRef[] {
  if (!tableExists(db, "claw_workspace_file_refs")) {
    return [];
  }
  const sql = `SELECT claw_id, claw_version, entry_id, kind, target_path, workspace_root,
                     source_path, content_sha256, operation, provenance_record,
                     applied_at_ms, updated_at_ms
                FROM claw_workspace_file_refs`;
  const rows = (
    clawId
      ? db.prepare(`${sql} WHERE claw_id = ? ORDER BY workspace_root, entry_id`).all(clawId)
      : db.prepare(`${sql} ORDER BY claw_id, workspace_root, entry_id`).all()
  ) as WorkspaceRefRow[];
  return rows.map(rowToWorkspaceRef);
}

function parseFeedJson(value: string | null): unknown | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function buildStatusRecord(params: {
  clawId: string;
  applyRecord?: ApplyRecordRow;
  artifacts: PersistedClawArtifactRef[];
  workspaceFiles: PersistedClawWorkspaceFileRef[];
}): ClawStatusRecord {
  const { clawId, applyRecord, artifacts, workspaceFiles } = params;
  const clawVersion =
    applyRecord?.claw_version ?? artifacts[0]?.clawVersion ?? workspaceFiles[0]?.clawVersion;
  return {
    clawId,
    ...(clawVersion ? { clawVersion } : {}),
    ...(applyRecord?.source_path ? { sourcePath: applyRecord.source_path } : {}),
    ...(applyRecord?.feed_json ? { feed: parseFeedJson(applyRecord.feed_json) } : {}),
    ...(applyRecord ? { appliedAtMs: Number(applyRecord.applied_at_ms) } : {}),
    ...(applyRecord ? { updatedAtMs: Number(applyRecord.updated_at_ms) } : {}),
    artifacts,
    workspaceFiles,
  };
}

export function readClawStatus(
  clawId?: string,
  options: OpenClawStateDatabaseOptions = {},
): ClawStatusResult {
  const database = openOpenClawStateDatabase(options);
  const applyRecords = readApplyRecords(database.db, clawId);
  const artifacts = readArtifactRefs(database.db, clawId);
  const workspaceFiles = readWorkspaceRefs(database.db, clawId);
  const ids = new Set<string>([
    ...applyRecords.map((row) => row.claw_id),
    ...artifacts.map((ref) => ref.clawId),
    ...workspaceFiles.map((ref) => ref.clawId),
  ]);
  const records = [...ids].sort().map((id) =>
    buildStatusRecord({
      clawId: id,
      applyRecord: applyRecords.find((row) => row.claw_id === id),
      artifacts: artifacts.filter((ref) => ref.clawId === id),
      workspaceFiles: workspaceFiles.filter((ref) => ref.clawId === id),
    }),
  );
  return {
    schemaVersion: CLAW_STATUS_SCHEMA_VERSION,
    records,
    summary: {
      claws: records.length,
      artifactRefs: artifacts.length,
      workspaceFileRefs: workspaceFiles.length,
    },
  };
}

function sha256(content: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isTooLargeFsSafeError(error: unknown): boolean {
  return error instanceof FsSafeError && error.code === "too-large";
}

async function planWorkspaceFileRemoval(
  ref: PersistedClawWorkspaceFileRef,
  dryRun: boolean,
): Promise<PlannedWorkspaceFile> {
  const base = {
    entryId: ref.entryId,
    targetPath: ref.targetPath,
    workspaceRoot: ref.workspaceRoot,
  };
  try {
    const rootStat = await stat(ref.workspaceRoot);
    if (!rootStat.isDirectory()) {
      return { ...base, action: "missing" };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...base, action: "missing" };
    }
    throw error;
  }
  const workspace = await fsSafeRoot(ref.workspaceRoot, {
    hardlinks: "reject",
    maxBytes: MAX_REMOVE_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  const relativePath = relative(ref.workspaceRoot, ref.targetPath);
  if (!(await workspace.exists(relativePath))) {
    return { ...base, action: "missing" };
  }
  let content: Buffer | Uint8Array | string;
  try {
    content = await workspace.readBytes(relativePath, {
      maxBytes: MAX_REMOVE_WORKSPACE_FILE_BYTES,
    });
  } catch (error) {
    if (isTooLargeFsSafeError(error)) {
      return {
        ...base,
        action: dryRun ? "dryRunRetainModified" : "retainedModified",
        message: "Workspace file is larger than the Claw-managed file cap; leaving it in place.",
      };
    }
    throw error;
  }
  if (sha256(Buffer.isBuffer(content) ? content : Buffer.from(content)) !== ref.contentSha256) {
    return {
      ...base,
      action: dryRun ? "dryRunRetainModified" : "retainedModified",
      message:
        "Workspace file content no longer matches the Claw-managed hash; leaving it in place.",
    };
  }
  if (dryRun) {
    return { ...base, action: "dryRunDelete", expectedSha256: ref.contentSha256 };
  }
  await workspace.remove(relativePath);
  return { ...base, action: "deleted" };
}

function toRemovedWorkspaceFile(file: PlannedWorkspaceFile): RemovedWorkspaceFile {
  const { expectedSha256: _expectedSha256, ...result } = file;
  return result;
}

async function deletePlannedWorkspaceFile(
  planned: PlannedWorkspaceFile,
): Promise<RemovedWorkspaceFile> {
  if (planned.action !== "dryRunDelete") {
    return planned.action === "dryRunRetainModified"
      ? { ...planned, action: "retainedModified" }
      : planned;
  }
  try {
    const workspace = await fsSafeRoot(planned.workspaceRoot, {
      hardlinks: "reject",
      maxBytes: MAX_REMOVE_WORKSPACE_FILE_BYTES,
      symlinks: "reject",
    });
    const relativePath = relative(planned.workspaceRoot, planned.targetPath);
    if (!(await workspace.exists(relativePath))) {
      return toRemovedWorkspaceFile({ ...planned, action: "missing" });
    }
    let content: Buffer | Uint8Array | string;
    try {
      content = await workspace.readBytes(relativePath, {
        maxBytes: MAX_REMOVE_WORKSPACE_FILE_BYTES,
      });
    } catch (error) {
      if (isTooLargeFsSafeError(error)) {
        return toRemovedWorkspaceFile({
          ...planned,
          action: "retainedModified",
          message: "Workspace file is larger than the Claw-managed file cap; leaving it in place.",
        });
      }
      throw error;
    }
    if (
      planned.expectedSha256 &&
      sha256(Buffer.isBuffer(content) ? content : Buffer.from(content)) !== planned.expectedSha256
    ) {
      return toRemovedWorkspaceFile({
        ...planned,
        action: "retainedModified",
        message: "Workspace file content changed after remove preflight; leaving it in place.",
      });
    }
    await workspace.remove(relativePath);
    return toRemovedWorkspaceFile({ ...planned, action: "deleted" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...toRemovedWorkspaceFile(planned),
      action: "error",
      message: error instanceof FsSafeError ? `${error.code}: ${message}` : message,
    };
  }
}

async function preflightWorkspaceFiles(
  refs: PersistedClawWorkspaceFileRef[],
): Promise<PlannedWorkspaceFile[]> {
  const results: PlannedWorkspaceFile[] = [];
  for (const ref of refs) {
    try {
      results.push(await planWorkspaceFileRemoval(ref, true));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        entryId: ref.entryId,
        targetPath: ref.targetPath,
        workspaceRoot: ref.workspaceRoot,
        action: "error",
        message: error instanceof FsSafeError ? `${error.code}: ${message}` : message,
      });
    }
  }
  return results;
}

async function removeWorkspaceFiles(
  refs: PersistedClawWorkspaceFileRef[],
  dryRun: boolean,
): Promise<RemovedWorkspaceFile[]> {
  const planned = await preflightWorkspaceFiles(refs);
  if (dryRun || planned.some((file) => file.action === "error")) {
    return planned.map(toRemovedWorkspaceFile);
  }
  const results: RemovedWorkspaceFile[] = [];
  for (const file of planned) {
    results.push(await deletePlannedWorkspaceFile(file));
  }
  return results;
}

function existingArtifactRefs(db: DatabaseSync, artifactKey: string): ExistingArtifactRefRow[] {
  return db
    .prepare(
      `SELECT claw_id, entry_id
         FROM claw_artifact_refs
        WHERE artifact_key = ?
        ORDER BY claw_id, entry_id`,
    )
    .all(artifactKey) as ExistingArtifactRefRow[];
}

function updateArtifactOwnershipRefs(db: DatabaseSync, artifactKey: string, nowMs: number): void {
  const refs = existingArtifactRefs(db, artifactKey);
  if (refs.length === 0) {
    return;
  }
  let createdByThisApply = false;
  for (const row of refs) {
    const current = db
      .prepare(`SELECT ownership_json FROM claw_artifact_refs WHERE claw_id = ? AND entry_id = ?`)
      .get(row.claw_id, row.entry_id) as { ownership_json?: string } | undefined;
    try {
      createdByThisApply ||= Boolean(
        current?.ownership_json &&
        (JSON.parse(current.ownership_json) as PersistedClawArtifactRef["ownership"])
          .createdByThisApply,
      );
    } catch {
      // Ignore malformed ownership while rebuilding the remaining ref set.
    }
  }
  const clawRefs = [...new Set(refs.map((row) => row.claw_id))].sort();
  const ownership: PersistedClawArtifactRef["ownership"] = {
    state: clawRefs.length > 1 ? "shared" : createdByThisApply ? "newly-created" : "referenced",
    createdByThisApply,
    preexistingDirectInstall: false,
    clawRefs,
    refCount: clawRefs.length,
  };
  db.prepare(
    `UPDATE claw_artifact_refs
        SET ownership_json = @ownership_json,
            updated_at_ms = @updated_at_ms
      WHERE artifact_key = @artifact_key`,
  ).run({
    artifact_key: artifactKey,
    ownership_json: JSON.stringify(ownership),
    updated_at_ms: nowMs,
  });
}

function deleteSuccessfulWorkspaceStateRows(
  clawId: string,
  workspaceFiles: RemovedWorkspaceFile[],
  options: OpenClawStateDatabaseOptions,
): void {
  const successful = workspaceFiles.filter(
    (file) =>
      file.action === "deleted" || file.action === "missing" || file.action === "retainedModified",
  );
  if (successful.length === 0) {
    return;
  }
  runOpenClawStateWriteTransaction(({ db }) => {
    if (!tableExists(db, "claw_workspace_file_refs")) {
      return;
    }
    for (const file of successful) {
      db.prepare(
        `DELETE FROM claw_workspace_file_refs
          WHERE claw_id = ?
            AND workspace_root = ?
            AND entry_id = ?`,
      ).run(clawId, file.workspaceRoot, file.entryId);
    }
  }, options);
}

function deleteClawStateRows(
  clawId: string,
  artifactRefs: PersistedClawArtifactRef[],
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    if (tableExists(db, "claw_artifact_refs")) {
      db.prepare(`DELETE FROM claw_artifact_refs WHERE claw_id = ?`).run(clawId);
      for (const artifactKey of new Set(artifactRefs.map((ref) => ref.artifactKey))) {
        updateArtifactOwnershipRefs(db, artifactKey, Date.now());
      }
    }
    if (tableExists(db, "claw_workspace_file_refs")) {
      db.prepare(`DELETE FROM claw_workspace_file_refs WHERE claw_id = ?`).run(clawId);
    }
    if (tableExists(db, "claw_apply_records")) {
      db.prepare(`DELETE FROM claw_apply_records WHERE claw_id = ?`).run(clawId);
    }
  }, options);
}

export async function removeClawState(
  clawId: string,
  options: OpenClawStateDatabaseOptions & { dryRun?: boolean } = {},
): Promise<ClawRemoveResult> {
  const status = readClawStatus(clawId, options);
  const record = status.records[0];
  const artifactRefs = record?.artifacts ?? [];
  const workspaceRefs = record?.workspaceFiles ?? [];
  const dryRun = Boolean(options.dryRun);
  const workspaceFiles = await removeWorkspaceFiles(workspaceRefs, dryRun);
  const errors = workspaceFiles.filter((file) => file.action === "error").length;
  if (!dryRun && record && errors === 0) {
    deleteClawStateRows(clawId, artifactRefs, options);
  } else if (!dryRun && record) {
    deleteSuccessfulWorkspaceStateRows(clawId, workspaceFiles, options);
  }
  return {
    schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
    dryRun,
    clawId,
    found: Boolean(record),
    summary: {
      artifactRefsRemoved: !dryRun && errors === 0 ? artifactRefs.length : 0,
      workspaceFileRefsRemoved: !dryRun
        ? workspaceFiles.filter(
            (file) =>
              file.action === "deleted" ||
              file.action === "missing" ||
              file.action === "retainedModified",
          ).length
        : 0,
      workspaceFilesDeleted: workspaceFiles.filter((file) => file.action === "deleted").length,
      workspaceFilesRetained: workspaceFiles.filter(
        (file) =>
          file.action === "retainedModified" ||
          file.action === "dryRunRetainModified" ||
          file.action === "dryRunDelete",
      ).length,
      errors,
    },
    artifactRefs,
    workspaceFiles,
  };
}
