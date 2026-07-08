// Tests for Claw artifact installer delegation and ownership hinting.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawArtifactInstallers } from "./artifact-installers.js";
import { buildClawApplyPlan } from "./lifecycle.js";
import { buildClawPlan } from "./plan.js";
import { persistClawArtifactApplyProvenance } from "./provenance.js";
import { parseClawManifest } from "./schema.js";

const readConfigFileSnapshotMock: ReturnType<typeof vi.fn> = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

function plan(selector = "npm:@openclaw/plugin-example@1.0.0", sourcePath?: string) {
  const parsed = parseClawManifest({
    schemaVersion: "openclaw.claw.v1",
    id: "starter",
    name: "Starter",
    version: "1.0.0",
    entries: [{ kind: "plugin", id: "example-plugin", selector }],
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error("expected manifest to parse");
  }
  return buildClawApplyPlan(buildClawPlan({ manifest: parsed.manifest, sourcePath }));
}

function planWithEntries(entries: unknown[]) {
  const parsed = parseClawManifest({
    schemaVersion: "openclaw.claw.v1",
    id: "starter",
    name: "Starter",
    version: "1.0.0",
    entries,
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error("expected manifest to parse");
  }
  return buildClawApplyPlan(buildClawPlan({ manifest: parsed.manifest }));
}

function npmRecord(
  version = "1.0.0",
  spec = `@openclaw/plugin-example@${version}`,
): PluginInstallRecord {
  return {
    source: "npm",
    spec,
    resolvedName: "@openclaw/plugin-example",
    resolvedVersion: version,
    installPath: "/tmp/demo",
  };
}

function clawhubRecord(name = "foo", version = "1.2.3"): PluginInstallRecord {
  return {
    source: "clawhub",
    spec: `clawhub:${name}`,
    clawhubPackage: name,
    version,
    installPath: "/tmp/demo",
  };
}

function gitRecord(spec: string): PluginInstallRecord {
  return {
    source: "git",
    spec,
    installPath: "/tmp/demo",
  };
}

function pathRecord(sourcePath: string): PluginInstallRecord {
  return {
    source: "path",
    sourcePath,
    installPath: sourcePath,
  };
}

function npmPackRecord(sourcePath: string): PluginInstallRecord {
  return {
    source: "npm",
    spec: `npm-pack:${sourcePath}`,
    artifactKind: "npm-pack",
    sourcePath,
    resolvedName: "@openclaw/plugin-example",
    resolvedVersion: "1.0.0",
    installPath: "/tmp/demo",
  };
}

function runtime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
  };
}

