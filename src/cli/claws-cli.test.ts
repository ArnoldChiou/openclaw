// Tests for the Claws CLI inspection and dry-run apply commands.
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

const pluginRecordMock = vi.hoisted(() => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(
    async (): Promise<Record<string, PluginInstallRecord>> => ({
      terminal: {
        source: "npm",
        spec: "@openclaw/plugin-terminal@^1.0.0",
        resolvedName: "@openclaw/plugin-terminal",
        resolvedVersion: "1.2.3",
        version: "1.2.3",
      },
      local: {
        source: "path",
        sourcePath: "/tmp/openclaw-plugin-local",
      },
    }),
  ),
}));

const artifactInstallerMock = vi.hoisted(() => ({
  applyClawArtifactInstallers: vi.fn(async () => ({
    directArtifactKeys: new Set<string>(),
    createdArtifactKeys: new Set<string>(),
    installedArtifactKeys: new Set<string>(),
  })),
}));

const mocks = vi.hoisted(() => {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: vi.fn((value: unknown) => logs.push(String(value))),
    error: vi.fn((value: unknown) => errors.push(String(value))),
    writeJson: vi.fn((value: unknown, space = 2) =>
      logs.push(JSON.stringify(value, null, space > 0 ? space : undefined)),
    ),
    writeStdout: vi.fn((value: string) =>
      logs.push(value.endsWith("\n") ? value.slice(0, -1) : value),
    ),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return { logs, errors, runtime };
});

vi.mock("../claws/artifact-installers.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/artifact-installers.js")>(
    "../claws/artifact-installers.js",
  )),
  applyClawArtifactInstallers: artifactInstallerMock.applyClawArtifactInstallers,
}));

vi.mock("../plugins/installed-plugin-index-records.js", async () => ({
  ...(await vi.importActual<typeof import("../plugins/installed-plugin-index-records.js")>(
    "../plugins/installed-plugin-index-records.js",
  )),
  loadInstalledPluginIndexInstallRecords: pluginRecordMock.loadInstalledPluginIndexInstallRecords,
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: typeof mocks.runtime, value: unknown, space = 2) =>
    runtime.writeJson(value, space),
}));

const { ClawArtifactApplyError } = await import("../claws/artifact-installers.js");
const { readClawArtifactRefsForArtifactKey } = await import("../claws/provenance.js");
const { registerClawsCli } = await import("./claws-cli.js");

async function writeManifest(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-"));
  const path = join(dir, "claw.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  await mkdir(join(dir, "files"), { recursive: true });
  await writeFile(join(dir, "files", "SOUL.md"), "starter soul\n", "utf8");
  return path;
}

async function writeFeedWorkspace(params?: {
  feed?: unknown;
  manifest?: unknown;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-feed-"));
  const manifest = params?.manifest ?? {
    schemaVersion: "openclaw.claw.v1",
    id: "starter",
    name: "Starter",
    version: "1.0.0",
    entries: [
      {
        kind: "workspaceFile",
        id: "soul",
        path: "SOUL.md",
        source: "files/SOUL.md",
      },
    ],
  };
  const feed = params?.feed ?? {
    schemaVersion: "openclaw.clawFeed.v1",
    id: "local-starters",
    name: "Local Starters",
    entries: [
      {
        id: "starter",
        name: "Starter",
        version: "1.0.0",
        source: "starter.claw.json",
        owner: { type: "publisher", id: "openclaw.examples" },
      },
    ],
  };
  await writeFile(join(dir, "starter.claw.json"), JSON.stringify(manifest), "utf8");
  await mkdir(join(dir, "files"), { recursive: true });
  await writeFile(join(dir, "files", "SOUL.md"), "feed soul\n", "utf8");
  const feedPath = join(dir, "claws.feed.json");
  await writeFile(feedPath, JSON.stringify(feed), "utf8");
  return feedPath;
}

async function runCli(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerClawsCli(program);
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("__exit__:"))) {
      throw error;
    }
  }
}

