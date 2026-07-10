// Applies the agent, workspace, and managed-file slice of a consented Claw add plan.
import { mkdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { transformConfigFileWithRetry } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import { ClawPackageInstallError, installClawPackages } from "./packages.js";
import { persistClawInstallRecord, type PersistedClawInstall } from "./provenance.js";
import type { PersistedClawPackageRef } from "./provenance.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan } from "./types.js";
import {
  ClawWorkspaceWriteError,
  createClawWorkspaceFiles,
  type PersistedClawWorkspaceFile,
} from "./workspace.js";

export const CLAW_ADD_RESULT_SCHEMA_VERSION = "openclaw.clawAddResult.v1" as const;

type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;

export class ClawAddMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawAddMutationError";
  }
}

export type ClawAddResult = {
  schemaVersion: typeof CLAW_ADD_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  mutationAllowed: true;
  status: "complete" | "partial";
  claw: ClawAddPlan["claw"];
  agent: ClawAddPlan["agent"];
  workspaceCreated: boolean;
  configCommitted: boolean;
  workspaceFiles: PersistedClawWorkspaceFile[];
  packages: PersistedClawPackageRef[];
  installRecord?: PersistedClawInstall;
  error?: {
    code: string;
    message: string;
    diagnostics?: ClawWorkspaceWriteError["diagnostics"];
  };
};

function hasUnsupportedMutationActions(plan: ClawAddPlan): boolean {
  return plan.actions.some(
    (action) => !["agent", "workspace", "workspaceFile", "package"].includes(action.kind),
  );
}

function configHasWorkspace(config: OpenClawConfig, workspace: string): boolean {
  return (config.agents?.list ?? []).some(
    (agent) =>
      agent.workspace !== undefined &&
      resolve(resolveUserPath(agent.workspace)) === resolve(workspace),
  );
}

export async function applyClawAddPlan(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    commitConfig?: ConfigCommit;
    persistRecord?: typeof persistClawInstallRecord;
    createWorkspaceFiles?: typeof createClawWorkspaceFiles;
    installPackages?: typeof installClawPackages;
    nowMs?: number;
  } = {},
): Promise<ClawAddResult> {
  if (plan.blockers.length > 0) {
    throw new ClawAddMutationError("plan_blocked", "The Claw add plan contains blockers.");
  }
  if (hasUnsupportedMutationActions(plan)) {
    throw new ClawAddMutationError(
      "unsupported_components",
      "This build can add agent settings, workspace files, and packages; declared MCP servers or cron jobs require later lifecycle slices.",
    );
  }

  const workspace = resolve(plan.agent.workspace);
  await mkdir(dirname(workspace), { recursive: true });
  try {
    await mkdir(workspace);
  } catch (error) {
    throw new ClawAddMutationError(
      "workspace_collision",
      `Could not create new workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
    );
  }

  try {
    const commit: ConfigCommit =
      options.commitConfig ??
      (async (transform) => {
        await transformConfigFileWithRetry({
          afterWrite: { mode: "auto" },
          transform: (config) => ({ nextConfig: transform(config) }),
        });
      });
    await commit((config) => {
      const existingAgents = config.agents?.list ?? [];
      if (existingAgents.some((agent) => agent.id === plan.agent.finalId)) {
        throw new ClawAddMutationError(
          "agent_id_collision",
          `Agent ${JSON.stringify(plan.agent.finalId)} was created after planning.`,
        );
      }
      if (configHasWorkspace(config, workspace)) {
        throw new ClawAddMutationError(
          "workspace_collision",
          `Workspace ${JSON.stringify(workspace)} is already assigned to an agent.`,
        );
      }
      return {
        ...config,
        agents: {
          ...config.agents,
          list: [...existingAgents, plan.agent.config],
        },
      };
    });
  } catch (error) {
    await rmdir(workspace).catch(() => undefined);
    throw error;
  }

  const createFiles = options.createWorkspaceFiles ?? createClawWorkspaceFiles;
  let workspaceFiles: PersistedClawWorkspaceFile[] = [];
  try {
    workspaceFiles = await createFiles(plan, options);
  } catch (error) {
    const workspaceError =
      error instanceof ClawWorkspaceWriteError
        ? error
        : new ClawWorkspaceWriteError(
            [
              {
                level: "error",
                code: "workspace_file_io_error",
                path: "$.workspace",
                message: error instanceof Error ? error.message : String(error),
              },
            ],
            workspaceFiles,
          );
    const persistRecord = options.persistRecord ?? persistClawInstallRecord;
    let installRecord: PersistedClawInstall | undefined;
    let provenanceError: string | undefined;
    try {
      installRecord = persistRecord(plan, { ...options, status: "partial" });
    } catch (recordError) {
      provenanceError = recordError instanceof Error ? recordError.message : String(recordError);
    }
    return {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      mutationAllowed: true,
      status: "partial",
      claw: plan.claw,
      agent: plan.agent,
      workspaceCreated: true,
      configCommitted: true,
      workspaceFiles: workspaceError.createdFiles,
      packages: [],
      ...(installRecord ? { installRecord } : {}),
      error: {
        code: "workspace_files_failed",
        message: provenanceError
          ? `${workspaceError.message}; root provenance also failed: ${provenanceError}`
          : workspaceError.message,
        diagnostics: workspaceError.diagnostics,
      },
    };
  }

  const installPackages = options.installPackages ?? installClawPackages;
  let packages: PersistedClawPackageRef[] = [];
  try {
    packages = await installPackages(plan, options);
  } catch (error) {
    const packageError =
      error instanceof ClawPackageInstallError
        ? error
        : new ClawPackageInstallError(
            "package_install_failed",
            error instanceof Error ? error.message : String(error),
            packages,
          );
    const persistRecord = options.persistRecord ?? persistClawInstallRecord;
    let installRecord: PersistedClawInstall | undefined;
    let provenanceError: string | undefined;
    try {
      installRecord = persistRecord(plan, { ...options, status: "partial" });
    } catch (recordError) {
      provenanceError = recordError instanceof Error ? recordError.message : String(recordError);
    }
    return {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      mutationAllowed: true,
      status: "partial",
      claw: plan.claw,
      agent: plan.agent,
      workspaceCreated: true,
      configCommitted: true,
      workspaceFiles,
      packages: packageError.installedPackages,
      ...(installRecord ? { installRecord } : {}),
      error: {
        code: packageError.code,
        message: provenanceError
          ? `${packageError.message}; root provenance also failed: ${provenanceError}`
          : packageError.message,
      },
    };
  }

  try {
    const persistRecord = options.persistRecord ?? persistClawInstallRecord;
    const installRecord = persistRecord(plan, options);
    return {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      mutationAllowed: true,
      status: "complete",
      claw: plan.claw,
      agent: plan.agent,
      workspaceCreated: true,
      configCommitted: true,
      workspaceFiles,
      packages,
      installRecord,
    };
  } catch (error) {
    return {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      mutationAllowed: true,
      status: "partial",
      claw: plan.claw,
      agent: plan.agent,
      workspaceCreated: true,
      configCommitted: true,
      workspaceFiles,
      packages,
      error: { code: "provenance_failed", message: (error as Error).message },
    };
  }
}
