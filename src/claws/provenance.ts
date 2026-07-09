// Persists Claw-owned artifact provenance and reference accounting in shared state.
import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { canonicalizeConfiguredMcpServer } from "../config/mcp-config-normalize.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { isExactSemverVersion } from "../infra/npm-registry-spec.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { pluginInstallRecordMatchesClawArtifact } from "./artifact-identity.js";
import type { ClawApplyPlan, ClawApplyPlanEntry, PersistedClawWorkspaceFileRef } from "./types.js";

const CLAW_APPLY_RECORD_SCHEMA_VERSION = "openclaw.clawApplyRecord.v1";
const CLAW_ARTIFACT_REF_SCHEMA_VERSION = "openclaw.clawArtifactRef.v1";

export type ClawArtifactOwnershipState = "referenced" | "newly-created" | "shared";

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

type ArtifactRefWithSourceRow = ArtifactRefRow & {
  source_path: string | null;
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
    const rawVersion = artifact.version?.trim();
    const normalizedVersion =
      artifact.source === "npm" && rawVersion && isExactSemverVersion(rawVersion)
        ? rawVersion.replace(/^v/i, "")
        : rawVersion;
    const version = normalizedVersion ? `@${normalizedVersion}` : "";
    return `${artifact.source}:${artifact.packageName}${version}`;
  }
  return artifact.selector.trim();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalInlineArtifactSelector(selector: string): string {
  try {
    const parsed = JSON.parse(selector) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return stableJson(canonicalizeConfiguredMcpServer(parsed as Record<string, unknown>));
    }
    return stableJson(parsed);
  } catch {
    return selector.trim();
  }
}

function inlineArtifactSelectorDigest(selector: string): string {
  return createHash("sha256").update(canonicalInlineArtifactSelector(selector)).digest("hex");
}

function inlineArtifactSelectorLabel(selector: string): string {
  return `inline:sha256:${inlineArtifactSelectorDigest(selector)}`;
}

function resolveLocalGitArtifactIdentity(selector: string, sourcePath?: string): string {
  const trimmed = selector.trim();
  if (!trimmed.toLowerCase().startsWith("git:")) {
    return selector;
  }
  const body = trimmed.slice("git:".length).trim();
  if (!(body.startsWith("./") || body.startsWith("../"))) {
    return selector;
  }
  const hashIndex = body.lastIndexOf("#");
  const atIndex = body.lastIndexOf("@");
  const splitIndex = hashIndex > 0 ? hashIndex : atIndex > 0 ? atIndex : -1;
  const base = splitIndex > 0 ? body.slice(0, splitIndex) : body;
  const refSuffix = splitIndex > 0 ? body.slice(splitIndex) : "";
  return `git:file://${resolve(sourcePath ? dirname(sourcePath) : process.cwd(), base)}${refSuffix}`;
}

