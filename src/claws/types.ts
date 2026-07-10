// Shared types for grouped OpenClaw Claw manifests and read-only add plans.

export const CLAW_SCHEMA_VERSION = 1 as const;
export const CLAW_ADD_PLAN_SCHEMA_VERSION = "openclaw.clawAddPlan.v1" as const;
export const CLAW_INSPECT_RESULT_SCHEMA_VERSION = "openclaw.clawInspect.v1" as const;
export const CLAW_FEED_SCHEMA_VERSION = "openclaw.clawFeed.v1" as const;
export const CLAW_OUTPUT_STABILITY = "experimental" as const;

export type ClawDiagnosticLevel = "error" | "warning";

export type ClawDiagnostic = {
  level: ClawDiagnosticLevel;
  code: string;
  path: string;
  message: string;
};

export type ClawAgent = {
  id: string;
  name?: string;
  description?: string;
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
  };
  groupChat?: {
    mentionPatterns?: string[];
  };
  sandbox?: {
    mode?: "off" | "non-main" | "all";
    scope?: "session" | "agent" | "shared";
    workspaceAccess?: "none" | "ro" | "rw";
  };
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  heartbeat?: {
    every?: string;
    activeHours?: {
      start?: string;
      end?: string;
      timezone?: string;
    };
    lightContext?: boolean;
    isolatedSession?: boolean;
    skipWhenBusy?: boolean;
    timeoutSeconds?: number;
  };
  humanDelay?: {
    mode?: "off" | "natural" | "custom";
    minMs?: number;
    maxMs?: number;
  };
};

export const CLAW_BOOTSTRAP_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
] as const;

export type ClawBootstrapFileName = (typeof CLAW_BOOTSTRAP_FILE_NAMES)[number];

export type ClawWorkspaceFile = {
  source: string;
  path: string;
};

export type ClawWorkspace = {
  bootstrapFiles: Partial<Record<ClawBootstrapFileName, { source: string }>>;
  files: ClawWorkspaceFile[];
};

export type ClawPackage = {
  kind: "skill" | "plugin";
  source: "clawhub";
  ref: string;
  version: string;
};

export type ClawMcpServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  toolFilter?: {
    include?: string[];
    exclude?: string[];
  };
  timeout?: number;
  connectTimeout?: number;
};

export type ClawCronJob = {
  id: string;
  name?: string;
  schedule: {
    cron: string;
    timezone?: string;
  };
  session: "main" | "isolated" | "current";
  message: string;
  delivery?: {
    mode: "none" | "announce";
    channel?: "last";
  };
};

export type ClawManifest = {
  schemaVersion: typeof CLAW_SCHEMA_VERSION;
  agent: ClawAgent;
  workspace: ClawWorkspace;
  packages: ClawPackage[];
  mcpServers: Record<string, ClawMcpServer>;
  cronJobs: ClawCronJob[];
};

export type ClawSourceIdentity = {
  kind: "package" | "development";
  name: string;
  version: string;
  packageRoot: string;
  manifestPath: string;
  integrity: string;
};

export type ClawReadResult =
  | {
      ok: true;
      manifest: ClawManifest;
      source: ClawSourceIdentity;
      diagnostics: ClawDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: ClawDiagnostic[];
    };

export type ClawAddPlanAction = {
  kind: "agent" | "workspace" | "workspaceFile" | "package" | "mcpServer" | "cronJob";
  id: string;
  action: "create" | "write" | "install" | "configure" | "schedule";
  target: string;
  source?: string;
  digest?: string;
  details?: Record<string, unknown>;
  blocked: boolean;
  reason?: string;
};

export type ClawAddPlan = {
  schemaVersion: typeof CLAW_ADD_PLAN_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: true;
  mutationAllowed: false;
  claw: ClawSourceIdentity;
  agent: {
    requestedId: string;
    finalId: string;
    workspace: string;
    config: ClawAgent & { workspace: string };
  };
  summary: {
    totalActions: number;
    agentActions: number;
    workspaceActions: number;
    packageActions: number;
    mcpServerActions: number;
    cronJobActions: number;
    blockedActions: number;
  };
  actions: ClawAddPlanAction[];
  blockers: ClawDiagnostic[];
  diagnostics: ClawDiagnostic[];
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
  trust?: { level: ClawFeedTrustLevel };
};

export type ClawFeed = {
  schemaVersion: typeof CLAW_FEED_SCHEMA_VERSION;
  id: string;
  name: string;
  publisher?: string;
  description?: string;
  generatedAt?: string;
  entries: ClawFeedEntry[];
};

export type ClawFeedReadResult =
  | { ok: true; feed: ClawFeed; diagnostics: ClawDiagnostic[] }
  | { ok: false; diagnostics: ClawDiagnostic[] };

export type ClawFeedManifestReadResult =
  | {
      ok: true;
      feed: ClawFeed;
      entry: ClawFeedEntry;
      manifest: ClawManifest;
      source: ClawSourceIdentity;
      manifestPath: string;
      diagnostics: ClawDiagnostic[];
    }
  | { ok: false; diagnostics: ClawDiagnostic[] };
