// Tests for the grouped Claw manifest and read-only add plan.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildClawAddPlan } from "./lifecycle.js";
import { readClawManifestFile } from "./reader.js";
import { parseClawManifest } from "./schema.js";
import type { ClawManifest, ClawSourceIdentity } from "./types.js";

const baseManifest = {
  schemaVersion: 1,
  agent: {
    id: "github-triage",
    name: "GitHub Triage",
    description: "Reviews incoming issues.",
    identity: { name: "Triage", emoji: "search" },
    groupChat: { mentionPatterns: ["@triage"] },
    sandbox: { mode: "all", scope: "agent", workspaceAccess: "rw" },
    tools: { allow: ["read", "write"], deny: ["exec"] },
    heartbeat: { every: "30m", lightContext: true, skipWhenBusy: true },
    humanDelay: { mode: "natural" },
  },
  workspace: {
    bootstrapFiles: {
      "AGENTS.md": { source: "workspace/AGENTS.md" },
    },
    files: [{ source: "workspace/reference/policy.md", path: "reference/policy.md" }],
  },
  packages: [
    { kind: "skill", source: "clawhub", ref: "@acme/triage", version: "1.2.0" },
    { kind: "plugin", source: "clawhub", ref: "@acme/github", version: "2.0.1" },
  ],
  mcpServers: {
    github: {
      command: "npx",
      args: ["-y", "@acme/github-mcp"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
      toolFilter: { include: ["issues_list"], exclude: ["repository_delete"] },
      timeout: 30,
    },
  },
  cronJobs: [
    {
      id: "weekday-triage",
      name: "Weekday triage",
      schedule: { cron: "0 9 * * 1-5", timezone: "America/New_York" },
      session: "isolated",
      message: "Review new issues.",
      delivery: { mode: "announce", channel: "last" },
    },
  ],
} as const;

function requireManifest(value: unknown = baseManifest): ClawManifest {
  const result = parseClawManifest(value);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result.manifest;
}

async function createPlanSource(): Promise<{ source: ClawSourceIdentity; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "openclaw-claw-plan-"));
  await mkdir(join(root, "workspace", "reference"), { recursive: true });
  await writeFile(join(root, "workspace", "AGENTS.md"), "# Agent\n", "utf8");
  await writeFile(join(root, "workspace", "reference", "policy.md"), "Policy\n", "utf8");
  return {
    source: {
      kind: "package",
      name: "@acme/github-triage",
      version: "1.0.0",
      packageRoot: root,
      manifestPath: join(root, "openclaw.claw.json"),
      integrity: "sha256:test",
    },
    workspace: join(root, "new-workspace"),
  };
}

