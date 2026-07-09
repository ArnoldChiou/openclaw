// Tests for read-only Claw update/reconcile planning.
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { buildClawApplyPlan } from "./lifecycle.js";
import { buildClawPlan } from "./plan.js";
import { artifactKeyFor, persistClawArtifactApplyProvenance } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import { buildClawUpdatePlan } from "./update-plan.js";
import { applyClawWorkspaceFiles } from "./workspace.js";

type ManifestParams = {
  version?: string;
  entries: unknown[];
  sourcePath?: string;
};

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function stateEnv() {
  return { OPENCLAW_STATE_DIR: tempDir("openclaw-claw-update-plan-state-") };
}

function plan(params: ManifestParams) {
  const parsed = parseClawManifest({
    schemaVersion: "openclaw.claw.v1",
    id: "starter",
    name: "Starter",
    version: params.version ?? "1.0.0",
    entries: params.entries,
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error("expected manifest to parse");
  }
  return buildClawApplyPlan(
    buildClawPlan({ manifest: parsed.manifest, sourcePath: params.sourcePath }),
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

describe("Claw update planning", () => {
  it("reports artifact additions, changes, removals, and unchanged refs without mutation", async () => {
    const env = stateEnv();
    const current = plan({
      entries: [
        { kind: "plugin", id: "terminal", selector: "npm:@openclaw/plugin-terminal@1.0.0" },
        { kind: "skill", id: "triage", selector: "clawhub:incident-triage@1.0.0" },
      ],
    });
    persistClawArtifactApplyProvenance(current, { env, nowMs: 1 });
    const target = plan({
      version: "1.1.0",
      entries: [
        { kind: "plugin", id: "terminal", selector: "npm:@openclaw/plugin-terminal@2.0.0" },
        { kind: "plugin", id: "pager", selector: "npm:@openclaw/plugin-pager-duty@1.0.0" },
      ],
    });

    const update = await buildClawUpdatePlan({
      clawId: "starter",
      targetPlan: target,
      stateOptions: { env },
    });

    expect(update).toMatchObject({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      dryRun: true,
      mutationAllowed: false,
      found: true,
      claw: { currentVersion: "1.0.0", targetVersion: "1.1.0" },
      summary: { added: 1, changed: 1, removed: 1, unchanged: 0, blocked: 0 },
    });
    expect(update.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "terminal", phase: "artifact", action: "change" }),
        expect.objectContaining({ id: "pager", phase: "artifact", action: "add" }),
        expect.objectContaining({ id: "triage", phase: "artifact", action: "remove" }),
      ]),
    );
  });

  it("reports unchanged artifact refs when the target artifact key is stable", async () => {
    const env = stateEnv();
    const current = plan({
      entries: [
        { kind: "plugin", id: "terminal", selector: "npm:@openclaw/plugin-terminal@1.0.0" },
      ],
    });
    persistClawArtifactApplyProvenance(current, { env, nowMs: 1 });

    const update = await buildClawUpdatePlan({
      clawId: "starter",
      targetPlan: current,
      stateOptions: { env },
    });

    expect(update.summary).toMatchObject({ unchanged: 1, added: 0, changed: 0, removed: 0 });
    expect(update.entries[0]).toMatchObject({ id: "terminal", action: "unchanged" });
    expect(update.entries[0]?.desired?.artifactKey).toBe(artifactKeyFor(current.entries[0]!));
  });

  it("reports workspace changes and preserves local edits as manual work", async () => {
    const env = stateEnv();
    const manifestRoot = tempDir("openclaw-claw-update-plan-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-update-plan-workspace-");
    await writeSource(manifestRoot, "files/SOUL.md", "current soul\n");
    const current = plan({
      sourcePath: join(manifestRoot, "claw.json"),
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });
    await applyClawWorkspaceFiles(current, { env, workspaceRoot, nowMs: 1 });
    await writeSource(manifestRoot, "files/SOUL.md", "target soul\n");
    const target = plan({
      version: "1.1.0",
      sourcePath: join(manifestRoot, "claw.json"),
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });

    const changed = await buildClawUpdatePlan({
      clawId: "starter",
      targetPlan: target,
      targetSourcePath: join(manifestRoot, "claw.json"),
      stateOptions: { env },
    });

    expect(changed.summary).toMatchObject({ changed: 1, manual: 0 });
    expect(changed.entries[0]).toMatchObject({ id: "soul", phase: "workspace", action: "change" });

    await writeFile(join(workspaceRoot, "SOUL.md"), "user edited\n", "utf8");
    const manual = await buildClawUpdatePlan({
      clawId: "starter",
      targetPlan: target,
      targetSourcePath: join(manifestRoot, "claw.json"),
      stateOptions: { env },
    });

    expect(manual.summary).toMatchObject({ changed: 0, manual: 1 });
    expect(manual.entries[0]).toMatchObject({
      id: "soul",
      phase: "workspace",
      action: "manual",
      local: { state: "modified" },
    });
  });

  it("plans workspace restoration when an unchanged target file is missing locally", async () => {
    const env = stateEnv();
    const manifestRoot = tempDir("openclaw-claw-update-plan-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-update-plan-workspace-");
    await writeSource(manifestRoot, "files/SOUL.md", "managed soul\n");
    const current = plan({
      sourcePath: join(manifestRoot, "claw.json"),
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });
    await applyClawWorkspaceFiles(current, { env, workspaceRoot, nowMs: 1 });
    await rm(join(workspaceRoot, "SOUL.md"));

    const update = await buildClawUpdatePlan({
      clawId: "starter",
      targetPlan: current,
      targetSourcePath: join(manifestRoot, "claw.json"),
      stateOptions: { env },
    });

    expect(update.summary).toMatchObject({ changed: 1, unchanged: 0 });
    expect(update.entries[0]).toMatchObject({
      id: "soul",
      action: "change",
      local: { state: "missing" },
    });
  });

  it("plans stale ref removal when an entry id changes phase", async () => {
    const env = stateEnv();
    const manifestRoot = tempDir("openclaw-claw-update-plan-manifest-");
    const workspaceRoot = tempDir("openclaw-claw-update-plan-workspace-");
    await writeSource(manifestRoot, "files/SOUL.md", "managed soul\n");
    const current = plan({
      sourcePath: join(manifestRoot, "claw.json"),
      entries: [{ kind: "workspaceFile", id: "shared", path: "SOUL.md", source: "files/SOUL.md" }],
    });
    await applyClawWorkspaceFiles(current, { env, workspaceRoot, nowMs: 1 });
    const target = plan({
      version: "1.1.0",
      entries: [{ kind: "plugin", id: "shared", selector: "npm:@openclaw/plugin-shared@1.0.0" }],
    });

    const update = await buildClawUpdatePlan({
      clawId: "starter",
      targetPlan: target,
      stateOptions: { env },
    });

    expect(update.summary).toMatchObject({ added: 1, removed: 1 });
    expect(update.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "shared", phase: "artifact", action: "add" }),
        expect.objectContaining({ id: "shared", phase: "workspace", action: "remove" }),
      ]),
    );
  });

  it("scopes workspace planning to the requested workspace root", async () => {
    const env = stateEnv();
    const manifestRoot = tempDir("openclaw-claw-update-plan-manifest-");
    const parent = tempDir("openclaw-claw-update-plan-workspaces-");
    const workspaceA = join(parent, "a");
    const workspaceZ = join(parent, "z");
    await mkdir(workspaceA, { recursive: true });
    await mkdir(workspaceZ, { recursive: true });
    await writeSource(manifestRoot, "files/SOUL.md", "one\n");
    const currentA = plan({
      sourcePath: join(manifestRoot, "claw.json"),
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });
    await applyClawWorkspaceFiles(currentA, { env, workspaceRoot: workspaceA, nowMs: 1 });
    await writeSource(manifestRoot, "files/SOUL.md", "two\n");
    const currentZ = plan({
      sourcePath: join(manifestRoot, "claw.json"),
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });
    await applyClawWorkspaceFiles(currentZ, { env, workspaceRoot: workspaceZ, nowMs: 2 });
    await writeSource(manifestRoot, "files/SOUL.md", "one\n");
    await writeSource(manifestRoot, "files/EXTRA.md", "extra\n");
    const target = plan({
      sourcePath: join(manifestRoot, "claw.json"),
      entries: [
        { kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" },
        { kind: "workspaceFile", id: "extra", path: "EXTRA.md", source: "files/EXTRA.md" },
      ],
    });

    const update = await buildClawUpdatePlan({
      clawId: "starter",
      targetPlan: target,
      targetSourcePath: join(manifestRoot, "claw.json"),
      workspaceRoot: workspaceA,
      stateOptions: { env },
    });

    expect(update.summary).toMatchObject({
      added: 1,
      unchanged: 1,
      changed: 0,
      manual: 0,
      removed: 0,
    });
    expect(update.entries).toEqual([
      expect.objectContaining({ id: "soul", phase: "workspace", action: "unchanged" }),
      expect.objectContaining({ id: "extra", phase: "workspace", action: "add" }),
    ]);
  });

  it("plans every persisted workspace root when no workspace root is requested", async () => {
    const env = stateEnv();
    const manifestRoot = tempDir("openclaw-claw-update-plan-manifest-");
    const parent = tempDir("openclaw-claw-update-plan-workspaces-");
    const workspaceA = join(parent, "a");
    const workspaceZ = join(parent, "z");
    await mkdir(workspaceA, { recursive: true });
    await mkdir(workspaceZ, { recursive: true });
    await writeSource(manifestRoot, "files/SOUL.md", "one\n");
    const currentA = plan({
      sourcePath: join(manifestRoot, "claw.json"),
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });
    await applyClawWorkspaceFiles(currentA, { env, workspaceRoot: workspaceA, nowMs: 1 });
    await writeSource(manifestRoot, "files/SOUL.md", "two\n");
    const currentZ = plan({
      sourcePath: join(manifestRoot, "claw.json"),
      entries: [{ kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" }],
    });
    await applyClawWorkspaceFiles(currentZ, { env, workspaceRoot: workspaceZ, nowMs: 2 });
    await writeSource(manifestRoot, "files/SOUL.md", "one\n");
    await writeSource(manifestRoot, "files/EXTRA.md", "extra\n");
    const target = plan({
      sourcePath: join(manifestRoot, "claw.json"),
      entries: [
        { kind: "workspaceFile", id: "soul", path: "SOUL.md", source: "files/SOUL.md" },
        { kind: "workspaceFile", id: "extra", path: "EXTRA.md", source: "files/EXTRA.md" },
      ],
    });

    const update = await buildClawUpdatePlan({
      clawId: "starter",
      targetPlan: target,
      targetSourcePath: join(manifestRoot, "claw.json"),
      stateOptions: { env },
    });

    expect(update.summary).toMatchObject({ totalEntries: 4, added: 2, unchanged: 1, changed: 1 });
    expect(update.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "soul", phase: "workspace", action: "unchanged" }),
        expect.objectContaining({ id: "soul", phase: "workspace", action: "change" }),
        expect.objectContaining({ id: "extra", phase: "workspace", action: "add" }),
        expect.objectContaining({ id: "extra", phase: "workspace", action: "add" }),
      ]),
    );
  });

  it("fails closed when the target Claw id differs from the applied Claw", async () => {
    const env = stateEnv();
    const current = plan({
      entries: [
        { kind: "plugin", id: "terminal", selector: "npm:@openclaw/plugin-terminal@1.0.0" },
      ],
    });
    persistClawArtifactApplyProvenance(current, { env, nowMs: 1 });
    const parsed = parseClawManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "different",
      name: "Different",
      version: "1.0.0",
      entries: [
        { kind: "plugin", id: "terminal", selector: "npm:@openclaw/plugin-terminal@1.0.0" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected manifest to parse");
    }
    const target = buildClawApplyPlan(buildClawPlan({ manifest: parsed.manifest }));

    const update = await buildClawUpdatePlan({
      clawId: "starter",
      targetPlan: target,
      stateOptions: { env },
    });

    expect(update).toMatchObject({
      found: true,
      summary: { totalEntries: 0 },
      diagnostics: [expect.objectContaining({ code: "target_claw_mismatch" })],
    });
  });
});
