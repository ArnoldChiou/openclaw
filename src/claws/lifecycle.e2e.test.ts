// E2E coverage for the staged Claw lifecycle CLI flow.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function runOpenClaw(
  args: string[],
  options?: { expectFailure?: boolean; stateDir?: string },
) {
  const stateDir =
    options?.stateDir ?? (await mkdtemp(join(tmpdir(), "openclaw-claws-lifecycle-e2e-")));
  const env = {
    ...process.env,
    HOME: stateDir,
    USERPROFILE: stateDir,
    OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
    OPENCLAW_TEST_RUNTIME_LOG: "1",
    VITEST: "",
  };
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/entry.ts", ...args],
      {
        cwd: process.cwd(),
        env,
        maxBuffer: 1024 * 1024,
      },
    );
    if (options?.expectFailure) {
      throw new Error(`expected command to fail: ${args.join(" ")}`);
    }
    return { ok: true as const, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!options?.expectFailure) {
      throw error;
    }
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false as const,
      code: failed.code,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

async function writeLocalPluginClawFixture(): Promise<{ manifestPath: string; pluginDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "openclaw-claws-local-plugin-"));
  const pluginDir = join(root, "plugin");
  await mkdir(join(pluginDir, "dist"), { recursive: true });
  await writeFile(
    join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/claw-local-plugin",
      version: "1.0.0",
      openclaw: { extensions: ["./dist/index.js"] },
    }),
    "utf8",
  );
  await writeFile(
    join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "claw-local-plugin",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf8",
  );
  await writeFile(join(pluginDir, "dist", "index.js"), "export {};\n", "utf8");
  await mkdir(join(root, "files"), { recursive: true });
  await writeFile(join(root, "files", "SOUL.md"), "Local Plugin Claw\n", "utf8");
  const manifestPath = join(root, "claw.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: "openclaw.claw.v1",
      id: "local-plugin-claw",
      name: "Local Plugin Claw",
      version: "1.0.0",
      entries: [
        { kind: "plugin", id: "local-plugin", selector: pluginDir },
        { kind: "workspaceFile", id: "runbook", path: "SOUL.md", source: "files/SOUL.md" },
      ],
    }),
    "utf8",
  );
  return { manifestPath, pluginDir };
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed);
}

function parseJsonObject(stdout: string): Record<string, unknown> {
  const parsed = parseJson(stdout);
  expect(parsed).toEqual(expect.any(Object));
  return parsed as Record<string, unknown>;
}

