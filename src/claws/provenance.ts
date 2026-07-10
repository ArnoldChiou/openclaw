// Persists the root ownership record for one Claw-created agent and workspace.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableStringify } from "../agents/stable-stringify.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan, ClawPackage } from "./types.js";

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

export const CLAW_PACKAGE_REF_SCHEMA_VERSION = "openclaw.clawPackageRef.v1" as const;

export type PersistedClawPackageRef = {
  schemaVersion: typeof CLAW_PACKAGE_REF_SCHEMA_VERSION;
  agentId: string;
  clawName: string;
  kind: ClawPackage["kind"];
  source: ClawPackage["source"];
  ref: string;
  version: string;
  installedAtMs: number;
};

type PackageRefRow = {
  schema_version: string;
  agent_id: string;
  claw_name: string;
  package_kind: ClawPackage["kind"];
  package_source: ClawPackage["source"];
  package_ref: string;
  package_version: string;
  installed_at_ms: number | bigint;
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

function ensureClawPackageRefTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claw_package_refs (
      agent_id TEXT NOT NULL,
      package_kind TEXT NOT NULL,
      package_source TEXT NOT NULL,
      package_ref TEXT NOT NULL,
      package_version TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      claw_name TEXT NOT NULL,
      installed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (agent_id, package_kind, package_source, package_ref, package_version)
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

function rowToPackageRef(row: PackageRefRow): PersistedClawPackageRef {
  return {
    schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
    agentId: row.agent_id,
    clawName: row.claw_name,
    kind: row.package_kind,
    source: row.package_source,
    ref: row.package_ref,
    version: row.package_version,
    installedAtMs: Number(row.installed_at_ms),
  };
}

export function persistClawPackageRef(
  plan: ClawAddPlan,
  pkg: ClawPackage,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): PersistedClawPackageRef {
  const record: PersistedClawPackageRef = {
    schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    clawName: plan.claw.name,
    kind: pkg.kind,
    source: pkg.source,
    ref: pkg.ref,
    version: pkg.version,
    installedAtMs: options.nowMs ?? Date.now(),
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    ensureClawPackageRefTable(db);
    db.prepare(
      `INSERT INTO claw_package_refs (
         agent_id, package_kind, package_source, package_ref, package_version,
         schema_version, claw_name, installed_at_ms
       ) VALUES (
         @agent_id, @package_kind, @package_source, @package_ref, @package_version,
         @schema_version, @claw_name, @installed_at_ms
       )`,
    ).run({
      agent_id: record.agentId,
      package_kind: record.kind,
      package_source: record.source,
      package_ref: record.ref,
      package_version: record.version,
      schema_version: record.schemaVersion,
      claw_name: record.clawName,
      installed_at_ms: record.installedAtMs,
    });
  }, options);
  return record;
}

export function readClawPackageRefs(
  options: OpenClawStateDatabaseOptions & {
    kind?: ClawPackage["kind"];
    source?: ClawPackage["source"];
    ref?: string;
    version?: string;
  } = {},
): PersistedClawPackageRef[] {
  const database = openOpenClawStateDatabase(options);
  ensureClawPackageRefTable(database.db);
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  for (const [column, value] of [
    ["package_kind", options.kind],
    ["package_source", options.source],
    ["package_ref", options.ref],
    ["package_version", options.version],
  ] as const) {
    if (value !== undefined) {
      conditions.push(`${column} = @${column}`);
      params[column] = value;
    }
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const rows = database.db
    .prepare(
      `SELECT schema_version, agent_id, claw_name, package_kind, package_source,
              package_ref, package_version, installed_at_ms
         FROM claw_package_refs${where}
        ORDER BY agent_id, package_kind, package_ref`,
    )
    .all(params) as PackageRefRow[];
  return rows.map(rowToPackageRef);
}