describe("parseClawManifest", () => {
  it("parses the grouped portable contract", () => {
    const manifest = requireManifest();

    expect(manifest.agent.id).toBe("github-triage");
    expect(manifest.workspace.files).toHaveLength(1);
    expect(manifest.packages.map((pkg) => pkg.kind)).toEqual(["skill", "plugin"]);
    expect(Object.keys(manifest.mcpServers)).toEqual(["github"]);
    expect(manifest.cronJobs[0]?.id).toBe("weekday-triage");
  });

  it("defaults optional ownership groups without inventing agent settings", () => {
    const manifest = requireManifest({ schemaVersion: 1, agent: { id: "minimal-agent" } });

    expect(manifest).toEqual({
      schemaVersion: 1,
      agent: { id: "minimal-agent" },
      workspace: { bootstrapFiles: {}, files: [] },
      packages: [],
      mcpServers: {},
      cronJobs: [],
    });
  });

  it("rejects the prototype flat entries contract", () => {
    const result = parseClawManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "old-claw",
      entries: [{ kind: "skill", id: "demo", required: false }],
    });

    expect(result.ok).toBe(false);
  });

  it.each(["model", "provider", "skills", "runtime", "bindings", "auth"])(
    "rejects operator-controlled agent field %s",
    (field) => {
      const result = parseClawManifest({
        schemaVersion: 1,
        agent: { id: "unsafe-agent", [field]: field === "skills" ? ["demo"] : "value" },
      });

      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "invalid_manifest", path: "$.agent" }),
      );
    },
  );

  it("rejects required flags and connector packages", () => {
    const connector = parseClawManifest({
      ...baseManifest,
      packages: [{ kind: "connector", source: "clawhub", ref: "@acme/chat", version: "1.0.0" }],
    });
    expect(connector.ok).toBe(false);
    expect(connector.diagnostics[0]?.path).toBe("$.packages[0].kind");

    const required = parseClawManifest({
      ...baseManifest,
      packages: [{ ...baseManifest.packages[0], required: false }],
    });
    expect(required.ok).toBe(false);
    expect(required.diagnostics[0]?.path).toBe("$.packages[0]");
  });

  it("requires exact package versions", () => {
    const result = parseClawManifest({
      ...baseManifest,
      packages: [{ kind: "skill", source: "clawhub", ref: "demo", version: "latest" }],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.path).toBe("$.packages[0].version");
  });

  it("rejects resolved MCP secrets", () => {
    const result = parseClawManifest({
      ...baseManifest,
      mcpServers: {
        github: { command: "npx", env: { GITHUB_TOKEN: "secret-value" } },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.path).toBe("$.mcpServers.github.env.GITHUB_TOKEN");
  });

  it("rejects workspace traversal and duplicate destinations", () => {
    const traversal = parseClawManifest({
      ...baseManifest,
      workspace: { files: [{ source: "../outside", path: "inside.md" }] },
    });
    expect(traversal.ok).toBe(false);

    const duplicate = parseClawManifest({
      ...baseManifest,
      workspace: {
        bootstrapFiles: { "AGENTS.md": { source: "workspace/AGENTS.md" } },
        files: [{ source: "workspace/other.md", path: "AGENTS.md" }],
      },
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.workspace.files[0].path" }),
    );
  });

  it("rejects duplicate packages and cron ids", () => {
    const duplicatePackage = parseClawManifest({
      ...baseManifest,
      packages: [baseManifest.packages[0], baseManifest.packages[0]],
    });
    expect(duplicatePackage.ok).toBe(false);

    const duplicateCron = parseClawManifest({
      ...baseManifest,
      cronJobs: [baseManifest.cronJobs[0], baseManifest.cronJobs[0]],
    });
    expect(duplicateCron.ok).toBe(false);
  });

  it("rejects invalid heartbeat durations and cron expressions", () => {
    const heartbeat = parseClawManifest({
      ...baseManifest,
      agent: { ...baseManifest.agent, heartbeat: { every: "eventually" } },
    });
    expect(heartbeat.ok).toBe(false);
    expect(heartbeat.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.agent.heartbeat.every" }),
    );

    const cron = parseClawManifest({
      ...baseManifest,
      cronJobs: [{ ...baseManifest.cronJobs[0], schedule: { cron: "not a cron expression" } }],
    });
    expect(cron.ok).toBe(false);
    expect(cron.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.cronJobs[0].schedule.cron" }),
    );
  });
});

describe("readClawManifestFile", () => {
  it("takes published identity from package.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-claw-package-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/github-triage",
        version: "3.2.1",
        openclaw: { claw: "openclaw.claw.json" },
      }),
      "utf8",
    );
    await writeFile(
      join(root, "openclaw.claw.json"),
      JSON.stringify({ schemaVersion: 1, agent: { id: "triage" } }),
      "utf8",
    );

    const result = await readClawManifestFile(root);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected package to parse");
    }
    expect(result.source).toMatchObject({
      kind: "package",
      name: "@acme/github-triage",
      version: "3.2.1",
    });
    expect(result.source.integrity).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("synthesizes explicit development identity for a standalone manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-claw-development-"));
    const path = join(root, "demo.claw.json");
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, agent: { id: "demo-agent" } }),
      "utf8",
    );

    const result = await readClawManifestFile(path);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected development manifest to parse");
    }
    expect(result.source).toMatchObject({
      kind: "development",
      name: "local:demo.claw",
      version: "0.0.0-development",
    });
  });

  it("rejects package manifests that escape the package root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openclaw-claw-escape-"));
    const root = join(parent, "package");
    await mkdir(root);
    await writeFile(
      join(parent, "outside.json"),
      JSON.stringify({ schemaVersion: 1, agent: { id: "outside" } }),
      "utf8",
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/escape",
        version: "1.0.0",
        openclaw: { claw: "../outside.json" },
      }),
      "utf8",
    );

    const result = await readClawManifestFile(root);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "manifest_escapes_package" }),
    );
  });
});

describe("buildClawAddPlan", () => {
  it("plans one new agent, workspace, packages, MCP servers, and agent-pinned cron jobs", async () => {
    const { source, workspace } = await createPlanSource();
    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: { workspace },
    });

    expect(plan).toMatchObject({
      schemaVersion: "openclaw.clawAddPlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      agent: { requestedId: "github-triage", finalId: "github-triage", workspace },
      summary: {
        totalActions: 8,
        agentActions: 1,
        workspaceActions: 3,
        packageActions: 2,
        mcpServerActions: 1,
        cronJobActions: 1,
        blockedActions: 0,
      },
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "workspaceFile",
        id: "AGENTS.md",
        digest: expect.stringMatching(/^sha256:/),
      }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "cronJob",
        id: "weekday-triage",
        target: "cron:weekday-triage:agent=github-triage",
      }),
    );
  });

  it("blocks agent, configured workspace, MCP, and cron collisions", async () => {
    const { source, workspace } = await createPlanSource();
    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: {
        workspace,
        existingAgentIds: ["github-triage"],
        existingWorkspacePaths: [workspace],
        existingMcpServerNames: ["github"],
        existingCronJobIds: ["weekday-triage"],
      },
    });

    expect(plan.blockers.map((item) => item.code)).toEqual([
      "agent_id_collision",
      "workspace_collision",
      "mcp_server_collision",
      "cron_job_collision",
    ]);
    expect(plan.summary.blockedActions).toBe(6);
  });

  it("uses an explicit unused agent id for every derived action", async () => {
    const { source, workspace } = await createPlanSource();
    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: { agentId: "triage-two", workspace },
    });

    expect(plan.agent.finalId).toBe("triage-two");
    expect(plan.actions.find((action) => action.kind === "agent")?.id).toBe("triage-two");
    expect(plan.actions.find((action) => action.kind === "cronJob")?.target).toContain(
      "agent=triage-two",
    );
  });
});