describe("claws lifecycle cli e2e", () => {
  it("runs inspect and dry-run apply for a local Claw manifest", async () => {
    const manifestPath = "src/claws/fixtures/incident-response.claw.json";

    const inspect = parseJsonObject(
      (await runOpenClaw(["claws", "inspect", manifestPath, "--json"])).stdout,
    );
    expect(inspect).toMatchObject({
      valid: true,
      manifest: { id: "incident-response", entries: expect.any(Array) },
    });
    const apply = parseJsonObject(
      (await runOpenClaw(["claws", "apply", manifestPath, "--dry-run", "--json"])).stdout,
    );
    expect(apply).toMatchObject({
      schemaVersion: "openclaw.clawApplyPlan.v1",
      dryRun: true,
      mutationAllowed: false,
      summary: {
        totalEntries: 5,
        installActions: 5,
        consentRequired: 2,
        blockedEntries: 0,
        provenanceRecords: 5,
        rollbackActions: 5,
      },
    });
  });

  it("runs feed inspect and feed dry-run apply from the local feed fixture", async () => {
    const feedPath = "src/claws/fixtures/local-claws.feed.json";

    const inspect = parseJsonObject(
      (await runOpenClaw(["claws", "feed", "inspect", feedPath, "--json"])).stdout,
    );
    expect(inspect).toMatchObject({
      valid: true,
      feed: { id: "local-starter-claws", entries: expect.any(Array) },
    });

    const apply = parseJsonObject(
      (
        await runOpenClaw([
          "claws",
          "feed",
          "apply",
          feedPath,
          "incident-response",
          "--dry-run",
          "--json",
        ])
      ).stdout,
    );
    expect(apply).toMatchObject({
      schemaVersion: "openclaw.clawApplyPlan.v1",
      dryRun: true,
      mutationAllowed: false,
      feed: { id: "local-starter-claws", entry: { id: "incident-response" } },
      summary: { totalEntries: 5, consentRequired: 2, blockedEntries: 0 },
    });
  });

  it("fails closed when apply is invoked without --dry-run", async () => {
    const result = await runOpenClaw(
      ["claws", "apply", "src/claws/fixtures/incident-response.claw.json"],
      { expectFailure: true },
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Claw apply mutates workspace files");
  });

  it("runs the full apply, status, dry-run remove, remove lifecycle", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "openclaw-claws-lifecycle-state-"));
    const { manifestPath } = await writeLocalPluginClawFixture();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-lifecycle-workspace-"));

    await runOpenClaw(
      ["claws", "apply", manifestPath, "--yes", "--workspace", workspaceRoot, "--json"],
      { stateDir },
    );
    const status = parseJsonObject(
      (await runOpenClaw(["claws", "status", "local-plugin-claw", "--json"], { stateDir })).stdout,
    );
    expect(status).toMatchObject({
      schemaVersion: "openclaw.clawStatus.v1",
      summary: { claws: 1, artifactRefs: 1, workspaceFileRefs: 1 },
    });

    const dryRunRemove = parseJsonObject(
      (
        await runOpenClaw(["claws", "remove", "local-plugin-claw", "--dry-run", "--json"], {
          stateDir,
        })
      ).stdout,
    );
    expect(dryRunRemove).toMatchObject({
      schemaVersion: "openclaw.clawRemoveResult.v1",
      dryRun: true,
      found: true,
      workspaceFiles: [{ action: "dryRunDelete" }],
    });
    await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).resolves.toContain(
      "Local Plugin Claw",
    );

    const removed = parseJsonObject(
      (await runOpenClaw(["claws", "remove", "local-plugin-claw", "--yes", "--json"], { stateDir }))
        .stdout,
    );
    expect(removed).toMatchObject({
      dryRun: false,
      found: true,
      summary: {
        artifactRefsRemoved: 1,
        workspaceFileRefsRemoved: 1,
        workspaceFilesDeleted: 1,
        errors: 0,
      },
    });
    await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const finalStatus = parseJsonObject(
      (await runOpenClaw(["claws", "status", "local-plugin-claw", "--json"], { stateDir })).stdout,
    );
    expect(finalStatus).toMatchObject({
      summary: { claws: 0, artifactRefs: 0, workspaceFileRefs: 0 },
    });
  });

  it("applies a local plugin, workspace files, and artifact provenance when confirmed", async () => {
    const { manifestPath, pluginDir } = await writeLocalPluginClawFixture();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-lifecycle-workspace-"));
    const apply = parseJsonObject(
      (
        await runOpenClaw([
          "claws",
          "apply",
          manifestPath,
          "--yes",
          "--workspace",
          workspaceRoot,
          "--json",
        ])
      ).stdout,
    );

    expect(apply).toMatchObject({
      schemaVersion: "openclaw.clawApplyResult.v1",
      dryRun: false,
      mutationAllowed: true,
      summary: {
        totalEntries: 2,
        recordedArtifactRefs: 1,
        appliedWorkspaceFiles: 1,
        previewOnlyEntries: 0,
        blockedEntries: 0,
        provenanceRecords: 2,
      },
    });
    expect(apply.workspaceFiles).toEqual(expect.any(Array));
    const workspaceFiles = apply.workspaceFiles as unknown[];
    expect(workspaceFiles[0]).toMatchObject({
      entryId: "runbook",
      workspaceRoot,
      operation: "created",
    });
    await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).resolves.toContain(
      "Local Plugin Claw",
    );
    const artifacts = apply.artifacts as unknown[];
    expect(artifacts[0]).toMatchObject({
      clawId: "local-plugin-claw",
      entryId: "local-plugin",
      artifactKey: `plugins:path:${pluginDir}`,
      ownership: { state: "newly-created", clawRefs: ["local-plugin-claw"], refCount: 1 },
    });
  });
});
