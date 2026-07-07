// Persists the root ownership record for one Claw-created agent and workspace.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableStringify } from "../agents/stable-stringify.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan } from "./types.js";

export const CLAW_INSTALL_RECORD_SCHEMA_VERSION = "openclaw.clawInstallRecord.v1" as const;

export type ClawInstallStatus = "complete" | "partial";

export type PersistedClawInstall = {
  schemaVersion: typeof CLAW_INSTALL_RECORD_SCHEMA_VERSION;
  claw: ClawAddPlan["claw"];
  agentId: string;
  workspace: string;
  agentConfigDigest: string;
  status: ClawInstallStatus;
  addedAtMs: number;
  updatedAtMs: number;
};

type InstallRow = {
  schema_version: string;
  source_kind: "package" | "development";
  claw_name: string;
  claw_version: string;
  package_root: string;
  manifest_path: string;
  integrity: string;
  agent_id: string;
  workspace: string;
  agent_config_digest: string;
  status: ClawInstallStatus;
  added_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

function ensureClawInstallTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claw_installs (
      agent_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      claw_name TEXT NOT NULL,
      claw_version TEXT NOT NULL,
      package_root TEXT NOT NULL,
      manifest_path TEXT NOT NULL,
      integrity TEXT NOT NULL,
      workspace TEXT NOT NULL UNIQUE,
      agent_config_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      added_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function digestAgentConfig(plan: ClawAddPlan): string {
  return `sha256:${createHash("sha256").update(stableStringify(plan.agent.config)).digest("hex")}`;
}

function rowToInstall(row: InstallRow): PersistedClawInstall {
  return {
    schemaVersion: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
    claw: {
      kind: row.source_kind,
      name: row.claw_name,
      version: row.claw_version,
      packageRoot: row.package_root,
      manifestPath: row.manifest_path,
      integrity: row.integrity,
    },
    agentId: row.agent_id,
    workspace: row.workspace,
    agentConfigDigest: row.agent_config_digest,
    status: row.status,
    addedAtMs: Number(row.added_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export function persistClawInstallRecord(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & { status?: ClawInstallStatus; nowMs?: number } = {},
): PersistedClawInstall {
  const nowMs = options.nowMs ?? Date.now();
  const status = options.status ?? "complete";
  const agentConfigDigest = digestAgentConfig(plan);
  runOpenClawStateWriteTransaction(({ db }) => {
    ensureClawInstallTable(db);
    db.prepare(
      `INSERT INTO claw_installs (
         agent_id, schema_version, source_kind, claw_name, claw_version,
         package_root, manifest_path, integrity, workspace, agent_config_digest,
         status, added_at_ms, updated_at_ms
       ) VALUES (
         @agent_id, @schema_version, @source_kind, @claw_name, @claw_version,
         @package_root, @manifest_path, @integrity, @workspace, @agent_config_digest,
         @status, @added_at_ms, @updated_at_ms
       )`,
    ).run({
      agent_id: plan.agent.finalId,
      schema_version: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
      source_kind: plan.claw.kind,
      claw_name: plan.claw.name,
      claw_version: plan.claw.version,
      package_root: plan.claw.packageRoot,
      manifest_path: plan.claw.manifestPath,
      integrity: plan.claw.integrity,
      workspace: plan.agent.workspace,
      agent_config_digest: agentConfigDigest,
      status,
      added_at_ms: nowMs,
      updated_at_ms: nowMs,
    });
  }, options);
  return {
    schemaVersion: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
    claw: plan.claw,
    agentId: plan.agent.finalId,
    workspace: plan.agent.workspace,
    agentConfigDigest,
    status,
    addedAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

export function readClawInstallRecord(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawInstall | undefined {
  const database = openOpenClawStateDatabase(options);
  ensureClawInstallTable(database.db);
  const row = database.db
    .prepare(
      `SELECT schema_version, source_kind, claw_name, claw_version, package_root,
              manifest_path, integrity, agent_id, workspace, agent_config_digest,
              status, added_at_ms, updated_at_ms
         FROM claw_installs
        WHERE agent_id = ?`,
    )
    .get(agentId) as InstallRow | undefined;
  return row ? rowToInstall(row) : undefined;
}
