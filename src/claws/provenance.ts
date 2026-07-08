// Persists Claw-owned artifact provenance and reference accounting in shared state.
import { dirname, isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawApplyPlan, ClawApplyPlanEntry, PersistedClawWorkspaceFileRef } from "./types.js";

const CLAW_APPLY_RECORD_SCHEMA_VERSION = "openclaw.clawApplyRecord.v1";
const CLAW_ARTIFACT_REF_SCHEMA_VERSION = "openclaw.clawArtifactRef.v1";

export type ClawArtifactOwnershipState =
  | "referenced"
  | "newly-created"
  | "preexisting-direct"
  | "shared";

export type PersistedClawArtifactRef = {
  schemaVersion: typeof CLAW_ARTIFACT_REF_SCHEMA_VERSION;
  clawId: string;
  clawVersion: string;
  entryId: string;
  kind: string;
  artifactKey: string;
  selector: string;
  installSurface: string;
  source: string;
  packageName?: string;
  version?: string;
  provenanceRecord?: string;
  ownership: {
    state: ClawArtifactOwnershipState;
    createdByThisApply: boolean;
    preexistingDirectInstall: boolean;
    clawRefs: string[];
    refCount: number;
  };
  appliedAtMs: number;
  updatedAtMs: number;
};

export type ClawApplyProvenanceResult = {
  schemaVersion: "openclaw.clawApplyResult.v1";
  dryRun: false;
  mutationAllowed: true;
  claw: ClawApplyPlan["claw"];
  summary: {
    totalEntries: number;
    recordedArtifactRefs: number;
    appliedWorkspaceFiles: number;
    previewOnlyEntries: number;
    skippedUnsupported: number;
    blockedEntries: number;
    provenanceRecords: number;
  };
  artifacts: PersistedClawArtifactRef[];
  workspaceFiles: PersistedClawWorkspaceFileRef[];
  previewOnlyEntries: ClawApplyPlanEntry[];
  skippedUnsupportedEntries: ClawApplyPlanEntry[];
  diagnostics: ClawApplyPlan["diagnostics"];
};

type ExistingArtifactRefRow = {
  claw_id: string;
  entry_id: string;
};

type ArtifactOwnershipParams = {
  existingRefs: ExistingArtifactRefRow[];
  includeClawId?: string;
};

