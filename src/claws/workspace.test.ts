// Tests create-only Claw workspace files and immediate per-file provenance.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { readClawInstallRecord } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawAddPlan, ClawSourceIdentity } from "./types.js";
import {
  ClawWorkspaceWriteError,
  createClawWorkspaceFiles,
  readClawWorkspaceFiles,
} from "./workspace.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function writeSource(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function makePlan(params?: {
  workspace?: unknown;
  createWorkspace?: boolean;
  mutateAfterPlan?: (plan: ClawAddPlan, root: string) => Promise<void>;
}) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-claw-workspace-"));
  const workspace = join(root, "workspace-agent");
  await writeSource(root, "content/AGENTS.md", "# Agent\n");
  await writeSource(root, "content/policy.md", "Policy\n");
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "workspace-agent" },
    workspace: params?.workspace ?? {
      bootstrapFiles: { "AGENTS.md": { source: "content/AGENTS.md" } },
      files: [{ source: "content/policy.md", path: "reference/policy.md" }],
    },
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/workspace-agent",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrity: "sha256:manifest",
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace },
  });
  expect(plan.blockers).toEqual([]);
  if (params?.createWorkspace !== false) {
    await mkdir(workspace);
  }
  await params?.mutateAfterPlan?.(plan, root);
  return { root, workspace, plan };
}

function stateEnv(root: string) {
  return { OPENCLAW_STATE_DIR: join(root, "state") };
}

describe("createClawWorkspaceFiles", () => {
  it("creates canonical bootstrap and supporting files and records their hashes", async () => {
    const { root, workspace, plan } = await makePlan();

    const records = await createClawWorkspaceFiles(plan, { env: stateEnv(root), nowMs: 10 });

    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).resolves.toBe("# Agent\n");
    await expect(readFile(join(workspace, "reference", "policy.md"), "utf8")).resolves.toBe(
      "Policy\n",
    );
    expect(records).toEqual([
      expect.objectContaining({
        schemaVersion: "openclaw.clawWorkspaceFileRecord.v1",
        agentId: "workspace-agent",
        path: "AGENTS.md",
        contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        createdAtMs: 10,
      }),
      expect.objectContaining({
        agentId: "workspace-agent",
        path: join("reference", "policy.md"),
      }),
    ]);
    expect(readClawWorkspaceFiles("workspace-agent", { env: stateEnv(root) })).toEqual(records);
  });

  it("never overwrites an unexpected destination", async () => {
    const { root, workspace, plan } = await makePlan();
    await writeFile(join(workspace, "AGENTS.md"), "operator content\n", "utf8");

    await expect(createClawWorkspaceFiles(plan, { env: stateEnv(root) })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_file_collision" })],
      createdFiles: [],
    });
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).resolves.toBe(
      "operator content\n",
    );
  });

  it("revalidates source content immediately before writing", async () => {
    const { root, workspace, plan } = await makePlan({
      mutateAfterPlan: async (_plan, packageRoot) => {
        await writeFile(join(packageRoot, "content", "AGENTS.md"), "changed\n", "utf8");
      },
    });

    await expect(createClawWorkspaceFiles(plan, { env: stateEnv(root) })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_source_changed" })],
    });
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "rejects a source replaced by a symlink after planning",
    async () => {
      const outside = await mkdtemp(join(tmpdir(), "openclaw-claw-outside-"));
      await writeFile(join(outside, "outside.md"), "outside\n", "utf8");
      const { root, workspace, plan } = await makePlan({
        mutateAfterPlan: async (_plan, packageRoot) => {
          const source = join(packageRoot, "content", "AGENTS.md");
          await rm(source);
          await symlink(join(outside, "outside.md"), source);
        },
      });

      await expect(createClawWorkspaceFiles(plan, { env: stateEnv(root) })).rejects.toBeInstanceOf(
        ClawWorkspaceWriteError,
      );
      await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).rejects.toThrow();
    },
  );

  it("persists earlier files when a later destination collides", async () => {
    const { root, workspace, plan } = await makePlan({
      workspace: {
        files: [
          { source: "content/AGENTS.md", path: "first.md" },
          { source: "content/policy.md", path: "second.md" },
        ],
      },
    });
    await writeFile(join(workspace, "second.md"), "collision\n", "utf8");

    await expect(
      createClawWorkspaceFiles(plan, { env: stateEnv(root), nowMs: 20 }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_file_collision" })],
      createdFiles: [expect.objectContaining({ path: "first.md" })],
    });
    await expect(readFile(join(workspace, "first.md"), "utf8")).resolves.toBe("# Agent\n");
    expect(readClawWorkspaceFiles("workspace-agent", { env: stateEnv(root) })).toEqual([
      expect.objectContaining({ path: "first.md", createdAtMs: 20 }),
    ]);
  });

  it("rejects a tampered plan destination outside the new workspace", async () => {
    const { root, plan } = await makePlan();
    const action = plan.actions.find((candidate) => candidate.kind === "workspaceFile");
    if (!action) {
      throw new Error("expected workspace action");
    }
    action.target = join(root, "outside.md");

    await expect(createClawWorkspaceFiles(plan, { env: stateEnv(root) })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_file_path_escape" })],
    });
  });
});

describe("workspace files in the consented add lifecycle", () => {
  it("marks the root install complete after every declared file is created", async () => {
    const { root, plan } = await makePlan({ createWorkspace: false });
    let config: OpenClawConfig = {};

    const result = await applyClawAddPlan(plan, {
      env: stateEnv(root),
      nowMs: 30,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(result).toMatchObject({
      status: "complete",
      workspaceFiles: [
        expect.objectContaining({ path: "AGENTS.md" }),
        expect.objectContaining({ path: join("reference", "policy.md") }),
      ],
      installRecord: { status: "complete" },
    });
    expect(config.agents?.list?.[0]?.id).toBe("workspace-agent");
    expect(readClawInstallRecord("workspace-agent", { env: stateEnv(root) })?.status).toBe(
      "complete",
    );
  });

  it("marks the root install partial and retains earlier file refs after a later source changes", async () => {
    const { root, plan } = await makePlan({
      createWorkspace: false,
      mutateAfterPlan: async (_plan, packageRoot) => {
        await writeFile(join(packageRoot, "content", "policy.md"), "changed\n", "utf8");
      },
    });
    let config: OpenClawConfig = {};

    const result = await applyClawAddPlan(plan, {
      env: stateEnv(root),
      nowMs: 40,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceFiles: [expect.objectContaining({ path: "AGENTS.md" })],
      installRecord: { status: "partial" },
      error: {
        code: "workspace_files_failed",
        diagnostics: [expect.objectContaining({ code: "workspace_source_changed" })],
      },
    });
    expect(config.agents?.list?.[0]?.id).toBe("workspace-agent");
    expect(readClawInstallRecord("workspace-agent", { env: stateEnv(root) })?.status).toBe(
      "partial",
    );
  });
});
