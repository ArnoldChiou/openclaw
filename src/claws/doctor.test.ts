// Tests for Claw doctor diagnostics.
import { mkdtempSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { collectClawStateHealthFindings } from "./doctor.js";
import { buildClawApplyPlan } from "./lifecycle.js";
import { buildClawPlan } from "./plan.js";
import { persistClawArtifactApplyProvenance } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import { applyClawWorkspaceFiles } from "./workspace.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function stateEnv() {
  return { OPENCLAW_STATE_DIR: tempDir("openclaw-claw-doctor-") };
}

function applyPlan(params: { entries: unknown[]; manifestRoot?: string }) {
  const manifestRoot = params.manifestRoot ?? tempDir("openclaw-claw-doctor-manifest-");
  const parsed = parseClawManifest({
    schemaVersion: "openclaw.claw.v1",
    id: "starter",
    name: "Starter",
    version: "1.0.0",
    entries: params.entries,
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error("expected manifest to parse");
  }
  return buildClawApplyPlan(
    buildClawPlan({ manifest: parsed.manifest, sourcePath: join(manifestRoot, "claw.json") }),
  );
}

async function writeSource(root: string, relativePath: string, contents: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("collectClawStateHealthFindings", () => {
  it("reports missing and modified Claw-managed workspace files", async () => {
    const env = stateEnv();
    const manifestRoot = tempDir("openclaw-claw-doctor-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-doctor-workspace-");
    await writeSource(manifestRoot, "files/A.md", "a\n");
    await writeSource(manifestRoot, "files/B.md", "b\n");
    const plan = applyPlan({
      manifestRoot,
      entries: [
        { kind: "workspaceFile", id: "a", path: "A.md", source: "files/A.md" },
        { kind: "workspaceFile", id: "b", path: "B.md", source: "files/B.md" },
      ],
    });
    await applyClawWorkspaceFiles(plan, { env, workspaceRoot, nowMs: 1 });
    await rm(join(workspaceRoot, "A.md"));
    await writeFile(join(workspaceRoot, "B.md"), "user edit\n", "utf8");

    const findings = await collectClawStateHealthFindings({ env });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "core/doctor/claws-state",
          message: expect.stringContaining("is missing"),
          path: "claws.starter.workspace.a",
        }),
        expect.objectContaining({
          message: expect.stringContaining("has changed since apply"),
          path: "claws.starter.workspace.b",
        }),
      ]),
    );
  });

  it("reports unsafe workspace targets", async () => {
    const env = stateEnv();
    const manifestRoot = tempDir("openclaw-claw-doctor-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-doctor-workspace-");
    await writeSource(manifestRoot, "files/SOUL.md", "managed\n");
    const plan = applyPlan({
      manifestRoot,
      entries: [
        { kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" },
      ],
    });
    await applyClawWorkspaceFiles(plan, { env, workspaceRoot, nowMs: 1 });
    await rm(join(workspaceRoot, "SOUL.md"));
    await symlink(join(workspaceRoot, "elsewhere.md"), join(workspaceRoot, "SOUL.md"));

    const findings = await collectClawStateHealthFindings({ env });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("is not a regular file"),
          target: join(workspaceRoot, "SOUL.md"),
        }),
      ]),
    );
  });

  it("reports Claw MCP refs that no longer have matching config", async () => {
    const env = stateEnv();
    const plan = applyPlan({
      entries: [
        {
          kind: "mcpServer",
          id: "docs",
          selector: JSON.stringify({ command: "uvx", args: ["docs-mcp"] }),
        },
      ],
    });
    persistClawArtifactApplyProvenance(plan, { env, nowMs: 1 });

    const findings = await collectClawStateHealthFindings({ cfg: {}, env });

    expect(findings).toEqual([
      expect.objectContaining({
        message: 'Claw-managed MCP server "docs" is no longer configured.',
        path: "mcp.servers.docs",
      }),
    ]);
  });

  it("reports changed inline MCP config for Claw MCP refs", async () => {
    const env = stateEnv();
    const plan = applyPlan({
      entries: [
        {
          kind: "mcpServer",
          id: "docs",
          selector: JSON.stringify({ command: "uvx", args: ["docs-mcp"] }),
        },
      ],
    });
    persistClawArtifactApplyProvenance(plan, { env, nowMs: 1 });

    const findings = await collectClawStateHealthFindings({
      cfg: { mcp: { servers: { docs: { command: "node", args: ["other-server.mjs"] } } } },
      env,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        message: 'Claw-managed MCP server "docs" no longer matches the applied Claw config.',
        path: "mcp.servers.docs",
      }),
    ]);
  });

  it("reports disabled Claw MCP refs", async () => {
    const env = stateEnv();
    const plan = applyPlan({
      entries: [
        {
          kind: "mcpServer",
          id: "docs",
          selector: JSON.stringify({ command: "uvx", args: ["docs-mcp"] }),
        },
      ],
    });
    persistClawArtifactApplyProvenance(plan, { env, nowMs: 1 });

    const findings = await collectClawStateHealthFindings({
      cfg: { mcp: { servers: { docs: { command: "uvx", enabled: false } } } },
      env,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        message: 'Claw-managed MCP server "docs" is configured but disabled.',
        path: "mcp.servers.docs.enabled",
      }),
    ]);
  });

  it("reports orphaned refs without an apply record", async () => {
    const env = stateEnv();
    const plan = applyPlan({
      entries: [
        { kind: "plugin", id: "terminal", selector: "npm:@openclaw/plugin-terminal@1.0.0" },
      ],
    });
    persistClawArtifactApplyProvenance(plan, { env, nowMs: 1 });
    openOpenClawStateDatabase({ env }).db.prepare("DELETE FROM claw_apply_records").run();

    const findings = await collectClawStateHealthFindings({ env });

    expect(findings).toEqual([
      expect.objectContaining({
        message: 'Claw "starter" has provenance refs but no apply record.',
        path: "claws.starter",
      }),
    ]);
  });
});