type ExistingClawArtifactRow = {
  entry_id: string;
  artifact_key: string;
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

function ensureClawProvenanceTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claw_apply_records (
      claw_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL,
      claw_version TEXT NOT NULL,
      source_path TEXT,
      feed_json TEXT,
      applied_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS claw_artifact_refs (
      claw_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      claw_version TEXT NOT NULL,
      kind TEXT NOT NULL,
      artifact_key TEXT NOT NULL,
      selector TEXT NOT NULL,
      install_surface TEXT NOT NULL,
      source TEXT NOT NULL,
      package_name TEXT,
      version TEXT,
      provenance_record TEXT,
      ownership_json TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (claw_id, entry_id)
    );

    CREATE INDEX IF NOT EXISTS claw_artifact_refs_by_artifact
      ON claw_artifact_refs (artifact_key);
  `);
}

function isLocalAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function fileSelectorPath(selector: string): string | undefined {
  const trimmed = selector.trim();
  if (!trimmed.toLowerCase().startsWith("file:")) {
    return undefined;
  }
  const rest = trimmed.slice("file:".length);
  if (rest.startsWith("///")) {
    return rest.slice(2);
  }
  if (rest.startsWith("//localhost/")) {
    return rest.slice("//localhost".length);
  }
  if (rest.startsWith("//")) {
    return undefined;
  }
  return rest || undefined;
}

function npmPackSelectorPath(selector: string): string | undefined {
  const trimmed = selector.trim();
  if (!trimmed.toLowerCase().startsWith("npm-pack:")) {
    return undefined;
  }
  return trimmed.slice("npm-pack:".length).trim() || undefined;
}

function resolveLocalArtifactIdentity(selector: string, sourcePath?: string): string {
  const localPath = fileSelectorPath(selector) ?? npmPackSelectorPath(selector) ?? selector;
  if (isLocalAbsolutePath(localPath)) {
    return localPath;
  }
  const baseDir = sourcePath ? dirname(sourcePath) : process.cwd();
  return resolve(baseDir, localPath);
}

function canonicalPackageSelector(artifact: NonNullable<ClawApplyPlanEntry["artifact"]>): string {
  if (artifact.packageName) {
    const version = artifact.version ? `@${artifact.version}` : "";
    return `${artifact.source}:${artifact.packageName}${version}`;
  }
  return artifact.selector.trim();
}

function artifactKeyFor(entry: ClawApplyPlanEntry, sourcePath?: string): string {
  const artifact = entry.artifact;
  const surface = artifact?.installSurface ?? entry.kind;
  const selector = artifact?.selector ?? entry.target ?? entry.id;
  if (artifact?.source === "path" || artifact?.source === "npmPack") {
    return `${surface}:${artifact.source}:${resolveLocalArtifactIdentity(selector, sourcePath)}`;
  }
  return `${surface}:${artifact ? canonicalPackageSelector(artifact) : selector}`;
}

function readExistingArtifactRefs(db: DatabaseSync, artifactKey: string): ExistingArtifactRefRow[] {
  return db
    .prepare(
      `SELECT claw_id, entry_id
         FROM claw_artifact_refs
        WHERE artifact_key = ?
        ORDER BY claw_id, entry_id`,
    )
    .all(artifactKey) as ExistingArtifactRefRow[];
}

function buildOwnership(params: ArtifactOwnershipParams): PersistedClawArtifactRef["ownership"] {
  const clawRefs = [
    ...new Set([
      ...params.existingRefs.map((row) => row.claw_id),
      ...(params.includeClawId ? [params.includeClawId] : []),
    ]),
  ].sort();
  const state = clawRefs.length > 1 ? "shared" : "referenced";
  return {
    state,
    createdByThisApply: false,
    preexistingDirectInstall: false,
    clawRefs,
    refCount: clawRefs.length,
  };
}

function buildPersistedRef(params: {
  plan: ClawApplyPlan;
  entry: ClawApplyPlanEntry;
  existingRefs: ExistingArtifactRefRow[];
  nowMs: number;
  sourcePath?: string;
}): PersistedClawArtifactRef {
  const artifact = params.entry.artifact;
  const artifactKey = artifactKeyFor(params.entry, params.sourcePath);
  return {
    schemaVersion: CLAW_ARTIFACT_REF_SCHEMA_VERSION,
    clawId: params.plan.claw.id,
    clawVersion: params.plan.claw.version,
    entryId: params.entry.id,
    kind: params.entry.kind,
    artifactKey,
    selector: artifact?.selector ?? params.entry.target ?? params.entry.id,
    installSurface: artifact?.installSurface ?? params.entry.kind,
    source: artifact?.source ?? "unknown",
    ...(artifact?.packageName ? { packageName: artifact.packageName } : {}),
    ...(artifact?.version ? { version: artifact.version } : {}),
    ...(params.entry.provenanceRecord ? { provenanceRecord: params.entry.provenanceRecord } : {}),
    ownership: buildOwnership({
      existingRefs: params.existingRefs,
      includeClawId: params.plan.claw.id,
    }),
    appliedAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
  };
}

function rowToPersistedRef(row: ArtifactRefRow): PersistedClawArtifactRef {
  const ownership = JSON.parse(row.ownership_json) as PersistedClawArtifactRef["ownership"];
  return {
    schemaVersion: CLAW_ARTIFACT_REF_SCHEMA_VERSION,
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
    ownership,
    appliedAtMs: Number(row.applied_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function readExistingClawArtifactRows(db: DatabaseSync, clawId: string): ExistingClawArtifactRow[] {
  return db
    .prepare(
      `SELECT entry_id, artifact_key
         FROM claw_artifact_refs
        WHERE claw_id = ?
        ORDER BY entry_id`,
    )
    .all(clawId) as ExistingClawArtifactRow[];
}

function readClawArtifactRefs(db: DatabaseSync, clawId: string): PersistedClawArtifactRef[] {
  const rows = db
    .prepare(
      `SELECT claw_id, claw_version, entry_id, kind, artifact_key, selector,
              install_surface, source, package_name, version, provenance_record,
              ownership_json, applied_at_ms, updated_at_ms
         FROM claw_artifact_refs
        WHERE claw_id = ?
        ORDER BY entry_id`,
    )
    .all(clawId) as ArtifactRefRow[];
  return rows.map(rowToPersistedRef);
}

function upsertClawArtifactRef(db: DatabaseSync, ref: PersistedClawArtifactRef): void {
  db.prepare(
    `INSERT INTO claw_artifact_refs (
       claw_id, entry_id, schema_version, claw_version, kind, artifact_key,
       selector, install_surface, source, package_name, version, provenance_record,
       ownership_json, applied_at_ms, updated_at_ms
     ) VALUES (
       @claw_id, @entry_id, @schema_version, @claw_version, @kind, @artifact_key,
       @selector, @install_surface, @source, @package_name, @version, @provenance_record,
       @ownership_json, @applied_at_ms, @updated_at_ms
     )
     ON CONFLICT(claw_id, entry_id) DO UPDATE SET
       schema_version = excluded.schema_version,
       claw_version = excluded.claw_version,
       kind = excluded.kind,
       artifact_key = excluded.artifact_key,
       selector = excluded.selector,
       install_surface = excluded.install_surface,
       source = excluded.source,
       package_name = excluded.package_name,
       version = excluded.version,
       provenance_record = excluded.provenance_record,
       ownership_json = excluded.ownership_json,
       updated_at_ms = excluded.updated_at_ms`,
  ).run({
    claw_id: ref.clawId,
    entry_id: ref.entryId,
    schema_version: ref.schemaVersion,
    claw_version: ref.clawVersion,
    kind: ref.kind,
    artifact_key: ref.artifactKey,
    selector: ref.selector,
    install_surface: ref.installSurface,
    source: ref.source,
    package_name: ref.packageName ?? null,
    version: ref.version ?? null,
    provenance_record: ref.provenanceRecord ?? null,
    ownership_json: JSON.stringify(ref.ownership),
    applied_at_ms: ref.appliedAtMs,
    updated_at_ms: ref.updatedAtMs,
  });
}

function deleteStaleClawArtifactRefs(
  db: DatabaseSync,
  clawId: string,
  currentEntryIds: string[],
): void {
  if (currentEntryIds.length === 0) {
    db.prepare(`DELETE FROM claw_artifact_refs WHERE claw_id = ?`).run(clawId);
    return;
  }

  const placeholders = currentEntryIds.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM claw_artifact_refs
      WHERE claw_id = ?
        AND entry_id NOT IN (${placeholders})`,
  ).run(clawId, ...currentEntryIds);
}

