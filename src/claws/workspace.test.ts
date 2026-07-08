// Tests for Claw workspace/persona file application.
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { buildClawApplyPlan } from "./lifecycle.js";
import { buildClawPlan } from "./plan.js";
import { parseClawManifest } from "./schema.js";
import { applyClawWorkspaceFiles } from "./workspace.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function stateEnv() {
  return { OPENCLAW_STATE_DIR: tempDir("openclaw-claw-workspace-state-") };
}

async function writeSource(root: string, relativePath: string, contents: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

function applyPlan(params: { manifestRoot: string; clawId?: string; entries?: unknown[] }) {
  const parsed = parseClawManifest({
    schemaVersion: "openclaw.claw.v1",
    id: params.clawId ?? "starter",
    name: "Starter",
    version: "1.0.0",
    entries: params.entries ?? [
      {
        kind: "workspaceFile",
        id: "soul",
        path: "SOUL.md",
        source: "files/SOUL.md",
      },
      {
        kind: "persona",
        id: "persona",
        path: "personas/analyst.md",
        source: "files/PERSONA.md",
      },
    ],
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error("expected manifest to parse");
  }
  return buildClawApplyPlan(
    buildClawPlan({
      manifest: parsed.manifest,
      sourcePath: join(params.manifestRoot, "claw.json"),
    }),
  );
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("applyClawWorkspaceFiles", () => {
  it("writes workspace and persona files and records refs", async () => {
    const manifestRoot = tempDir("openclaw-claw-workspace-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-workspace-target-");
    await writeSource(manifestRoot, "files/SOUL.md", "soul\n");
    await writeSource(manifestRoot, "files/PERSONA.md", "persona\n");

    const refs = await applyClawWorkspaceFiles(applyPlan({ manifestRoot }), {
      env: stateEnv(),
      workspaceRoot,
      nowMs: 1,
    });

    await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).resolves.toBe("soul\n");
    await expect(readFile(join(workspaceRoot, "personas", "analyst.md"), "utf8")).resolves.toBe(
      "persona\n",
    );
    expect(refs).toEqual([
      expect.objectContaining({
        entryId: "soul",
        kind: "workspaceFile",
        workspaceRoot,
        operation: "created",
        provenanceRecord: "workspaceFile.installRecord",
      }),
      expect.objectContaining({
        entryId: "persona",
        kind: "persona",
        workspaceRoot,
        operation: "created",
        provenanceRecord: "workspaceFile.installRecord",
      }),
    ]);
  });

  it("records an existing identical file without rewriting it", async () => {
    const manifestRoot = tempDir("openclaw-claw-workspace-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-workspace-target-");
    await writeSource(manifestRoot, "files/SOUL.md", "same\n");
    await writeFile(join(workspaceRoot, "SOUL.md"), "same\n", "utf8");

    const refs = await applyClawWorkspaceFiles(
      applyPlan({
        manifestRoot,
        entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
      }),
      { env: stateEnv(), workspaceRoot, nowMs: 1 },
    );

    expect(refs[0]).toMatchObject({ entryId: "soul", operation: "unchanged" });
  });

  it("updates a previously managed file when the user has not edited it", async () => {
    const manifestRoot = tempDir("openclaw-claw-workspace-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-workspace-target-");
    const env = stateEnv();
    await writeSource(manifestRoot, "files/SOUL.md", "old\n");
    const plan = applyPlan({
      manifestRoot,
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });
    await applyClawWorkspaceFiles(plan, { env, workspaceRoot, nowMs: 1 });
    await writeSource(manifestRoot, "files/SOUL.md", "new\n");

    const refs = await applyClawWorkspaceFiles(plan, { env, workspaceRoot, nowMs: 2 });

    expect(refs[0]).toMatchObject({
      entryId: "soul",
      operation: "updated",
      appliedAtMs: 1,
      updatedAtMs: 2,
    });
    await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).resolves.toBe("new\n");
  });

  it("tracks a workspace by canonical root across symlink and real paths", async () => {
    const manifestRoot = tempDir("openclaw-claw-workspace-manifest-");
    const realWorkspaceRoot = tempDir("openclaw-claw-workspace-target-real-");
    const symlinkParent = tempDir("openclaw-claw-workspace-target-link-parent-");
    const symlinkWorkspaceRoot = join(symlinkParent, "workspace-link");
    const env = stateEnv();
    await symlink(realWorkspaceRoot, symlinkWorkspaceRoot, "dir");
    await writeSource(manifestRoot, "files/SOUL.md", "old\n");
    const plan = applyPlan({
      manifestRoot,
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });

    const first = await applyClawWorkspaceFiles(plan, {
      env,
      workspaceRoot: symlinkWorkspaceRoot,
      nowMs: 1,
    });
    await writeSource(manifestRoot, "files/SOUL.md", "new\n");
    const second = await applyClawWorkspaceFiles(plan, {
      env,
      workspaceRoot: realWorkspaceRoot,
      nowMs: 2,
    });

    expect(first[0]).toMatchObject({ workspaceRoot: realWorkspaceRoot, operation: "created" });
    expect(second[0]).toMatchObject({
      workspaceRoot: realWorkspaceRoot,
      operation: "updated",
      appliedAtMs: 1,
      updatedAtMs: 2,
    });
    await expect(readFile(join(realWorkspaceRoot, "SOUL.md"), "utf8")).resolves.toBe("new\n");
  });

  it("tracks managed files independently across workspace roots", async () => {
    const manifestRoot = tempDir("openclaw-claw-workspace-manifest-");
    const firstWorkspace = tempDir("openclaw-claw-workspace-target-a-");
    const secondWorkspace = tempDir("openclaw-claw-workspace-target-b-");
    const env = stateEnv();
    await writeSource(manifestRoot, "files/SOUL.md", "old\n");
    const plan = applyPlan({
      manifestRoot,
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });
    await applyClawWorkspaceFiles(plan, { env, workspaceRoot: firstWorkspace, nowMs: 1 });
    await applyClawWorkspaceFiles(plan, { env, workspaceRoot: secondWorkspace, nowMs: 2 });
    await writeSource(manifestRoot, "files/SOUL.md", "new\n");

    const refs = await applyClawWorkspaceFiles(plan, {
      env,
      workspaceRoot: firstWorkspace,
      nowMs: 3,
    });

    expect(refs[0]).toMatchObject({ entryId: "soul", operation: "updated" });
    await expect(readFile(join(firstWorkspace, "SOUL.md"), "utf8")).resolves.toBe("new\n");
    await expect(readFile(join(secondWorkspace, "SOUL.md"), "utf8")).resolves.toBe("old\n");
  });

  it("clears stale refs when workspace entries disappear", async () => {
    const manifestRoot = tempDir("openclaw-claw-workspace-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-workspace-target-");
    const env = stateEnv();
    await writeSource(manifestRoot, "files/SOUL.md", "old\n");
    const workspacePlan = applyPlan({
      manifestRoot,
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });
    await applyClawWorkspaceFiles(workspacePlan, { env, workspaceRoot, nowMs: 1 });

    await applyClawWorkspaceFiles(
      applyPlan({
        manifestRoot,
        entries: [{ kind: "skill", id: "only-skill", selector: "clawhub:only-skill@1.0.0" }],
      }),
      { env, workspaceRoot, nowMs: 2 },
    );
    await writeSource(manifestRoot, "files/SOUL.md", "new\n");

    await expect(
      applyClawWorkspaceFiles(workspacePlan, { env, workspaceRoot, nowMs: 3 }),
    ).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: "workspace_file_conflict", path: "$.entries[0]" }),
      ],
    });
    await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).resolves.toBe("old\n");
  });

  it("updates a same-Claw managed target when the entry id changes", async () => {
    const manifestRoot = tempDir("openclaw-claw-workspace-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-workspace-target-");
    const env = stateEnv();
    await writeSource(manifestRoot, "files/SOUL.md", "old\n");
    await applyClawWorkspaceFiles(
      applyPlan({
        manifestRoot,
        entries: [
          { kind: "workspaceFile", id: "old-soul", path: "SOUL.md", source: "files/SOUL.md" },
        ],
      }),
      { env, workspaceRoot, nowMs: 1 },
    );
    await writeSource(manifestRoot, "files/SOUL.md", "new\n");

    const refs = await applyClawWorkspaceFiles(
      applyPlan({
        manifestRoot,
        entries: [
          { kind: "workspaceFile", id: "new-soul", path: "SOUL.md", source: "files/SOUL.md" },
        ],
      }),
      { env, workspaceRoot, nowMs: 2 },
    );

    expect(refs[0]).toMatchObject({
      entryId: "new-soul",
      operation: "updated",
      appliedAtMs: 1,
      updatedAtMs: 2,
    });
    await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).resolves.toBe("new\n");
  });

  it("rejects managed file updates after user edits", async () => {
    const manifestRoot = tempDir("openclaw-claw-workspace-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-workspace-target-");
    const env = stateEnv();
    await writeSource(manifestRoot, "files/SOUL.md", "old\n");
    const plan = applyPlan({
      manifestRoot,
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });
    await applyClawWorkspaceFiles(plan, { env, workspaceRoot, nowMs: 1 });
    await writeFile(join(workspaceRoot, "SOUL.md"), "user edit\n", "utf8");
    await writeSource(manifestRoot, "files/SOUL.md", "new\n");

    await expect(
      applyClawWorkspaceFiles(plan, { env, workspaceRoot, nowMs: 2 }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_file_conflict" })],
    });
    await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).resolves.toBe("user edit\n");
  });

  it("rejects existing files with different content", async () => {
    const manifestRoot = tempDir("openclaw-claw-workspace-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-workspace-target-");
    await writeSource(manifestRoot, "files/SOUL.md", "new\n");
    await writeFile(join(workspaceRoot, "SOUL.md"), "user-owned\n", "utf8");

    await expect(
      applyClawWorkspaceFiles(
        applyPlan({
          manifestRoot,
          entries: [
            { kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" },
          ],
        }),
        { env: stateEnv(), workspaceRoot, nowMs: 1 },
      ),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_file_conflict" })],
    });
    await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).resolves.toBe("user-owned\n");
  });

  it("rejects source paths outside the manifest directory", async () => {
    const manifestRoot = tempDir("openclaw-claw-workspace-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-workspace-target-");

    await expect(
      applyClawWorkspaceFiles(
        applyPlan({
          manifestRoot,
          entries: [
            { kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "../outside.md" },
          ],
        }),
        { env: stateEnv(), workspaceRoot, nowMs: 1 },
      ),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: expect.stringContaining("workspace_file_") })],
    });
  });

  it("skips workspace root validation when there are no workspace files", async () => {
    const manifestRoot = tempDir("openclaw-claw-workspace-manifest-");
    const missingWorkspaceRoot = join(tempDir("openclaw-claw-workspace-target-parent-"), "missing");

    await expect(
      applyClawWorkspaceFiles(
        applyPlan({
          manifestRoot,
          entries: [{ kind: "skill", id: "only-skill", selector: "clawhub:only-skill@1.0.0" }],
        }),
        {
          env: stateEnv(),
          workspaceRoot: missingWorkspaceRoot,
          nowMs: 1,
        },
      ),
    ).resolves.toEqual([]);
  });

  it("rejects adopting a workspace target owned by another Claw", async () => {
    const manifestRoot = tempDir("openclaw-claw-workspace-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-workspace-target-");
    const env = stateEnv();
    await writeSource(manifestRoot, "files/SOUL.md", "same\n");
    const entries = [
      { kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" },
    ];
    await applyClawWorkspaceFiles(applyPlan({ manifestRoot, clawId: "first", entries }), {
      env,
      workspaceRoot,
      nowMs: 1,
    });

    await expect(
      applyClawWorkspaceFiles(applyPlan({ manifestRoot, clawId: "second", entries }), {
        env,
        workspaceRoot,
        nowMs: 2,
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_file_owned_by_other_claw" })],
    });
  });

  it("rejects duplicate resolved targets before writing files", async () => {
    const manifestRoot = tempDir("openclaw-claw-workspace-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-workspace-target-");
    await writeSource(manifestRoot, "files/FIRST.md", "first\n");
    await writeSource(manifestRoot, "files/SECOND.md", "second\n");

    await expect(
      applyClawWorkspaceFiles(
        applyPlan({
          manifestRoot,
          entries: [
            { kind: "workspaceFile", id: "first", path: "SOUL.md", source: "files/FIRST.md" },
            {
              kind: "workspaceFile",
              id: "second",
              path: "SOUL.md",
              source: "files/SECOND.md",
            },
          ],
        }),
        { env: stateEnv(), workspaceRoot, nowMs: 1 },
      ),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "duplicate_workspace_target" })],
    });
    await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).rejects.toThrow();
  });
});