export function artifactKeyFor(entry: ClawApplyPlanEntry, sourcePath?: string): string {
  const artifact = entry.artifact;
  const surface = artifact?.installSurface ?? entry.kind;
  const selector = artifact?.selector ?? entry.target ?? entry.id;
  if (artifact?.source === "path" || artifact?.source === "npmPack") {
    return `${surface}:${artifact.source}:${resolveLocalArtifactIdentity(selector, sourcePath)}`;
  }
  if (artifact?.source === "git") {
    return `${surface}:${resolveLocalGitArtifactIdentity(selector, sourcePath)}`;
  }
  if (artifact?.source === "inline") {
    return `${surface}:inline:${entry.id}:${inlineArtifactSelectorLabel(selector)}`;
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

function buildOwnership(
  params: ArtifactOwnershipParams & {
    createdByThisApply?: boolean;
  },
): PersistedClawArtifactRef["ownership"] {
  const createdByThisApply = Boolean(params.createdByThisApply);
  const clawRefs = [
    ...new Set([
      ...params.existingRefs.map((row) => row.claw_id),
      ...(params.includeClawId ? [params.includeClawId] : []),
    ]),
  ].sort();
  const refCount = clawRefs.length;
  const state = refCount > 1 ? "shared" : createdByThisApply ? "newly-created" : "referenced";
  return {
    state,
    createdByThisApply,
    preexistingDirectInstall: false,
    clawRefs,
    refCount,
  };
}

function buildPersistedRef(params: {
  plan: ClawApplyPlan;
  entry: ClawApplyPlanEntry;
  existingRefs: ExistingArtifactRefRow[];
  nowMs: number;
  sourcePath?: string;
  createdArtifactKeys?: ReadonlySet<string>;
  previousRef?: PersistedClawArtifactRef;
}): PersistedClawArtifactRef {
  const artifact = params.entry.artifact;
  const artifactKey = artifactKeyFor(params.entry, params.sourcePath);
  const previousOwnership =
    params.previousRef?.artifactKey === artifactKey ? params.previousRef.ownership : undefined;
  const createdByThisApply =
    (params.createdArtifactKeys?.has(artifactKey) ?? false) ||
    (previousOwnership?.createdByThisApply ?? false);
  return {
    schemaVersion: CLAW_ARTIFACT_REF_SCHEMA_VERSION,
    clawId: params.plan.claw.id,
    clawVersion: params.plan.claw.version,
    entryId: params.entry.id,
    kind: params.entry.kind,
    artifactKey,
    selector:
      artifact?.source === "inline"
        ? inlineArtifactSelectorLabel(artifact.selector)
        : (artifact?.selector ?? params.entry.target ?? params.entry.id),
    installSurface: artifact?.installSurface ?? params.entry.kind,
    source: artifact?.source ?? "unknown",
    ...(artifact?.packageName ? { packageName: artifact.packageName } : {}),
    ...(artifact?.version ? { version: artifact.version } : {}),
    ...(params.entry.provenanceRecord ? { provenanceRecord: params.entry.provenanceRecord } : {}),
    ownership: buildOwnership({
      existingRefs: params.existingRefs,
      includeClawId: params.plan.claw.id,
      createdByThisApply,
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

function pinningForPersistedRef(
  ref: PersistedClawArtifactRef,
): NonNullable<ClawApplyPlanEntry["artifact"]>["provenance"]["pinning"] {
  if (!ref.version) {
    return "floating";
  }
  return ref.source === "npm" && isExactSemverVersion(ref.version) ? "pinned" : "floating";
}

function persistedRefToPlanEntry(ref: PersistedClawArtifactRef): ClawApplyPlanEntry {
  return {
    id: ref.entryId,
    kind: ref.kind,
    required: true,
    phase: "artifact",
    action: "installArtifact",
    target: ref.selector,
    consentRequired: false,
    blocked: false,
    artifact: {
      source: ref.source as NonNullable<ClawApplyPlanEntry["artifact"]>["source"],
      selector: ref.selector,
      installSurface: ref.installSurface as NonNullable<
        ClawApplyPlanEntry["artifact"]
      >["installSurface"],
      ...(ref.packageName ? { packageName: ref.packageName } : {}),
      ...(ref.version ? { version: ref.version } : {}),
      provenance: {
        record: (ref.provenanceRecord ?? "plugin.installRecord") as NonNullable<
          ClawApplyPlanEntry["artifact"]
        >["provenance"]["record"],
        requestedSpecifier: ref.selector,
        pinning: pinningForPersistedRef(ref),
      },
      supported: true,
    },
    ...(ref.provenanceRecord
      ? {
          provenanceRecord: ref.provenanceRecord as NonNullable<
            ClawApplyPlanEntry["provenanceRecord"]
          >,
        }
      : {}),
    rollback: { action: "uninstallArtifact", target: ref.selector },
    reason: "Persisted Claw artifact reference.",
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

function readClawArtifactRef(
  db: DatabaseSync,
  clawId: string,
  entryId: string,
): PersistedClawArtifactRef | undefined {
  const row = db
    .prepare(
      `SELECT claw_id, claw_version, entry_id, kind, artifact_key, selector,
              install_surface, source, package_name, version, provenance_record,
              ownership_json, applied_at_ms, updated_at_ms
         FROM claw_artifact_refs
        WHERE claw_id = ? AND entry_id = ?`,
    )
    .get(clawId, entryId) as ArtifactRefRow | undefined;
  return row ? rowToPersistedRef(row) : undefined;
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
  const createdByThisApply = refs.some((row) => {
    const current = db
      .prepare(`SELECT ownership_json FROM claw_artifact_refs WHERE claw_id = ? AND entry_id = ?`)
      .get(row.claw_id, row.entry_id) as { ownership_json?: string } | undefined;
    if (!current?.ownership_json) {
      return false;
    }
    try {
      return Boolean(
        (JSON.parse(current.ownership_json) as PersistedClawArtifactRef["ownership"])
          .createdByThisApply,
      );
    } catch {
      return false;
    }
  });
  const ownership = buildOwnership({
    existingRefs: refs,
    createdByThisApply,
  });
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

export function readClawArtifactRefsForArtifactKey(
  artifactKey: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawArtifactRef[] {
  const database = openOpenClawStateDatabase(options);
  ensureClawProvenanceTables(database.db);
  const rows = database.db
    .prepare(
      `SELECT claw_id, claw_version, entry_id, kind, artifact_key, selector,
              install_surface, source, package_name, version, provenance_record,
              ownership_json, applied_at_ms, updated_at_ms
         FROM claw_artifact_refs
        WHERE artifact_key = ?
        ORDER BY claw_id, entry_id`,
    )
    .all(artifactKey) as ArtifactRefRow[];
  return rows.map(rowToPersistedRef);
}

export function readClawArtifactRefsForPluginInstallRecord(
  _pluginId: string,
  record: PluginInstallRecord,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawArtifactRef[] {
  const database = openOpenClawStateDatabase(options);
  ensureClawProvenanceTables(database.db);
  const rows = database.db
    .prepare(
      `SELECT refs.claw_id, refs.claw_version, refs.entry_id, refs.kind, refs.artifact_key,
              refs.selector, refs.install_surface, refs.source, refs.package_name, refs.version,
              refs.provenance_record, refs.ownership_json, refs.applied_at_ms, refs.updated_at_ms,
              records.source_path
         FROM claw_artifact_refs refs
         LEFT JOIN claw_apply_records records ON records.claw_id = refs.claw_id
        WHERE refs.install_surface = 'plugins'
        ORDER BY refs.claw_id, refs.entry_id`,
    )
    .all() as ArtifactRefWithSourceRow[];
  return rows
    .map((row) => ({ row, ref: rowToPersistedRef(row) }))
    .filter(({ row, ref }) =>
      pluginInstallRecordMatchesClawArtifact(
        persistedRefToPlanEntry(ref),
        record,
        row.source_path ?? undefined,
      ),
    )
    .map(({ ref }) => ref);
}

export function persistClawArtifactApplyProvenance(
  plan: ClawApplyPlan,
  options: OpenClawStateDatabaseOptions & {
    sourcePath?: string;
    feed?: unknown;
    nowMs?: number;
    createdArtifactKeys?: ReadonlySet<string>;
    artifactKeys?: ReadonlySet<string>;
  } = {},
): ClawApplyProvenanceResult {
  const blockedEntries = plan.entries.filter((entry) => entry.blocked);
  const sourcePathForArtifacts = options.sourcePath ?? plan.claw.sourcePath;
  const artifactEntries = plan.entries.filter((entry) => {
    if (
      entry.blocked ||
      entry.phase !== "artifact" ||
      entry.action !== "installArtifact" ||
      (entry.artifact?.installSurface !== "plugins" &&
        entry.artifact?.installSurface !== "skills" &&
        entry.artifact?.installSurface !== "mcpServers")
    ) {
      return false;
    }
    if (!options.artifactKeys) {
      return true;
    }
    return options.artifactKeys.has(artifactKeyFor(entry, sourcePathForArtifacts));
  });
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
    if (!options.artifactKeys) {
      deleteStaleClawArtifactRefs(db, plan.claw.id, currentEntryIds);
    }

    for (const entry of artifactEntries) {
      const sourcePath = options.sourcePath ?? plan.claw.sourcePath;
      const artifactKey = artifactKeyFor(entry, sourcePath);
      const existingRefs = readExistingArtifactRefs(db, artifactKey);
      const previousRef = readClawArtifactRef(db, plan.claw.id, entry.id);
      upsertClawArtifactRef(
        db,
        buildPersistedRef({
          plan,
          entry,
          existingRefs,
          nowMs,
          sourcePath,
          createdArtifactKeys: options.createdArtifactKeys,
          previousRef,
        }),
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