describe("claws cli", () => {
  beforeEach(() => {
    mocks.logs.length = 0;
    mocks.errors.length = 0;
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
    artifactInstallerMock.applyClawArtifactInstallers.mockClear();
    pluginRecordMock.loadInstalledPluginIndexInstallRecords.mockClear();
    pluginRecordMock.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      terminal: {
        source: "npm",
        spec: "@openclaw/plugin-terminal@^1.0.0",
        resolvedName: "@openclaw/plugin-terminal",
        resolvedVersion: "1.2.3",
        version: "1.2.3",
      },
      local: { source: "path", sourcePath: "/tmp/openclaw-plugin-local" },
    });
    artifactInstallerMock.applyClawArtifactInstallers.mockResolvedValue({
      directArtifactKeys: new Set<string>(),
      createdArtifactKeys: new Set<string>(),
      installedArtifactKeys: new Set<string>(),
    });
  });

  it("exports selected installed plugins and workspace files as a Claw manifest", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-export-workspace-"));
    await writeFile(join(workspaceRoot, "SOUL.md"), "exported soul\n", "utf8");
    await mkdir(join(workspaceRoot, "runbooks"), { recursive: true });
    await writeFile(join(workspaceRoot, "runbooks", "incident.md"), "runbook\n", "utf8");
    const outPath = join(workspaceRoot, "claws", "starter.claw.json");

    await runCli([
      "claws",
      "export",
      "--id",
      "starter",
      "--name",
      "Starter",
      "--workspace",
      workspaceRoot,
      "--plugin",
      "terminal",
      "--workspace-file",
      "runbooks/incident.md",
      "--persona",
      "SOUL.md",
      "--out",
      outPath,
      "--json",
    ]);

    expect(pluginRecordMock.loadInstalledPluginIndexInstallRecords).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      schemaVersion: "openclaw.clawExport.v1",
      summary: { plugins: 1, workspaceFiles: 1, personas: 1, excluded: 0, warnings: 0 },
      manifest: {
        schemaVersion: "openclaw.claw.v1",
        id: "starter",
        name: "Starter",
        version: "1.0.0",
        entries: [
          {
            kind: "plugin",
            id: "plugin-terminal",
            selector: "npm:@openclaw/plugin-terminal@1.2.3",
          },
          {
            kind: "workspaceFile",
            path: "runbooks/incident.md",
            source: "files/runbooks/incident.md",
          },
          { kind: "persona", path: "SOUL.md", source: "files/SOUL.md" },
        ],
      },
    });
  });

  it("writes exported manifests and honors include and exclude filters", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-export-workspace-"));
    await writeFile(join(workspaceRoot, "SOUL.md"), "exported soul\n", "utf8");
    const outPath = join(workspaceRoot, "claws", "starter.claw.json");

    await runCli([
      "claws",
      "export",
      "--id",
      "starter",
      "--name",
      "Starter",
      "--workspace",
      workspaceRoot,
      "--include",
      "plugins,persona",
      "--exclude",
      "plugin:local",
      "--persona",
      "SOUL.md",
      "--out",
      outPath,
      "--json",
    ]);

    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      outputPath: outPath,
      summary: { plugins: 1, workspaceFiles: 0, personas: 1, excluded: 1 },
    });
    await expect(readFile(outPath, "utf8")).resolves.toContain('"schemaVersion": "openclaw.claw.v1"');
    const written = JSON.parse(await readFile(outPath, "utf8"));
    expect(written.entries).toEqual([
      expect.objectContaining({ id: "plugin-terminal" }),
      expect.objectContaining({ kind: "persona", path: "SOUL.md", source: "files/SOUL.md" }),
    ]);
    await expect(readFile(join(workspaceRoot, "claws", "files", "SOUL.md"), "utf8")).resolves.toBe(
      "exported soul\n",
    );
  });

  it("deduplicates repeated workspace file selections", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-export-dedupe-"));
    await writeFile(join(workspaceRoot, "SOUL.md"), "exported soul\n", "utf8");
    const outPath = join(workspaceRoot, "claws", "starter.claw.json");

    await runCli([
      "claws",
      "export",
      "--id",
      "starter",
      "--name",
      "Starter",
      "--include",
      "persona",
      "--workspace",
      workspaceRoot,
      "--persona",
      "SOUL.md,SOUL.md",
      "--out",
      outPath,
      "--json",
    ]);

    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      summary: { personas: 1, excluded: 1 },
    });
    const written = JSON.parse(await readFile(outPath, "utf8"));
    expect(written.entries).toEqual([
      expect.objectContaining({ id: "persona-soul.md", source: "files/SOUL.md" }),
    ]);
  });

  it("deduplicates workspace and persona selections for the same target", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-export-cross-dedupe-"));
    await writeFile(join(workspaceRoot, "SOUL.md"), "exported soul\n", "utf8");
    const outPath = join(workspaceRoot, "claws", "starter.claw.json");

    await runCli([
      "claws",
      "export",
      "--id",
      "starter",
      "--name",
      "Starter",
      "--include",
      "workspace,persona",
      "--workspace",
      workspaceRoot,
      "--workspace-file",
      "SOUL.md",
      "--persona",
      "SOUL.md",
      "--out",
      outPath,
      "--json",
    ]);

    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      summary: { workspaceFiles: 1, personas: 0, excluded: 1 },
    });
    const written = JSON.parse(await readFile(outPath, "utf8"));
    expect(written.entries).toEqual([
      expect.objectContaining({ kind: "workspaceFile", path: "SOUL.md" }),
    ]);
  });

  it("skips files larger than the apply workspace file limit", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-export-large-"));
    await writeFile(join(workspaceRoot, "large.md"), Buffer.alloc(1024 * 1024 + 1));
    const outPath = join(workspaceRoot, "claws", "starter.claw.json");

    await runCli([
      "claws",
      "export",
      "--id",
      "starter",
      "--name",
      "Starter",
      "--include",
      "workspace",
      "--workspace",
      workspaceRoot,
      "--workspace-file",
      "large.md",
      "--out",
      outPath,
      "--json",
    ]);

    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      error: { code: "claw_export_empty" },
      summary: { workspaceFiles: 0, warnings: 2 },
      warnings: [
        expect.stringContaining("larger than 1048576 bytes"),
        expect.stringContaining("No Claw entries were selected"),
      ],
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    await expect(readFile(outPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips directory workspace selections", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-export-directory-"));
    await mkdir(join(workspaceRoot, "docs"), { recursive: true });
    const outPath = join(workspaceRoot, "claws", "starter.claw.json");

    await runCli([
      "claws",
      "export",
      "--id",
      "starter",
      "--name",
      "Starter",
      "--include",
      "workspace",
      "--workspace",
      workspaceRoot,
      "--workspace-file",
      "docs",
      "--out",
      outPath,
      "--json",
    ]);

    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      error: { code: "claw_export_empty" },
      summary: { workspaceFiles: 0, warnings: 2 },
      warnings: [
        expect.stringContaining("not a regular file"),
        expect.stringContaining("No Claw entries were selected"),
      ],
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("generates unique entry ids for normalized path collisions", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-export-id-collision-"));
    await mkdir(join(workspaceRoot, "docs", "a"), { recursive: true });
    await writeFile(join(workspaceRoot, "docs", "a", "b.md"), "nested\n", "utf8");
    await writeFile(join(workspaceRoot, "docs", "a-b.md"), "flat\n", "utf8");
    const outPath = join(workspaceRoot, "claws", "starter.claw.json");

    await runCli([
      "claws",
      "export",
      "--id",
      "starter",
      "--name",
      "Starter",
      "--include",
      "workspace",
      "--workspace",
      workspaceRoot,
      "--workspace-file",
      "docs/a/b.md",
      "--workspace-file",
      "docs/a-b.md",
      "--out",
      outPath,
      "--json",
    ]);

    const written = JSON.parse(await readFile(outPath, "utf8"));
    const ids = written.entries.map((entry: { id: string }) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["file-docs-a-b.md", "file-docs-a-b.md-2"]);
  });

  it("requires --out when exporting workspace or persona files", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-export-workspace-"));
    await writeFile(join(workspaceRoot, "SOUL.md"), "exported soul\n", "utf8");

    await runCli([
      "claws",
      "export",
      "--id",
      "starter",
      "--name",
      "Starter",
      "--include",
      "persona",
      "--workspace",
      workspaceRoot,
      "--persona",
      "SOUL.md",
      "--json",
    ]);

    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      error: { code: "claw_export_out_required" },
      summary: { personas: 1 },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("skips workspace file symlinks that resolve outside the workspace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-export-symlink-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-export-outside-"));
    await writeFile(join(outsideRoot, "secret.txt"), "secret\n", "utf8");
    await symlink(join(outsideRoot, "secret.txt"), join(workspaceRoot, "linked-secret.txt"));

    await runCli([
      "claws",
      "export",
      "--id",
      "starter",
      "--name",
      "Starter",
      "--include",
      "workspace",
      "--workspace",
      workspaceRoot,
      "--workspace-file",
      "linked-secret.txt",
      "--json",
    ]);

    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      error: { code: "claw_export_empty" },
      summary: { workspaceFiles: 0, warnings: 2 },
      warnings: [
        expect.stringContaining("resolves outside the workspace root"),
        expect.stringContaining("No Claw entries were selected"),
      ],
    });
  });

  it("prints only manifest JSON when export has no output path", async () => {
    await runCli([
      "claws",
      "export",
      "--id",
      "starter",
      "--name",
      "Starter",
      "--plugin",
      "terminal",
    ]);

    expect(mocks.logs).toHaveLength(1);
    const manifest = JSON.parse(mocks.logs[0]);
    expect(manifest).toMatchObject({
      schemaVersion: "openclaw.claw.v1",
      id: "starter",
      entries: [{ id: "plugin-terminal" }],
    });
  });

  it("rejects exports that select no manifest entries", async () => {
    pluginRecordMock.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-export-empty-"));
    const outPath = join(workspaceRoot, "empty.claw.json");

    await runCli([
      "claws",
      "export",
      "--id",
      "empty",
      "--name",
      "Empty",
      "--workspace",
      workspaceRoot,
      "--out",
      outPath,
      "--json",
    ]);

    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      error: { code: "claw_export_empty" },
      summary: { plugins: 0, workspaceFiles: 0, personas: 0, warnings: 1 },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    await expect(readFile(outPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not report a written manifest for empty text exports", async () => {
    pluginRecordMock.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-export-empty-text-"));
    const outPath = join(workspaceRoot, "empty.claw.json");

    await runCli([
      "claws",
      "export",
      "--id",
      "empty",
      "--name",
      "Empty",
      "--workspace",
      workspaceRoot,
      "--out",
      outPath,
    ]);

    expect(mocks.errors).toEqual(["Claw export did not select any entries."]);
    expect(mocks.logs).not.toContain(`Claw manifest written: `);
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    await expect(readFile(outPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints JSON inspection for a local claw manifest", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "starter",
      name: "Starter",
      version: "1.0.0",
      entries: [
        {
          kind: "plugin",
          id: "example-plugin",
          selector: "npm:@openclaw/plugin-example@1.0.0",
        },
      ],
    });

    await runCli(["claws", "inspect", manifestPath, "--json"]);

    expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      valid: true,
      manifest: {
        id: "starter",
        entries: [{ kind: "plugin", required: true }],
      },
    });
  });

  it("prints unsupported required entries in local dry-run apply previews", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "starter",
      name: "Starter",
      version: "1.0.0",
      entries: [
        {
          kind: "plugin",
          id: "bad-plugin",
          selector: "registry.example.com/plugin.tgz",
        },
      ],
    });

    await runCli(["claws", "apply", manifestPath, "--dry-run"]);

    expect(mocks.logs).toContain("Blocked entries: 1");
  });

  it("prints unsupported required entries in feed dry-run apply previews", async () => {
    const feedPath = await writeFeedWorkspace({
      manifest: {
        schemaVersion: "openclaw.claw.v1",
        id: "starter",
        name: "Starter",
        version: "1.0.0",
        entries: [
          {
            kind: "plugin",
            id: "bad-plugin",
            selector: "registry.example.com/plugin.tgz",
          },
        ],
      },
    });

    await runCli(["claws", "feed", "apply", feedPath, "starter", "--dry-run"]);

    expect(mocks.logs).toContain("Blocked entries: 1");
  });

  it("builds a dry-run JSON apply plan", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "starter",
      name: "Starter",
      version: "1.0.0",
      entries: [
        {
          kind: "plugin",
          id: "example-plugin",
          selector: "npm:@openclaw/plugin-example@1.0.0",
        },
        {
          kind: "workspaceFile",
          id: "soul",
          path: "SOUL.md",
          source: "files/SOUL.md",
        },
      ],
    });

    await runCli(["claws", "apply", manifestPath, "--dry-run", "--json"]);

    expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      schemaVersion: "openclaw.clawApplyPlan.v1",
      dryRun: true,
      mutationAllowed: false,
      summary: { totalEntries: 2, installActions: 2, consentRequired: 1 },
      entries: [
        {
          id: "example-plugin",
          action: "installArtifact",
          rollback: { action: "uninstallArtifact" },
        },
        { id: "soul", action: "writeWorkspaceFile", consentRequired: true },
      ],
    });
  });

  it("requires --dry-run before apply can preview lifecycle actions", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "starter",
      name: "Starter",
      version: "1.0.0",
      entries: [],
    });

    await runCli(["claws", "apply", manifestPath]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Claw apply mutates workspace files and package-like artifact provenance in this OpenClaw build; pass --dry-run to preview or --yes to apply supported Claw mutations.",
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("applies workspace files and persists artifact provenance when apply is confirmed", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-apply-"));
    closeOpenClawStateDatabaseForTest();
    try {
      const manifestPath = await writeManifest({
        schemaVersion: "openclaw.claw.v1",
        id: "starter",
        name: "Starter",
        version: "1.0.0",
        entries: [
          {
            kind: "plugin",
            id: "example-plugin",
            selector: "npm:@openclaw/plugin-example@1.0.0",
          },
          {
            kind: "workspaceFile",
            id: "soul",
            path: "SOUL.md",
            source: "files/SOUL.md",
          },
        ],
      });

      const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-workspace-"));

      await runCli([
        "claws",
        "apply",
        manifestPath,
        "--yes",
        "--workspace",
        workspaceRoot,
        "--json",
      ]);

      expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
      expect(artifactInstallerMock.applyClawArtifactInstallers).toHaveBeenCalledOnce();
      expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
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
        artifacts: [
          {
            clawId: "starter",
            entryId: "example-plugin",
            artifactKey: "plugins:npm:@openclaw/plugin-example@1.0.0",
            ownership: { clawRefs: ["starter"], refCount: 1 },
          },
        ],
        workspaceFiles: [
          {
            clawId: "starter",
            entryId: "soul",
            workspaceRoot,
            operation: "created",
          },
        ],
      });
      await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).resolves.toBe(
        "starter soul\n",
      );
      mocks.runtime.writeJson.mockClear();
      await runCli([
        "claws",
        "apply",
        manifestPath,
        "--yes",
        "--workspace",
        workspaceRoot,
        "--json",
      ]);
      expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
        summary: { appliedWorkspaceFiles: 0, provenanceRecords: 2 },
        workspaceFiles: [{ entryId: "soul", operation: "unchanged" }],
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("does not install artifacts when workspace apply validation fails", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-apply-"));
    closeOpenClawStateDatabaseForTest();
    try {
      const manifestPath = await writeManifest({
        schemaVersion: "openclaw.claw.v1",
        id: "starter",
        name: "Starter",
        version: "1.0.0",
        entries: [
          {
            kind: "plugin",
            id: "example-plugin",
            selector: "npm:@openclaw/plugin-example@1.0.0",
          },
          {
            kind: "workspaceFile",
            id: "soul",
            path: "SOUL.md",
            source: "files/SOUL.md",
          },
        ],
      });
      const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-workspace-"));
      await writeFile(join(workspaceRoot, "SOUL.md"), "user content\n", "utf8");

      await runCli(["claws", "apply", manifestPath, "--yes", "--workspace", workspaceRoot]);

      expect(artifactInstallerMock.applyClawArtifactInstallers).not.toHaveBeenCalled();
      expect(mocks.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("workspace_file_conflict"),
      );
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("does not write workspace files when artifact installation fails", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-apply-"));
    closeOpenClawStateDatabaseForTest();
    try {
      const manifestPath = await writeManifest({
        schemaVersion: "openclaw.claw.v1",
        id: "starter",
        name: "Starter",
        version: "1.0.0",
        entries: [
          {
            kind: "plugin",
            id: "example-plugin",
            selector: "npm:@openclaw/plugin-example@1.0.0",
          },
          {
            kind: "workspaceFile",
            id: "soul",
            path: "SOUL.md",
            source: "files/SOUL.md",
          },
        ],
      });
      const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-workspace-"));
      artifactInstallerMock.applyClawArtifactInstallers.mockRejectedValueOnce(
        new ClawArtifactApplyError([
          {
            level: "error",
            code: "artifact_install_failed",
            path: "$.entries[0]",
            message: "install failed",
          },
        ]),
      );

      await runCli(["claws", "apply", manifestPath, "--yes", "--workspace", workspaceRoot]);

      await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(mocks.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("artifact_install_failed"),
      );
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("persists artifact provenance when a later workspace write fails", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-apply-"));
    closeOpenClawStateDatabaseForTest();
    try {
      const manifestPath = await writeManifest({
        schemaVersion: "openclaw.claw.v1",
        id: "starter",
        name: "Starter",
        version: "1.0.0",
        entries: [
          {
            kind: "plugin",
            id: "example-plugin",
            selector: "npm:@openclaw/plugin-example@1.0.0",
          },
          {
            kind: "workspaceFile",
            id: "soul",
            path: "SOUL.md",
            source: "files/SOUL.md",
          },
        ],
      });
      const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-workspace-"));
      artifactInstallerMock.applyClawArtifactInstallers.mockImplementationOnce(async () => {
        await writeFile(join(workspaceRoot, "SOUL.md"), "raced user content\n", "utf8");
        return {
          directArtifactKeys: new Set<string>(),
          createdArtifactKeys: new Set<string>(["plugins:npm:@openclaw/plugin-example@1.0.0"]),
          installedArtifactKeys: new Set<string>(["plugins:npm:@openclaw/plugin-example@1.0.0"]),
        };
      });

      await runCli(["claws", "apply", manifestPath, "--yes", "--workspace", workspaceRoot]);

      expect(mocks.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("workspace_file_conflict"),
      );
      expect(
        readClawArtifactRefsForArtifactKey("plugins:npm:@openclaw/plugin-example@1.0.0"),
      ).toMatchObject([
        { clawId: "starter", entryId: "example-plugin", ownership: { clawRefs: ["starter"] } },
      ]);
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("applies workspace files from a feed entry", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = await mkdtemp(
      join(tmpdir(), "openclaw-claws-cli-feed-apply-"),
    );
    closeOpenClawStateDatabaseForTest();
    try {
      const feedPath = await writeFeedWorkspace();
      const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-feed-workspace-"));

      await runCli([
        "claws",
        "feed",
        "apply",
        feedPath,
        "starter",
        "--yes",
        "--workspace",
        workspaceRoot,
        "--json",
      ]);

      expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
      expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
        schemaVersion: "openclaw.clawApplyResult.v1",
        feed: { id: "local-starters", entry: { id: "starter" } },
        summary: { appliedWorkspaceFiles: 1, previewOnlyEntries: 0, provenanceRecords: 1 },
        workspaceFiles: [{ entryId: "soul", workspaceRoot, operation: "created" }],
      });
      await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).resolves.toBe("feed soul\n");
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("builds a dry-run JSON apply plan from a feed entry", async () => {
    const feedPath = await writeFeedWorkspace();

    await runCli(["claws", "feed", "apply", feedPath, "starter", "--dry-run", "--json"]);

    expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      schemaVersion: "openclaw.clawApplyPlan.v1",
      dryRun: true,
      mutationAllowed: false,
      feed: { id: "local-starters", entry: { id: "starter" } },
      summary: { totalEntries: 1, consentRequired: 1, rollbackActions: 1 },
    });
  });

  it("prints JSON inspection for a local claw feed", async () => {
    const feedPath = await writeFeedWorkspace();

    await runCli(["claws", "feed", "inspect", feedPath, "--json"]);

    expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      valid: true,
      feed: {
        id: "local-starters",
        entries: [{ id: "starter", owner: { type: "publisher" } }],
      },
    });
  });

  it("exits non-zero for invalid feed sources", async () => {
    const feedPath = await writeFeedWorkspace({
      feed: {
        schemaVersion: "openclaw.clawFeed.v1",
        id: "local-starters",
        name: "Local Starters",
        entries: [
          {
            id: "starter",
            name: "Starter",
            version: "1.0.0",
            source: "https://clawhub.ai/claws/starter.json",
            owner: { type: "publisher", id: "openclaw.examples" },
          },
        ],
      },
    });

    await runCli(["claws", "feed", "apply", feedPath, "starter", "--dry-run"]);

    expect(mocks.runtime.error).toHaveBeenCalled();
    expect(mocks.errors.join("\n")).toContain("unsupported_feed_source");
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("reports persisted Claw status", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-status-"));
    closeOpenClawStateDatabaseForTest();
    try {
      const manifestPath = await writeManifest({
        schemaVersion: "openclaw.claw.v1",
        id: "starter",
        name: "Starter",
        version: "1.0.0",
        entries: [
          {
            kind: "plugin",
            id: "example-plugin",
            selector: "npm:@openclaw/plugin-example@1.0.0",
          },
          {
            kind: "workspaceFile",
            id: "soul",
            path: "SOUL.md",
            source: "files/SOUL.md",
          },
        ],
      });
      const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-status-workspace-"));
      await runCli(["claws", "apply", manifestPath, "--yes", "--workspace", workspaceRoot]);
      mocks.runtime.writeJson.mockClear();

      await runCli(["claws", "status", "starter", "--json"]);

      expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
      expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
        schemaVersion: "openclaw.clawStatus.v1",
        summary: { claws: 1, artifactRefs: 1, workspaceFileRefs: 1 },
        records: [
          {
            clawId: "starter",
            clawVersion: "1.0.0",
            artifacts: [{ entryId: "example-plugin" }],
            workspaceFiles: [{ entryId: "soul", workspaceRoot }],
          },
        ],
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("requires --dry-run or --yes before removing Claw state", async () => {
    await runCli(["claws", "remove", "starter"]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Claw remove deletes Claw-managed workspace files and persisted Claw refs; pass --dry-run to preview or --yes to remove.",
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("dry-runs Claw remove without deleting files or refs", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-remove-"));
    closeOpenClawStateDatabaseForTest();
    try {
      const manifestPath = await writeManifest({
        schemaVersion: "openclaw.claw.v1",
        id: "starter",
        name: "Starter",
        version: "1.0.0",
        entries: [
          {
            kind: "workspaceFile",
            id: "soul",
            path: "SOUL.md",
            source: "files/SOUL.md",
          },
        ],
      });
      const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-remove-workspace-"));
      await runCli(["claws", "apply", manifestPath, "--yes", "--workspace", workspaceRoot]);
      mocks.runtime.writeJson.mockClear();

      await runCli(["claws", "remove", "starter", "--dry-run", "--json"]);

      expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
        schemaVersion: "openclaw.clawRemoveResult.v1",
        dryRun: true,
        found: true,
        summary: {
          artifactRefsRemoved: 0,
          workspaceFileRefsRemoved: 0,
          workspaceFilesDeleted: 0,
          workspaceFilesRetained: 1,
          errors: 0,
        },
        workspaceFiles: [{ entryId: "soul", action: "dryRunDelete" }],
      });
      await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).resolves.toBe(
        "starter soul\n",
      );
      mocks.runtime.writeJson.mockClear();
      await runCli(["claws", "status", "starter", "--json"]);
      expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
        summary: { claws: 1, workspaceFileRefs: 1 },
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("removes Claw refs and deletes unchanged managed workspace files", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-remove-"));
    closeOpenClawStateDatabaseForTest();
    try {
      const manifestPath = await writeManifest({
        schemaVersion: "openclaw.claw.v1",
        id: "starter",
        name: "Starter",
        version: "1.0.0",
        entries: [
          {
            kind: "plugin",
            id: "example-plugin",
            selector: "npm:@openclaw/plugin-example@1.0.0",
          },
          {
            kind: "workspaceFile",
            id: "soul",
            path: "SOUL.md",
            source: "files/SOUL.md",
          },
        ],
      });
      const workspaceRoot = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-remove-workspace-"));
      await runCli(["claws", "apply", manifestPath, "--yes", "--workspace", workspaceRoot]);
      mocks.runtime.writeJson.mockClear();

      await runCli(["claws", "remove", "starter", "--yes", "--json"]);

      expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
        dryRun: false,
        found: true,
        summary: {
          artifactRefsRemoved: 1,
          workspaceFileRefsRemoved: 1,
          workspaceFilesDeleted: 1,
          workspaceFilesRetained: 0,
          errors: 0,
        },
      });
      await expect(readFile(join(workspaceRoot, "SOUL.md"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      mocks.runtime.writeJson.mockClear();
      await runCli(["claws", "status", "starter", "--json"]);
      expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
        summary: { claws: 0, artifactRefs: 0, workspaceFileRefs: 0 },
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("exits non-zero for invalid manifests", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "starter",
      name: "Starter",
      version: "1.0.0",
      entries: [{ kind: "plugin", id: "missing-selector" }],
    });

    await runCli(["claws", "inspect", manifestPath]);

    expect(mocks.runtime.error).toHaveBeenCalled();
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });
});