function updateArtifactOwnershipRefs(db: DatabaseSync, artifactKey: string, nowMs: number): void {
  const refs = readExistingArtifactRefs(db, artifactKey);
  const ownership = buildOwnership({ existingRefs: refs });
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

export function persistClawArtifactApplyProvenance(
  plan: ClawApplyPlan,
  options: OpenClawStateDatabaseOptions & {
    sourcePath?: string;
    feed?: unknown;
    nowMs?: number;
  } = {},
): ClawApplyProvenanceResult {
  const blockedEntries = plan.entries.filter((entry) => entry.blocked);
  const artifactEntries = plan.entries.filter(
    (entry) => !entry.blocked && entry.phase === "artifact" && entry.action === "installArtifact",
  );
  const previewOnlyEntries = plan.entries.filter(
    (entry) => !entry.blocked && (entry.phase === "workspace" || entry.phase === "automation"),
  );
  const skippedUnsupportedEntries = plan.entries.filter(
    (entry) => !entry.blocked && entry.action === "skipUnsupported",
  );
  if (blockedEntries.length > 0) {
    return {
      schemaVersion: "openclaw.clawApplyResult.v1",
      dryRun: false,
      mutationAllowed: true,
      claw: plan.claw,
      summary: {
        totalEntries: plan.entries.length,
        recordedArtifactRefs: 0,
        appliedWorkspaceFiles: 0,
        previewOnlyEntries: previewOnlyEntries.length,
        skippedUnsupported: skippedUnsupportedEntries.length,
        blockedEntries: blockedEntries.length,
        provenanceRecords: 0,
      },
      artifacts: [],
      workspaceFiles: [],
      previewOnlyEntries,
      skippedUnsupportedEntries,
      diagnostics: plan.diagnostics,
    };
  }

  const nowMs = options.nowMs ?? Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    ensureClawProvenanceTables(db);
    db.prepare(
      `INSERT INTO claw_apply_records (
         claw_id, schema_version, claw_version, source_path, feed_json, applied_at_ms, updated_at_ms
       ) VALUES (
         @claw_id, @schema_version, @claw_version, @source_path, @feed_json, @applied_at_ms, @updated_at_ms
       )
       ON CONFLICT(claw_id) DO UPDATE SET
         schema_version = excluded.schema_version,
         claw_version = excluded.claw_version,
         source_path = excluded.source_path,
         feed_json = excluded.feed_json,
         updated_at_ms = excluded.updated_at_ms`,
    ).run({
      claw_id: plan.claw.id,
      schema_version: CLAW_APPLY_RECORD_SCHEMA_VERSION,
      claw_version: plan.claw.version,
      source_path: options.sourcePath ?? plan.claw.sourcePath ?? null,
      feed_json: options.feed === undefined ? null : JSON.stringify(options.feed),
      applied_at_ms: nowMs,
      updated_at_ms: nowMs,
    });

    const previousArtifactRows = readExistingClawArtifactRows(db, plan.claw.id);
    const affectedArtifactKeys = new Set(previousArtifactRows.map((row) => row.artifact_key));
    const currentEntryIds = artifactEntries.map((entry) => entry.id);
    deleteStaleClawArtifactRefs(db, plan.claw.id, currentEntryIds);

    for (const entry of artifactEntries) {
      const sourcePath = options.sourcePath ?? plan.claw.sourcePath;
      const artifactKey = artifactKeyFor(entry, sourcePath);
      const existingRefs = readExistingArtifactRefs(db, artifactKey);
      upsertClawArtifactRef(
        db,
        buildPersistedRef({ plan, entry, existingRefs, nowMs, sourcePath }),
      );
      affectedArtifactKeys.add(artifactKey);
    }

    for (const artifactKey of affectedArtifactKeys) {
      updateArtifactOwnershipRefs(db, artifactKey, nowMs);
    }
  }, options);

  const database = openOpenClawStateDatabase(options);
  ensureClawProvenanceTables(database.db);
  const artifacts = readClawArtifactRefs(database.db, plan.claw.id);
  return {
    schemaVersion: "openclaw.clawApplyResult.v1",
    dryRun: false,
    mutationAllowed: true,
    claw: plan.claw,
    summary: {
      totalEntries: plan.entries.length,
      recordedArtifactRefs: artifacts.length,
      appliedWorkspaceFiles: 0,
      previewOnlyEntries: previewOnlyEntries.length,
      skippedUnsupported: skippedUnsupportedEntries.length,
      blockedEntries: 0,
      provenanceRecords: artifacts.length,
    },
    artifacts,
    workspaceFiles: [],
    previewOnlyEntries,
    skippedUnsupportedEntries,
    diagnostics: plan.diagnostics,
  };
}