describe("applyClawArtifactInstallers", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockReset();
    readConfigFileSnapshotMock.mockRejectedValue(new Error("no config"));
  });

  it("rejects non-plugin artifact surfaces until installers exist", async () => {
    const applyPlan = planWithEntries([
      { kind: "skill", id: "sec-filings", selector: "clawhub:sec-filings@1.0.0" },
    ]);

    await expect(
      applyClawArtifactInstallers(applyPlan, {
        runtime: runtime() as never,
        deps: {
          loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
          runPluginInstallCommand: vi.fn(),
        },
      }),
    ).rejects.toMatchObject({
      diagnostics: [
        {
          code: "artifact_install_surface_unsupported",
          path: "$.entries[0]",
          message: expect.stringContaining("install surface skills"),
        },
      ],
    });
  });

  it("skips optional non-plugin artifact surfaces while applying plugins", async () => {
    const applyPlan = planWithEntries([
      {
        kind: "skill",
        id: "optional-sec-filings",
        selector: "clawhub:sec-filings@1.0.0",
        required: false,
      },
      { kind: "plugin", id: "example-plugin", selector: "npm:@openclaw/plugin-example@1.0.0" },
    ]);
    const loadInstalledPluginIndexInstallRecords = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ demo: npmRecord() });
    const runPluginInstallCommand = vi.fn(async () => undefined);

    const result = await applyClawArtifactInstallers(applyPlan, {
      runtime: runtime() as never,
      deps: { loadInstalledPluginIndexInstallRecords, runPluginInstallCommand },
    });

    expect(runPluginInstallCommand).toHaveBeenCalledOnce();
    expect([...result.createdArtifactKeys]).toEqual(["plugins:npm:@openclaw/plugin-example@1.0.0"]);
  });

  it("skips installer when the plugin already exists", async () => {
    const runPluginInstallCommand = vi.fn();
    const result = await applyClawArtifactInstallers(plan(), {
      runtime: runtime() as never,
      deps: {
        loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({
          demo: npmRecord(),
        })),
        runPluginInstallCommand,
      },
    });

    expect(runPluginInstallCommand).not.toHaveBeenCalled();
    expect([...result.directArtifactKeys]).toEqual([]);
    expect([...result.createdArtifactKeys]).toEqual([]);
  });

  it("skips existing installs when plugin allowlist is open with unrelated deny entries", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      config: { plugins: { deny: ["other-plugin"] } },
      sourceConfig: { plugins: { deny: ["other-plugin"] } },
    });
    const runPluginInstallCommand = vi.fn();

    const result = await applyClawArtifactInstallers(plan(), {
      runtime: runtime() as never,
      deps: {
        loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({
          demo: npmRecord(),
        })),
        runPluginInstallCommand,
      },
    });

    expect(runPluginInstallCommand).not.toHaveBeenCalled();
    expect([...result.createdArtifactKeys]).toEqual([]);
  });

  it("skips existing Claw-owned installs without claiming direct ownership", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = mkdtempSync(join(tmpdir(), "openclaw-claw-artifact-"));
    closeOpenClawStateDatabaseForTest();
    try {
      const applyPlan = plan();
      const artifactKey = "plugins:npm:@openclaw/plugin-example@1.0.0";
      persistClawArtifactApplyProvenance(applyPlan, {
        createdArtifactKeys: new Set([artifactKey]),
        nowMs: 1,
      });
      const runPluginInstallCommand = vi.fn();

      const result = await applyClawArtifactInstallers(applyPlan, {
        runtime: runtime() as never,
        deps: {
          loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({
            demo: npmRecord(),
          })),
          runPluginInstallCommand,
        },
      });

      expect(runPluginInstallCommand).not.toHaveBeenCalled();
      expect([...result.directArtifactKeys]).toEqual([]);
      expect([...result.createdArtifactKeys]).toEqual([]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      closeOpenClawStateDatabaseForTest();
    }
  });

  it("suppresses delegated installer progress logs when quiet", async () => {
    const loadInstalledPluginIndexInstallRecords = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ demo: npmRecord() });
    const runPluginInstallCommand = vi.fn(async ({ runtime }) => {
      runtime.log("installer progress");
    });
    const testRuntime = runtime();

    await applyClawArtifactInstallers(plan(), {
      runtime: testRuntime as never,
      quiet: true,
      deps: { loadInstalledPluginIndexInstallRecords, runPluginInstallCommand },
    });

    expect(testRuntime.log).not.toHaveBeenCalled();
  });

  it("delegates missing plugins to the existing plugin install command", async () => {
    const loadInstalledPluginIndexInstallRecords = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        demo: npmRecord(),
      });
    const runPluginInstallCommand = vi.fn(async () => undefined);

    const result = await applyClawArtifactInstallers(plan(), {
      runtime: runtime() as never,
      deps: { loadInstalledPluginIndexInstallRecords, runPluginInstallCommand },
    });

    expect(runPluginInstallCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: "npm:@openclaw/plugin-example@1.0.0",
        invalidateRuntimeCache: false,
        opts: { pluginOnly: true },
      }),
    );
    expect([...result.createdArtifactKeys]).toEqual(["plugins:npm:@openclaw/plugin-example@1.0.0"]);
  });
  it("verifies floating npm selectors against the resolved installed package", async () => {
    const loadInstalledPluginIndexInstallRecords = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        demo: npmRecord("2.0.0", "@openclaw/plugin-example@latest"),
      });
    const runPluginInstallCommand = vi.fn(async () => undefined);

    const result = await applyClawArtifactInstallers(plan("npm:@openclaw/plugin-example@latest"), {
      runtime: runtime() as never,
      deps: { loadInstalledPluginIndexInstallRecords, runPluginInstallCommand },
    });

    expect([...result.createdArtifactKeys]).toEqual([
      "plugins:npm:@openclaw/plugin-example@latest",
    ]);
  });

  it("does not reinstall duplicate entries for the same artifact", async () => {
    const applyPlan = planWithEntries([
      { kind: "plugin", id: "example-plugin", selector: "npm:@openclaw/plugin-example@1.0.0" },
      { kind: "plugin", id: "example-plugin-copy", selector: "npm:@openclaw/plugin-example@1.0.0" },
    ]);
    const loadInstalledPluginIndexInstallRecords = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ demo: npmRecord() });
    const runPluginInstallCommand = vi.fn(async () => undefined);

    const result = await applyClawArtifactInstallers(applyPlan, {
      runtime: runtime() as never,
      deps: { loadInstalledPluginIndexInstallRecords, runPluginInstallCommand },
    });

    expect(runPluginInstallCommand).toHaveBeenCalledOnce();
    expect([...result.createdArtifactKeys]).toEqual(["plugins:npm:@openclaw/plugin-example@1.0.0"]);
  });

  it("does not reinstall equivalent entries satisfied by an earlier install", async () => {
    const applyPlan = planWithEntries([
      { kind: "plugin", id: "example-plugin-v", selector: "npm:@openclaw/plugin-example@v1.0.0" },
      { kind: "plugin", id: "example-plugin", selector: "npm:@openclaw/plugin-example@1.0.0" },
    ]);
    const loadInstalledPluginIndexInstallRecords = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ demo: npmRecord("1.0.0", "@openclaw/plugin-example@v1.0.0") });
    const runPluginInstallCommand = vi.fn(async () => undefined);

    const result = await applyClawArtifactInstallers(applyPlan, {
      runtime: runtime() as never,
      deps: { loadInstalledPluginIndexInstallRecords, runPluginInstallCommand },
    });

    expect(runPluginInstallCommand).toHaveBeenCalledOnce();
    expect(loadInstalledPluginIndexInstallRecords).toHaveBeenCalledTimes(2);
    expect([...result.createdArtifactKeys]).toEqual(["plugins:npm:@openclaw/plugin-example@1.0.0"]);
  });

  it("verifies leading-v exact npm selectors against resolved versions", async () => {
    const loadInstalledPluginIndexInstallRecords = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ demo: npmRecord("1.0.0", "@openclaw/plugin-example@v1.0.0") });
    const runPluginInstallCommand = vi.fn(async () => undefined);

    const result = await applyClawArtifactInstallers(plan("npm:@openclaw/plugin-example@v1.0.0"), {
      runtime: runtime() as never,
      deps: { loadInstalledPluginIndexInstallRecords, runPluginInstallCommand },
    });

    expect([...result.createdArtifactKeys]).toEqual(["plugins:npm:@openclaw/plugin-example@1.0.0"]);
  });

  it("verifies floating ClawHub selectors against resolved install records", async () => {
    const loadInstalledPluginIndexInstallRecords = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ demo: clawhubRecord("foo", "1.2.3") });
    const runPluginInstallCommand = vi.fn(async () => undefined);

    const result = await applyClawArtifactInstallers(plan("clawhub:foo"), {
      runtime: runtime() as never,
      deps: { loadInstalledPluginIndexInstallRecords, runPluginInstallCommand },
    });

    expect(runPluginInstallCommand).toHaveBeenCalledWith(
      expect.objectContaining({ raw: "clawhub:foo" }),
    );
    expect([...result.createdArtifactKeys]).toEqual(["plugins:clawhub:foo"]);
  });

  it("resolves local git selectors relative to the manifest before delegating", async () => {
    const sourcePath = "/tmp/claw/starter.claw.json";
    const gitSpec = "git:file:///tmp/claw/plugin-repo@main";
    const loadInstalledPluginIndexInstallRecords = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ demo: gitRecord(gitSpec) });
    const runPluginInstallCommand = vi.fn(async () => undefined);

    await applyClawArtifactInstallers(plan("git:./plugin-repo@main", sourcePath), {
      runtime: runtime() as never,
      deps: { loadInstalledPluginIndexInstallRecords, runPluginInstallCommand },
    });

    expect(runPluginInstallCommand).toHaveBeenCalledWith(expect.objectContaining({ raw: gitSpec }));
  });

  it("normalizes localhost file URLs before delegating local plugin installs", async () => {
    const pluginPath = "/tmp/openclaw-plugin";
    const loadInstalledPluginIndexInstallRecords = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ demo: pathRecord(pluginPath) });
    const runPluginInstallCommand = vi.fn(async () => undefined);

    const result = await applyClawArtifactInstallers(plan("file://localhost/tmp/openclaw-plugin"), {
      runtime: runtime() as never,
      deps: { loadInstalledPluginIndexInstallRecords, runPluginInstallCommand },
    });

    expect(runPluginInstallCommand).toHaveBeenCalledWith(
      expect.objectContaining({ raw: pluginPath }),
    );
    expect([...result.createdArtifactKeys]).toEqual([`plugins:path:${pluginPath}`]);
  });

  it("verifies npm-pack selectors against npm-pack install records", async () => {
    const sourcePath = "/tmp/claw/starter.claw.json";
    const archivePath = resolve("/tmp/claw", "plugin.tgz");
    const loadInstalledPluginIndexInstallRecords = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        demo: npmPackRecord(archivePath),
      });
    const runPluginInstallCommand = vi.fn(async () => undefined);

    const result = await applyClawArtifactInstallers(plan("npm-pack:./plugin.tgz", sourcePath), {
      runtime: runtime() as never,
      deps: { loadInstalledPluginIndexInstallRecords, runPluginInstallCommand },
    });

    expect(runPluginInstallCommand).toHaveBeenCalledWith(
      expect.objectContaining({ raw: `npm-pack:${archivePath}` }),
    );
    expect([...result.createdArtifactKeys]).toEqual([`plugins:npmPack:${archivePath}`]);
  });
  it("fails if the plugin installer does not persist the expected install record", async () => {
    const loadInstalledPluginIndexInstallRecords = vi.fn().mockResolvedValue({});
    const runPluginInstallCommand = vi.fn(async () => undefined);

    await expect(
      applyClawArtifactInstallers(plan(), {
        runtime: runtime() as never,
        deps: { loadInstalledPluginIndexInstallRecords, runPluginInstallCommand },
      }),
    ).rejects.toMatchObject({
      diagnostics: [
        {
          code: "artifact_install_record_missing",
          message: expect.stringContaining("plugins:npm:@openclaw/plugin-example@1.0.0"),
        },
      ],
    });
  });
});
