// Shared types for OpenClaw claw manifests and read-only plans.

export const CLAW_SCHEMA_VERSION = "openclaw.claw.v1" as const;
export const CLAW_PLAN_SCHEMA_VERSION = "openclaw.clawPlan.v1" as const;
export const CLAW_APPLY_PLAN_SCHEMA_VERSION = "openclaw.clawApplyPlan.v1" as const;
export const CLAW_FEED_SCHEMA_VERSION = "openclaw.clawFeed.v1" as const;

export type ClawSchemaVersion = typeof CLAW_SCHEMA_VERSION;
export type ClawPlanSchemaVersion = typeof CLAW_PLAN_SCHEMA_VERSION;
export type ClawApplyPlanSchemaVersion = typeof CLAW_APPLY_PLAN_SCHEMA_VERSION;
export type ClawFeedSchemaVersion = typeof CLAW_FEED_SCHEMA_VERSION;

export type ClawDiagnosticLevel = "error" | "warning";

export type ClawDiagnostic = {
  level: ClawDiagnosticLevel;
  code: string;
  path: string;
  message: string;
};

export type ClawEntryKind =
  | "skill"
  | "plugin"
  | "mcpServer"
  | "connector"
  | "workspaceFile"
  | "persona"
  | "heartbeat"
  | "schedule"
  | "automation";

export type ClawEntryBase = {
  kind: ClawEntryKind;
  id: string;
  required?: boolean;
  description?: string;
};

export type ClawPackageEntry = ClawEntryBase & {
  kind: "skill" | "plugin" | "mcpServer" | "connector";
  selector: string;
};

export type ClawFileEntry = ClawEntryBase & {
  kind: "workspaceFile" | "persona";
  path: string;
  source: string;
};

export type ClawAutomationEntry = ClawEntryBase & {
  kind: "heartbeat" | "schedule" | "automation";
  source: string;
  enableDefault?: boolean;
};

export type ClawEntry = ClawPackageEntry | ClawFileEntry | ClawAutomationEntry;

export type ClawUnknownEntry = {
  kind: string;
  id?: string;
  required?: boolean;
  description?: string;
};

export type ClawFeedOwner = {
  type: "publisher" | "clawhub" | "local";
  id: string;
};

export type ClawFeedTrustLevel = "unknown" | "source" | "verified";

export type ClawFeedEntry = {
  id: string;
  name: string;
  version: string;
  source: string;
  publisher?: string;
  description?: string;
  owner?: ClawFeedOwner;
  trust?: {
    level: ClawFeedTrustLevel;
  };
};

export type ClawFeed = {
  schemaVersion: ClawFeedSchemaVersion;
  id: string;
  name: string;
  publisher?: string;
  description?: string;
  generatedAt?: string;
  entries: ClawFeedEntry[];
};

export type ClawFeedReadResult =
  | {
      ok: true;
      feed: ClawFeed;
      diagnostics: ClawDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: ClawDiagnostic[];
    };

export type ClawFeedManifestReadResult =
  | {
      ok: true;
      feed: ClawFeed;
      entry: ClawFeedEntry;
      manifest: ClawManifest;
      manifestPath: string;
      diagnostics: ClawDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: ClawDiagnostic[];
    };

export type ClawManifest = {
  schemaVersion: ClawSchemaVersion;
  id: string;
  name: string;
  version: string;
  publisher?: string;
  description?: string;
  compatibility?: {
    minHostVersion?: string;
    surfaces?: string[];
  };
  update?: {
    mode?: "pinned" | "latest";
  };
  entries: ClawEntry[];
  optionalUnknownEntries: ClawUnknownEntry[];
};

export type ClawReadResult =
  | {
      ok: true;
      manifest: ClawManifest;
      diagnostics: ClawDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: ClawDiagnostic[];
    };

export type ClawPlanEntryDecision = "inspectOnly" | "requiresConsent" | "blockedUnsupported";

export type ClawArtifactSource = "clawhub" | "npm" | "npmPack" | "git" | "path" | "unknown";

export type ClawArtifactInstallSurface = "skills" | "plugins" | "mcpServers" | "connectors";

export type ClawArtifactProvenanceRecord =
  | "skill.clawhubOrigin"
  | "plugin.installRecord"
  | "mcpServer.installRecord"
  | "connector.installRecord";

export type ClawArtifactPreview = {
  source: ClawArtifactSource;
  selector: string;
  installSurface: ClawArtifactInstallSurface;
  packageName?: string;
  version?: string;
  provenance: {
    record: ClawArtifactProvenanceRecord;
    requestedSpecifier: string;
    pinning: "pinned" | "floating" | "unknown";
  };
  supported: boolean;
};

export type ClawPlanEntry = {
  id: string;
  kind: ClawEntryKind | string;
  required: boolean;
  decision: ClawPlanEntryDecision;
  target?: string;
  source?: string;
  artifact?: ClawArtifactPreview;
  reason: string;
};

export type ClawPlan = {
  schemaVersion: ClawPlanSchemaVersion;
  readOnly: true;
  claw: {
    id: string;
    name: string;
    version: string;
    sourcePath?: string;
  };
  summary: {
    totalEntries: number;
    requiredEntries: number;
    optionalEntries: number;
    requiresConsent: number;
    unsupportedRequiredEntries: number;
    unsupportedOptionalEntries: number;
  };
  entries: ClawPlanEntry[];
  diagnostics: ClawDiagnostic[];
};

export type ClawApplyPlanEntryAction =
  | "installArtifact"
  | "writeWorkspaceFile"
  | "writePersonaFile"
  | "registerAutomation"
  | "skipUnsupported";

export type ClawApplyPlanEntryPhase = "artifact" | "workspace" | "automation" | "unsupported";

export type ClawApplyPlanEntry = {
  id: string;
  kind: ClawEntryKind | string;
  required: boolean;
  phase: ClawApplyPlanEntryPhase;
  action: ClawApplyPlanEntryAction;
  target?: string;
  source?: string;
  consentRequired: boolean;
  blocked: boolean;
  artifact?: ClawArtifactPreview;
  provenanceRecord?:
    | ClawArtifactProvenanceRecord
    | "workspaceFile.installRecord"
    | "automation.installRecord";
  rollback: {
    action: "uninstallArtifact" | "removeWorkspaceFile" | "disableAutomation" | "none";
    target?: string;
  };
  reason: string;
};

export type PersistedClawWorkspaceFileRef = {
  schemaVersion: "openclaw.clawWorkspaceFileRef.v1";
  clawId: string;
  clawVersion: string;
  entryId: string;
  kind: string;
  targetPath: string;
  workspaceRoot: string;
  sourcePath: string;
  contentSha256: string;
  operation: "created" | "updated" | "unchanged";
  provenanceRecord?: "workspaceFile.installRecord";
  appliedAtMs: number;
  updatedAtMs: number;
};

export type ClawApplyPlan = {
  schemaVersion: ClawApplyPlanSchemaVersion;
  dryRun: true;
  mutationAllowed: false;
  claw: ClawPlan["claw"];
  summary: {
    totalEntries: number;
    installActions: number;
    consentRequired: number;
    blockedEntries: number;
    provenanceRecords: number;
    rollbackActions: number;
  };
  entries: ClawApplyPlanEntry[];
  diagnostics: ClawDiagnostic[];
};
