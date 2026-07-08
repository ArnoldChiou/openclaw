// Tests for persisted Claw status and remove lifecycle state.
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { readClawStatus, removeClawState } from "./lifecycle-state.js";
import { buildClawApplyPlan } from "./lifecycle.js";
import { buildClawPlan } from "./plan.js";
import { persistClawArtifactApplyProvenance } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import { applyClawWorkspaceFiles } from "./workspace.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function stateEnv() {
  return { OPENCLAW_STATE_DIR: tempDir("openclaw-claw-lifecycle-state-") };
}

function applyPlan(params: {
  clawId?: string;
  selector?: string;
  entries?: unknown[];
  manifestRoot?: string;
}) {
  const manifestRoot = params.manifestRoot ?? tempDir("openclaw-claw-lifecycle-manifest-");
  const parsed = parseClawManifest({
    schemaVersion: "openclaw.claw.v1",
    id: params.clawId ?? "starter",
    name: "Starter",
    version: "1.0.0",
    entries: params.entries ?? [
      {
        kind: "plugin",
        id: "terminal",
        selector: params.selector ?? "npm:@openclaw/plugin-terminal@2.0.0",
      },
    ],
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

describe("Claw lifecycle state", () => {
  it("reports and removes Claw artifact refs while preserving remaining shared ownership", async () => {
    const env = stateEnv();
    persistClawArtifactApplyProvenance(applyPlan({ clawId: "first" }), { env, nowMs: 1 });
    persistClawArtifactApplyProvenance(applyPlan({ clawId: "second" }), { env, nowMs: 2 });

    expect(readClawStatus(undefined, { env })).toMatchObject({
      summary: { claws: 2, artifactRefs: 2, workspaceFileRefs: 0 },
    });

    const removed = await removeClawState("first", { env });

    expect(removed).toMatchObject({
      found: true,
      summary: { artifactRefsRemoved: 1, workspaceFileRefsRemoved: 0, errors: 0 },
    });
    expect(readClawStatus(undefined, { env })).toMatchObject({
      summary: { claws: 1, artifactRefs: 1, workspaceFileRefs: 0 },
      records: [
        {
          clawId: "second",
          artifacts: [
            {
              ownership: { state: "referenced", clawRefs: ["second"], refCount: 1 },
            },
          ],
        },
      ],
    });
  });

  it("does not delete any workspace files when remove preflight finds an unsafe ref", async () => {
    const env = stateEnv();
    const manifestRoot = tempDir("openclaw-claw-lifecycle-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-lifecycle-workspace-");
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
    await rm(join(workspaceRoot, "B.md"));
    await symlink(join(workspaceRoot, "A.md"), join(workspaceRoot, "B.md"));

    const removed = await removeClawState("starter", { env });

    expect(removed.summary.errors).toBe(1);
    await expect(readFile(join(workspaceRoot, "A.md"), "utf8")).resolves.toBe("a\n");
    expect(readClawStatus("starter", { env })).toMatchObject({
      summary: { claws: 1, workspaceFileRefs: 2 },
    });
  });

  it("removes stale Claw refs when the workspace root is already gone", async () => {
    const env = stateEnv();
    const manifestRoot = tempDir("openclaw-claw-lifecycle-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-lifecycle-workspace-");
    await writeSource(manifestRoot, "files/SOUL.md", "managed\n");
    const plan = applyPlan({
      manifestRoot,
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });
    await applyClawWorkspaceFiles(plan, { env, workspaceRoot, nowMs: 1 });
    await rm(workspaceRoot, { recursive: true, force: true });

    const removed = await removeClawState("starter", { env });

    expect(removed).toMatchObject({
      found: true,
      summary: { workspaceFileRefsRemoved: 1, workspaceFilesDeleted: 0, errors: 0 },
      workspaceFiles: [{ action: "missing" }],
    });
    expect(readClawStatus("starter", { env })).toMatchObject({
      summary: { claws: 0, artifactRefs: 0, workspaceFileRefs: 0 },
    });
  });

  it("retains oversized modified workspace files and clears their refs", async () => {
    const env = stateEnv();
    const manifestRoot = tempDir("openclaw-claw-lifecycle-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-lifecycle-workspace-");
    await writeSource(manifestRoot, "files/SOUL.md", "managed\n");
    const plan = applyPlan({
      manifestRoot,
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });
    await applyClawWorkspaceFiles(plan, { env, workspaceRoot, nowMs: 1 });
    await writeFile(join(workspaceRoot, "SOUL.md"), "x".repeat(1024 * 1024 + 1), "utf8");

    const removed = await removeClawState("starter", { env });

    expect(removed).toMatchObject({
      found: true,
      summary: {
        workspaceFileRefsRemoved: 1,
        workspaceFilesDeleted: 0,
        workspaceFilesRetained: 1,
        errors: 0,
      },
      workspaceFiles: [{ action: "retainedModified" }],
    });
    expect(readClawStatus("starter", { env })).toMatchObject({
      summary: { claws: 0, workspaceFileRefs: 0 },
    });
  });

  it("retains modified workspace files but removes their Claw refs", async () => {
    const env = stateEnv();
    const manifestRoot = tempDir("openclaw-claw-lifecycle-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-lifecycle-workspace-");
    await writeSource(manifestRoot, "files/SOUL.md", "managed\n");
    const plan = applyPlan({
      manifestRoot,
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });
    await applyClawWorkspaceFiles(plan, { env, workspaceRoot, nowMs: 1 });
    await writeFile(join(workspaceRoot, "SOUL.md"), "user changed\n", "utf8");

    const removed = await removeClawState("starter", { env });

    expect(removed).toMatchObject({
      found: true,
      summary: { workspaceFileRefsRemoved: 1, workspaceFilesDeleted: 0, workspaceFilesRetained: 1 },
      workspaceFiles: [{ action: "retainedModified" }],
    });
    await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).resolves.toBe("user changed\n");
    expect(readClawStatus("starter", { env })).toMatchObject({
      summary: { claws: 0, artifactRefs: 0, workspaceFileRefs: 0 },
    });
  });
});
