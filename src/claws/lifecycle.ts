// Builds complete read-only Claw add plans without mutating local state.
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { resolveUserPath } from "../utils.js";
import {
  CLAW_ADD_PLAN_SCHEMA_VERSION,
  CLAW_BOOTSTRAP_FILE_NAMES,
  CLAW_OUTPUT_STABILITY,
  type ClawAddPlan,
  type ClawAddPlanAction,
  type ClawDiagnostic,
  type ClawManifest,
  type ClawSourceIdentity,
} from "./types.js";

const MAX_MANAGED_FILE_BYTES = 1024 * 1024;
const AGENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export type ClawAddPlanContext = {
  agentId?: string;
  workspace?: string;
  existingAgentIds?: Iterable<string>;
  existingWorkspacePaths?: Iterable<string>;
  existingMcpServerNames?: Iterable<string>;
  existingCronJobIds?: Iterable<string>;
};

function blocker(code: string, path: string, message: string): ClawDiagnostic {
  return { level: "error", code, path, message };
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function fileAction(params: {
  source: ClawSourceIdentity;
  workspace: string;
  sourcePath: string;
  targetPath: string;
  id: string;
  manifestPath: string;
}): Promise<{ action: ClawAddPlanAction; blocker?: ClawDiagnostic }> {
  const requestedSource = resolve(params.source.packageRoot, params.sourcePath);
  const requestedTarget = resolve(params.workspace, params.targetPath);
  const sourceRealPath = await realpath(requestedSource).catch(() => undefined);
  if (!sourceRealPath || !isContained(params.source.packageRoot, sourceRealPath)) {
    const diagnostic = blocker(
      "workspace_source_invalid",
      params.manifestPath,
      `Workspace source ${JSON.stringify(params.sourcePath)} must resolve to a file inside the Claw package.`,
    );
    return {
      action: {
        kind: "workspaceFile",
        id: params.id,
        action: "write",
        target: requestedTarget,
        source: requestedSource,
        blocked: true,
        reason: diagnostic.message,
      },
      blocker: diagnostic,
    };
  }
  const [sourceStat, sourceLinkStat] = await Promise.all([
    stat(sourceRealPath),
    lstat(requestedSource),
  ]);
  if (!sourceStat.isFile() || sourceLinkStat.isSymbolicLink() || sourceStat.nlink > 1) {
    const diagnostic = blocker(
      "workspace_source_unsafe",
      params.manifestPath,
      `Workspace source ${JSON.stringify(params.sourcePath)} must be a regular, non-symlinked, non-hardlinked file.`,
    );
    return {
      action: {
        kind: "workspaceFile",
        id: params.id,
        action: "write",
        target: requestedTarget,
        source: sourceRealPath,
        blocked: true,
        reason: diagnostic.message,
      },
      blocker: diagnostic,
    };
  }
  if (sourceStat.size > MAX_MANAGED_FILE_BYTES) {
    const diagnostic = blocker(
      "workspace_source_too_large",
      params.manifestPath,
      `Workspace source ${JSON.stringify(params.sourcePath)} exceeds ${MAX_MANAGED_FILE_BYTES} bytes.`,
    );
    return {
      action: {
        kind: "workspaceFile",
        id: params.id,
        action: "write",
        target: requestedTarget,
        source: sourceRealPath,
        blocked: true,
        reason: diagnostic.message,
      },
      blocker: diagnostic,
    };
  }
  const content = await readFile(sourceRealPath);
  return {
    action: {
      kind: "workspaceFile",
      id: params.id,
      action: "write",
      target: requestedTarget,
      source: sourceRealPath,
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      blocked: false,
    },
  };
}

export async function buildClawAddPlan(params: {
  manifest: ClawManifest;
  source: ClawSourceIdentity;
  diagnostics?: ClawDiagnostic[];
  context?: ClawAddPlanContext;
}): Promise<ClawAddPlan> {
  const context = params.context ?? {};
  const finalId = context.agentId ?? params.manifest.agent.id;
  const workspace = resolve(
    context.workspace ?? resolve(homedir(), ".openclaw", `workspace-${finalId}`),
  );
  const blockers: ClawDiagnostic[] = [];
  const actions: ClawAddPlanAction[] = [];

  if (!AGENT_ID_PATTERN.test(finalId)) {
    blockers.push(
      blocker(
        "invalid_agent_id",
        "$.agent.id",
        `Final agent id ${JSON.stringify(finalId)} is not a valid portable agent id.`,
      ),
    );
  }
  const existingAgentIds = new Set(context.existingAgentIds ?? []);
  const agentBlocked = existingAgentIds.has(finalId);
  if (agentBlocked) {
    blockers.push(
      blocker(
        "agent_id_collision",
        "$.agent.id",
        `Agent id ${JSON.stringify(finalId)} already exists; Claws never merge into existing agents.`,
      ),
    );
  }
  actions.push({
    kind: "agent",
    id: finalId,
    action: "create",
    target: `agents.list[${JSON.stringify(finalId)}]`,
    details: { ...params.manifest.agent, id: finalId, workspace },
    blocked: agentBlocked || !AGENT_ID_PATTERN.test(finalId),
  });

  const configuredWorkspacePaths = new Set(
    [...(context.existingWorkspacePaths ?? [])].map((path) => resolve(resolveUserPath(path))),
  );
  const workspaceExists =
    configuredWorkspacePaths.has(workspace) ||
    (await lstat(workspace)
      .then(() => true)
      .catch(() => false));
  if (workspaceExists) {
    blockers.push(
      blocker(
        "workspace_collision",
        "$.workspace",
        `Workspace ${JSON.stringify(workspace)} already exists; a Claw requires a new workspace.`,
      ),
    );
  }
  actions.push({
    kind: "workspace",
    id: finalId,
    action: "create",
    target: workspace,
    blocked: workspaceExists,
    ...(workspaceExists
      ? { reason: `Workspace ${JSON.stringify(workspace)} already exists.` }
      : {}),
  });

  for (const name of CLAW_BOOTSTRAP_FILE_NAMES) {
    const declaration = params.manifest.workspace.bootstrapFiles[name];
    if (!declaration) {
      continue;
    }
    const result = await fileAction({
      source: params.source,
      workspace,
      sourcePath: declaration.source,
      targetPath: name,
      id: name,
      manifestPath: `$.workspace.bootstrapFiles.${name}`,
    });
    result.action.blocked ||= workspaceExists;
    if (workspaceExists) {
      result.action.reason = `Workspace ${JSON.stringify(workspace)} already exists.`;
    }
    actions.push(result.action);
    if (result.blocker) {
      blockers.push(result.blocker);
    }
  }
  for (const [index, file] of params.manifest.workspace.files.entries()) {
    const result = await fileAction({
      source: params.source,
      workspace,
      sourcePath: file.source,
      targetPath: file.path,
      id: file.path,
      manifestPath: `$.workspace.files[${index}]`,
    });
    result.action.blocked ||= workspaceExists;
    if (workspaceExists) {
      result.action.reason = `Workspace ${JSON.stringify(workspace)} already exists.`;
    }
    actions.push(result.action);
    if (result.blocker) {
      blockers.push(result.blocker);
    }
  }

  for (const pkg of params.manifest.packages) {
    actions.push({
      kind: "package",
      id: `${pkg.kind}:${pkg.ref}`,
      action: "install",
      target: `${pkg.source}:${pkg.ref}@${pkg.version}`,
      details: { ...pkg },
      blocked: false,
    });
  }

  const existingMcpServerNames = new Set(context.existingMcpServerNames ?? []);
  for (const name of Object.keys(params.manifest.mcpServers)) {
    const server = params.manifest.mcpServers[name];
    const blocked = existingMcpServerNames.has(name);
    if (blocked) {
      blockers.push(
        blocker(
          "mcp_server_collision",
          `$.mcpServers.${name}`,
          `MCP server ${JSON.stringify(name)} already exists and will not be overwritten.`,
        ),
      );
    }
    actions.push({
      kind: "mcpServer",
      id: name,
      action: "configure",
      target: `mcp.servers.${name}`,
      details: { ...server },
      blocked,
    });
  }

  const existingCronJobIds = new Set(context.existingCronJobIds ?? []);
  for (const job of params.manifest.cronJobs) {
    const blocked = existingCronJobIds.has(job.id);
    if (blocked) {
      blockers.push(
        blocker(
          "cron_job_collision",
          `$.cronJobs.${job.id}`,
          `Cron job ${JSON.stringify(job.id)} already exists and will not be overwritten.`,
        ),
      );
    }
    actions.push({
      kind: "cronJob",
      id: job.id,
      action: "schedule",
      target: `cron:${job.id}:agent=${finalId}`,
      details: { ...job, agentId: finalId },
      blocked,
    });
  }

  return {
    schemaVersion: CLAW_ADD_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    claw: params.source,
    agent: {
      requestedId: params.manifest.agent.id,
      finalId,
      workspace,
      config: { ...params.manifest.agent, id: finalId, workspace },
    },
    summary: {
      totalActions: actions.length,
      agentActions: actions.filter((action) => action.kind === "agent").length,
      workspaceActions: actions.filter(
        (action) => action.kind === "workspace" || action.kind === "workspaceFile",
      ).length,
      packageActions: actions.filter((action) => action.kind === "package").length,
      mcpServerActions: actions.filter((action) => action.kind === "mcpServer").length,
      cronJobActions: actions.filter((action) => action.kind === "cronJob").length,
      blockedActions: actions.filter((action) => action.blocked).length,
    },
    actions,
    blockers,
    diagnostics: params.diagnostics ?? [],
  };
}
