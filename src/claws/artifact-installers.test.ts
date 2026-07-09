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

  it("rejects required artifact surfaces until installers exist", async () => {
    const applyPlan = planWithEntries([
      { kind: "mcpServer", id: "market-data", selector: "clawhub:market-data@1.0.0" },
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
          message: expect.stringContaining("install surface mcpServers"),
        },
      ],
    });
  });

  it("skips optional non-plugin artifact surfaces while applying plugins", async () => {
    const applyPlan = planWithEntries([
      {
        kind: "connector",
        id: "optional-market-data",
        selector: "clawhub:market-data@1.0.0",
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

  it("delegates missing ClawHub skills to the existing skill installer", async () => {
    const applyPlan = planWithEntries([
      { kind: "skill", id: "sec-filings", selector: "clawhub:sec-filings@1.0.0" },
    ]);
    const installSkillFromClawHub = vi.fn(async () => ({
      ok: true as const,
      slug: "sec-filings",
      version: "1.0.0",
      targetDir: "/workspace/.agents/skills/sec-filings",
    }));

    const result = await applyClawArtifactInstallers(applyPlan, {
      runtime: runtime() as never,
      deps: {
        loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
        installSkillFromClawHub,
        readClawHubSkillsLockfileStatusSync: vi.fn(() => ({ kind: "missing" as const })),
        resolveSkillsWorkspaceDir: () => ({ config: {}, workspaceDir: "/workspace" }),
      },
    });

    expect(installSkillFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace",
        slug: "sec-filings",
        version: "1.0.0",
        acknowledgeClawHubRisk: true,
      }),
    );
    expect([...result.createdArtifactKeys]).toEqual(["skills:clawhub:sec-filings@1.0.0"]);
  });

  it("skips owner-qualified ClawHub skills tracked under their normalized slug", async () => {
    const applyPlan = planWithEntries([
      { kind: "skill", id: "sec-filings", selector: "clawhub:@owner/sec-filings@1.0.0" },
    ]);
    const installSkillFromClawHub = vi.fn();

    const result = await applyClawArtifactInstallers(applyPlan, {
      runtime: runtime() as never,
      deps: {
        loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
        installSkillFromClawHub,
        readClawHubSkillsLockfileStatusSync: vi.fn(() => ({
          kind: "found" as const,
          path: "/workspace/.clawhub/lock.json",
          lock: {
            version: 1 as const,
            skills: {
              "sec-filings": { version: "1.0.0", installedAt: 1, ownerHandle: "owner" },
            },
          },
        })),
        resolveClawHubSkillStatusLinkSync: vi.fn(() => ({
          status: "linked" as const,
          valid: true as const,
          registry: "https://clawhub.openclaw.ai",
          slug: "sec-filings",
          ownerHandle: "owner",
          installedVersion: "1.0.0",
          installedAt: 1,
          originPath: "/workspace/.agents/skills/sec-filings/.clawhub/origin.json",
          lockPath: "/workspace/.clawhub/lock.json",
        })),
        resolveSkillsWorkspaceDir: () => ({ config: {}, workspaceDir: "/workspace" }),
      },
    });

    expect(installSkillFromClawHub).not.toHaveBeenCalled();
    expect([...result.createdArtifactKeys]).toEqual([]);
  });

  it("skips ClawHub skill installs already tracked in the workspace lockfile", async () => {
    const applyPlan = planWithEntries([
      { kind: "skill", id: "sec-filings", selector: "clawhub:sec-filings@1.0.0" },
    ]);
    const installSkillFromClawHub = vi.fn();

    const result = await applyClawArtifactInstallers(applyPlan, {
      runtime: runtime() as never,
      deps: {
        loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
        installSkillFromClawHub,
        readClawHubSkillsLockfileStatusSync: vi.fn(() => ({
          kind: "found" as const,
          path: "/workspace/.clawhub/lock.json",
          lock: {
            version: 1 as const,
            skills: { "sec-filings": { version: "1.0.0", installedAt: 1 } },
          },
        })),
        resolveClawHubSkillStatusLinkSync: vi.fn(() => ({
          status: "linked" as const,
          valid: true as const,
          registry: "https://clawhub.openclaw.ai",
          slug: "sec-filings",
          installedVersion: "1.0.0",
          installedAt: 1,
          originPath: "/workspace/.agents/skills/sec-filings/.clawhub/origin.json",
          lockPath: "/workspace/.clawhub/lock.json",
        })),
        resolveSkillsWorkspaceDir: () => ({ config: {}, workspaceDir: "/workspace" }),
      },
    });

    expect(installSkillFromClawHub).not.toHaveBeenCalled();
    expect([...result.createdArtifactKeys]).toEqual([]);
  });

  it("does not skip ClawHub skills with stale lockfile-only state", async () => {
    const applyPlan = planWithEntries([
      { kind: "skill", id: "sec-filings", selector: "clawhub:sec-filings@1.0.0" },
    ]);
    const installSkillFromClawHub = vi.fn(async () => ({
      ok: true as const,
      slug: "sec-filings",
      version: "1.0.0",
      targetDir: "/workspace/.agents/skills/sec-filings",
    }));

    await applyClawArtifactInstallers(applyPlan, {
      runtime: runtime() as never,
      deps: {
        loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
        installSkillFromClawHub,
        readClawHubSkillsLockfileStatusSync: vi.fn(() => ({
          kind: "found" as const,
          path: "/workspace/.clawhub/lock.json",
          lock: {
            version: 1 as const,
            skills: { "sec-filings": { version: "1.0.0", installedAt: 1 } },
          },
        })),
        resolveClawHubSkillStatusLinkSync: vi.fn(() => ({
          status: "invalid" as const,
          valid: false as const,
          reason: "missing local ClawHub origin metadata",
        })),
        resolveSkillsWorkspaceDir: () => ({ config: {}, workspaceDir: "/workspace" }),
      },
    });

    expect(installSkillFromClawHub).toHaveBeenCalledOnce();
  });

  it("delegates local skill artifacts to source installs relative to the manifest", async () => {
    const applyPlan = planWithEntries([
      { kind: "skill", id: "sec-filings", selector: "./skills/sec-filings" },
    ]);
    applyPlan.claw.sourcePath = "/repo/claws/starter.claw.json";
    const installSkillFromSource = vi.fn(async () => ({
      ok: true as const,
      slug: "sec-filings",
      targetDir: "/workspace/.agents/skills/sec-filings",
      source: "path" as const,
    }));

    const result = await applyClawArtifactInstallers(applyPlan, {
      runtime: runtime() as never,
      deps: {
        loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
        installSkillFromSource,
        resolveSkillsWorkspaceDir: () => ({ config: {}, workspaceDir: "/workspace" }),
      },
    });

    expect(installSkillFromSource).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace",
        spec: "/repo/claws/skills/sec-filings",
        slug: "sec-filings",
      }),
    );
    expect([...result.createdArtifactKeys]).toEqual(["skills:path:/repo/claws/skills/sec-filings"]);
  });

  it("skips local skill artifacts when source-origin metadata matches", async () => {
    const applyPlan = planWithEntries([
      { kind: "skill", id: "sec-filings", selector: "./skills/sec-filings" },
    ]);
    applyPlan.claw.sourcePath = "/repo/claws/starter.claw.json";
    const installSkillFromSource = vi.fn();

    await applyClawArtifactInstallers(applyPlan, {
      runtime: runtime() as never,
      deps: {
        loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
        installSkillFromSource,
        readSkillSourceOrigin: vi.fn(async () => ({
          version: 1 as const,
          source: "path" as const,
          slug: "sec-filings",
          spec: "/repo/claws/skills/sec-filings",
        })),
        resolveSkillsWorkspaceDir: () => ({ config: {}, workspaceDir: "/workspace" }),
      },
    });

    expect(installSkillFromSource).not.toHaveBeenCalled();
  });

  it("does not skip local skill artifacts without matching source-origin metadata", async () => {
    const applyPlan = planWithEntries([
      { kind: "skill", id: "sec-filings", selector: "./skills/sec-filings" },
    ]);
    applyPlan.claw.sourcePath = "/repo/claws/starter.claw.json";
    const installSkillFromSource = vi.fn(async () => ({
      ok: true as const,
      slug: "sec-filings",
      targetDir: "/workspace/.agents/skills/sec-filings",
      source: "path" as const,
    }));

    await applyClawArtifactInstallers(applyPlan, {
      runtime: runtime() as never,
      deps: {
        loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
        installSkillFromSource,
        readSkillSourceOrigin: vi.fn(async () => undefined),
        resolveSkillsWorkspaceDir: () => ({ config: {}, workspaceDir: "/workspace" }),
      },
    });

    expect(installSkillFromSource).toHaveBeenCalledOnce();
  });

  it("skips optional skill selectors without an existing skill install path", async () => {
    const applyPlan = planWithEntries([
      {
        kind: "skill",
        id: "optional-sec-filings",
        selector: "npm:@openclaw/skill-sec-filings@1.0.0",
        required: false,
      },
    ]);
    const result = await applyClawArtifactInstallers(applyPlan, {
      runtime: runtime() as never,
      deps: {
        loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
        resolveSkillsWorkspaceDir: () => ({ config: {}, workspaceDir: "/workspace" }),
      },
    });

    expect([...result.createdArtifactKeys]).toEqual([]);
  });

  it("rejects non-owner-qualified ClawHub skill paths with diagnostics", async () => {
    const applyPlan = planWithEntries([
      { kind: "skill", id: "bad-skill", selector: "clawhub:owner/sec@1.0.0" },
    ]);

    await expect(
      applyClawArtifactInstallers(applyPlan, {
        runtime: runtime() as never,
        deps: {
          loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
          readClawHubSkillsLockfileStatusSync: vi.fn(() => ({ kind: "missing" as const })),
          resolveSkillsWorkspaceDir: () => ({ config: {}, workspaceDir: "/workspace" }),
        },
      }),
    ).rejects.toMatchObject({
      diagnostics: [
        {
          code: "skill_artifact_selector_invalid",
          message: expect.stringContaining("clawhub:owner/sec@1.0.0"),
        },
      ],
    });
  });

  it("rejects invalid ClawHub skill selectors with diagnostics", async () => {
    const applyPlan = planWithEntries([
      { kind: "skill", id: "bad-skill", selector: "clawhub:@bad" },
    ]);

    await expect(
      applyClawArtifactInstallers(applyPlan, {
        runtime: runtime() as never,
        deps: {
          loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
          readClawHubSkillsLockfileStatusSync: vi.fn(() => ({ kind: "missing" as const })),
          resolveSkillsWorkspaceDir: () => ({ config: {}, workspaceDir: "/workspace" }),
        },
      }),
    ).rejects.toMatchObject({
      diagnostics: [
        {
          code: "skill_artifact_selector_invalid",
          message: expect.stringContaining("clawhub:@bad"),
        },
      ],
    });
  });

  it("rejects skill selectors without an existing skill install path", async () => {
    const applyPlan = planWithEntries([
      { kind: "skill", id: "sec-filings", selector: "npm:@openclaw/skill-sec-filings@1.0.0" },
    ]);

    await expect(
      applyClawArtifactInstallers(applyPlan, {
        runtime: runtime() as never,
        deps: {
          loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
          resolveSkillsWorkspaceDir: () => ({ config: {}, workspaceDir: "/workspace" }),
        },
      }),
    ).rejects.toMatchObject({
      diagnostics: [
        {
          code: "skill_artifact_source_unsupported",
          message: expect.stringContaining("npm:@openclaw/skill-sec-filings@1.0.0"),
        },
      ],
    });
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
