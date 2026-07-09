// Claw doctor diagnostics report drift in persisted Claw lifecycle state.
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { canonicalizeConfiguredMcpServer } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { readClawStatus } from "./lifecycle-state.js";
import type { PersistedClawArtifactRef } from "./provenance.js";
import type { PersistedClawWorkspaceFileRef } from "./types.js";

const CLAW_STATE_CHECK_ID = "core/doctor/claws-state";
const MAX_DOCTOR_WORKSPACE_FILE_BYTES = 1024 * 1024;

export type ClawDoctorOptions = OpenClawStateDatabaseOptions & {
  cfg?: OpenClawConfig;
};

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function finding(params: {
  severity: HealthFinding["severity"];
  message: string;
  path?: string;
  target?: string;
  requirement?: string;
  fixHint?: string;
}): HealthFinding {
  return {
    checkId: CLAW_STATE_CHECK_ID,
    source: "doctor",
    ...params,
  };
}

function artifactPath(ref: PersistedClawArtifactRef): string {
  return `claws.${ref.clawId}.entries.${ref.entryId}`;
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

function inlineMcpSelectorLabel(server: Record<string, unknown>): string {
  const digest = sha256(Buffer.from(stableJson(canonicalizeConfiguredMcpServer(server))));
  return `inline:sha256:${digest}`;
}

function workspacePath(ref: PersistedClawWorkspaceFileRef): string {
  return `claws.${ref.clawId}.workspace.${ref.entryId}`;
}

function collectArtifactFindings(
  ref: PersistedClawArtifactRef,
  cfg: OpenClawConfig | undefined,
): HealthFinding[] {
  if (ref.installSurface === "connectors" || ref.kind === "connector") {
    return [
      finding({
        severity: "warning",
        message:
          "Claw connector provenance exists, but OpenClaw has no stable connector setup path for Claws yet.",
        path: artifactPath(ref),
        target: ref.artifactKey,
        requirement: "connector entries require a stable OpenClaw connector setup/install surface",
        fixHint:
          "Inspect the Claw and configure this connector through its normal OpenClaw owner surface.",
      }),
    ];
  }

  if (ref.installSurface !== "mcpServers") {
    return [];
  }

  const server = cfg?.mcp?.servers?.[ref.entryId];
  if (!server) {
    return [
      finding({
        severity: "warning",
        message: `Claw-managed MCP server "${ref.entryId}" is no longer configured.`,
        path: `mcp.servers.${ref.entryId}`,
        target: ref.artifactKey,
        requirement: "applied Claw MCP server refs should have matching mcp.servers config",
        fixHint:
          "Re-apply the Claw or remove the Claw state after confirming the MCP server is no longer needed.",
      }),
    ];
  }
  if (server.enabled === false) {
    return [
      finding({
        severity: "warning",
        message: `Claw-managed MCP server "${ref.entryId}" is configured but disabled.`,
        path: `mcp.servers.${ref.entryId}.enabled`,
        target: ref.artifactKey,
        requirement: "applied Claw MCP server refs should remain enabled or be removed intentionally",
        fixHint:
          "Enable the MCP server, or remove the Claw if this starter setup should no longer own it.",
      }),
    ];
  }
  if (ref.source === "inline" && inlineMcpSelectorLabel(server) !== ref.selector) {
    return [
      finding({
        severity: "warning",
        message: `Claw-managed MCP server "${ref.entryId}" no longer matches the applied Claw config.`,
        path: `mcp.servers.${ref.entryId}`,
        target: ref.artifactKey,
        requirement: "applied inline Claw MCP server refs should match their recorded config digest",
        fixHint: "Re-apply the Claw or inspect the local MCP config change before removing the Claw ref.",
      }),
    ];
  }
  return [];
}

async function collectWorkspaceFileFindings(
  ref: PersistedClawWorkspaceFileRef,
): Promise<HealthFinding[]> {
  let stat;
  try {
    stat = await lstat(ref.targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [
        finding({
          severity: "warning",
          message: `Claw-managed workspace file is missing: ${ref.targetPath}`,
          path: workspacePath(ref),
          target: ref.targetPath,
          requirement: "Claw workspace refs should point at the file written during apply",
          fixHint:
            "Re-apply the Claw, restore the file, or run `openclaw claws remove` for this Claw.",
        }),
      ];
    }
    return [
      finding({
        severity: "warning",
        message: `Could not inspect Claw-managed workspace file: ${String(error)}`,
        path: workspacePath(ref),
        target: ref.targetPath,
        requirement: "Claw workspace refs should be readable by doctor",
      }),
    ];
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    return [
      finding({
        severity: "warning",
        message: `Claw-managed workspace target is not a regular file: ${ref.targetPath}`,
        path: workspacePath(ref),
        target: ref.targetPath,
        requirement: "Claw workspace refs should point at regular files",
        fixHint: "Inspect the target before re-applying or removing the Claw.",
      }),
    ];
  }

  if (stat.size > MAX_DOCTOR_WORKSPACE_FILE_BYTES) {
    return [
      finding({
        severity: "warning",
        message: `Claw-managed workspace file is larger than the doctor hash cap: ${ref.targetPath}`,
        path: workspacePath(ref),
        target: ref.targetPath,
        requirement: "Claw workspace drift checks hash files up to 1 MiB",
        fixHint: "Inspect the file manually before re-applying or removing the Claw.",
      }),
    ];
  }

  let content: Buffer;
  try {
    content = await readFile(ref.targetPath);
  } catch (error) {
    return [
      finding({
        severity: "warning",
        message: `Could not read Claw-managed workspace file: ${String(error)}`,
        path: workspacePath(ref),
        target: ref.targetPath,
        requirement: "Claw workspace refs should be readable by doctor",
      }),
    ];
  }
  if (sha256(content) !== ref.contentSha256) {
    return [
      finding({
        severity: "warning",
        message: `Claw-managed workspace file has changed since apply: ${ref.targetPath}`,
        path: workspacePath(ref),
        target: ref.targetPath,
        requirement: "Claw workspace refs should match their recorded managed-content hash",
        fixHint:
          "Keep the local edit, re-apply the Claw, or run `openclaw claws remove` to release the ref.",
      }),
    ];
  }
  return [];
}

export async function collectClawStateHealthFindings(
  options: ClawDoctorOptions = {},
): Promise<readonly HealthFinding[]> {
  const status = readClawStatus(undefined, options);
  const findings: HealthFinding[] = [];
  for (const record of status.records) {
    if (
      record.appliedAtMs === undefined &&
      (record.artifacts.length > 0 || record.workspaceFiles.length > 0)
    ) {
      findings.push(
        finding({
          severity: "warning",
          message: `Claw "${record.clawId}" has provenance refs but no apply record.`,
          path: `claws.${record.clawId}`,
          target: record.clawId,
          requirement: "Claw refs should have a matching claw_apply_records row",
          fixHint:
            "Inspect the state database and remove stale Claw state only after confirming ownership.",
        }),
      );
    }
    for (const ref of record.artifacts) {
      findings.push(...collectArtifactFindings(ref, options.cfg));
    }
    for (const ref of record.workspaceFiles) {
      findings.push(...(await collectWorkspaceFileFindings(ref)));
    }
  }
  return findings;
}
