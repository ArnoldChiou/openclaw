// Creates Claw-owned bootstrap and supporting files inside the new agent workspace.
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { root as fsSafeRoot, FsSafeError } from "../infra/fs-safe.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan, ClawAddPlanAction, ClawDiagnostic } from "./types.js";

export const CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION =
  "openclaw.clawWorkspaceFileRecord.v1" as const;

const MAX_CLAW_WORKSPACE_FILE_BYTES = 1024 * 1024;

export type PersistedClawWorkspaceFile = {
  schemaVersion: typeof CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION;
  agentId: string;
  workspace: string;
  path: string;
  sourcePath: string;
  contentDigest: string;
  createdAtMs: number;
};

type WorkspaceFileRow = {
  schema_version: string;
  agent_id: string;
  workspace: string;
  target_path: string;
  source_path: string;
  content_digest: string;
  created_at_ms: number | bigint;
};

export class ClawWorkspaceWriteError extends Error {
  constructor(
    readonly diagnostics: ClawDiagnostic[],
    readonly createdFiles: PersistedClawWorkspaceFile[],
  ) {
    super("Claw workspace file creation failed");
    this.name = "ClawWorkspaceWriteError";
  }
}

function ensureWorkspaceFileTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claw_workspace_files (
      agent_id TEXT NOT NULL,
      target_path TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      workspace TEXT NOT NULL,
      source_path TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (agent_id, target_path)
    );
  `);
}

function diagnostic(action: ClawAddPlanAction, code: string, message: string): ClawDiagnostic {
  return {
    level: "error",
    code,
    path: `$.workspace[${JSON.stringify(action.id)}]`,
    message,
  };
}

function contentDigest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function containedRelativePath(root: string, path: string): string | undefined {
  const child = relative(root, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    return undefined;
  }
  return child;
}

function persistWorkspaceFile(
  record: PersistedClawWorkspaceFile,
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    ensureWorkspaceFileTable(db);
    db.prepare(
      `INSERT INTO claw_workspace_files (
         agent_id, target_path, schema_version, workspace, source_path,
         content_digest, created_at_ms
       ) VALUES (
         @agent_id, @target_path, @schema_version, @workspace, @source_path,
         @content_digest, @created_at_ms
       )`,
    ).run({
      agent_id: record.agentId,
      target_path: record.path,
      schema_version: record.schemaVersion,
      workspace: record.workspace,
      source_path: record.sourcePath,
      content_digest: record.contentDigest,
      created_at_ms: record.createdAtMs,
    });
  }, options);
}

function workspaceFileActions(plan: ClawAddPlan): ClawAddPlanAction[] {
  return plan.actions.filter((action) => action.kind === "workspaceFile");
}

export async function createClawWorkspaceFiles(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): Promise<PersistedClawWorkspaceFile[]> {
  const actions = workspaceFileActions(plan);
  if (actions.length === 0) {
    return [];
  }

  const workspaceRoot = resolve(plan.agent.workspace);
  const packageRoot = resolve(plan.claw.packageRoot);
  const source = await fsSafeRoot(packageRoot, {
    hardlinks: "reject",
    maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  const workspace = await fsSafeRoot(workspaceRoot, {
    hardlinks: "reject",
    maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  const createdFiles: PersistedClawWorkspaceFile[] = [];
  const nowMs = options.nowMs ?? Date.now();

  for (const action of actions) {
    try {
      if (!action.source || !action.digest) {
        throw new ClawWorkspaceWriteError(
          [
            diagnostic(
              action,
              "workspace_file_plan_invalid",
              "File action lacks source or digest.",
            ),
          ],
          createdFiles,
        );
      }
      const sourcePath = resolve(action.source);
      const targetPath = resolve(action.target);
      const sourceRelative = containedRelativePath(packageRoot, sourcePath);
      const targetRelative = containedRelativePath(workspaceRoot, targetPath);
      if (!sourceRelative || !targetRelative) {
        throw new ClawWorkspaceWriteError(
          [
            diagnostic(
              action,
              "workspace_file_path_escape",
              "Workspace file source and destination must remain inside their owned roots.",
            ),
          ],
          createdFiles,
        );
      }
      const content = await source.readBytes(sourceRelative, {
        maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
      });
      const digest = contentDigest(content);
      if (digest !== action.digest) {
        throw new ClawWorkspaceWriteError(
          [
            diagnostic(
              action,
              "workspace_source_changed",
              `Workspace source for ${JSON.stringify(action.id)} changed after planning.`,
            ),
          ],
          createdFiles,
        );
      }
      if (await workspace.exists(targetRelative)) {
        throw new ClawWorkspaceWriteError(
          [
            diagnostic(
              action,
              "workspace_file_collision",
              `Workspace destination ${JSON.stringify(targetRelative)} already exists.`,
            ),
          ],
          createdFiles,
        );
      }
      await workspace.write(targetRelative, content, { mkdir: true, overwrite: false });
      const record: PersistedClawWorkspaceFile = {
        schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
        agentId: plan.agent.finalId,
        workspace: workspace.rootReal,
        path: targetRelative,
        sourcePath,
        contentDigest: digest,
        createdAtMs: nowMs,
      };
      persistWorkspaceFile(record, options);
      createdFiles.push(record);
    } catch (error) {
      if (error instanceof ClawWorkspaceWriteError) {
        throw error;
      }
      const code =
        error instanceof FsSafeError ? `workspace_file_${error.code}` : "workspace_file_io_error";
      throw new ClawWorkspaceWriteError(
        [diagnostic(action, code, error instanceof Error ? error.message : String(error))],
        createdFiles,
      );
    }
  }
  return createdFiles;
}

export function readClawWorkspaceFiles(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawWorkspaceFile[] {
  const database = openOpenClawStateDatabase(options);
  ensureWorkspaceFileTable(database.db);
  const rows = database.db
    .prepare(
      `SELECT schema_version, agent_id, workspace, target_path, source_path,
              content_digest, created_at_ms
         FROM claw_workspace_files
        WHERE agent_id = ?
        ORDER BY target_path`,
    )
    .all(agentId) as WorkspaceFileRow[];
  return rows.map((row) => ({
    schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
    agentId: row.agent_id,
    workspace: row.workspace,
    path: row.target_path,
    sourcePath: row.source_path,
    contentDigest: row.content_digest,
    createdAtMs: Number(row.created_at_ms),
  }));
}
