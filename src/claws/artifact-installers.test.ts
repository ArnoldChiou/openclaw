// Tests for Claw artifact installer delegation and ownership hinting.
import { describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { applyClawArtifactInstallers } from "./artifact-installers.js";
import { buildClawApplyPlan } from "./lifecycle.js";
import { buildClawPlan } from "./plan.js";
import { parseClawManifest } from "./schema.js";

function plan(selector = "npm:@openclaw/plugin-example@1.0.0") {
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
  return buildClawApplyPlan(buildClawPlan({ manifest: parsed.manifest }));
}

function npmRecord(): PluginInstallRecord {
  return {
    source: "npm",
    spec: "@openclaw/plugin-example@1.0.0",
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
  it("records direct ownership and skips installer when the plugin already exists", async () => {
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
    expect([...result.directArtifactKeys]).toEqual(["plugins:npm:@openclaw/plugin-example@1.0.0"]);
    expect([...result.createdArtifactKeys]).toEqual([]);
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
      }),
    );
    expect([...result.createdArtifactKeys]).toEqual(["plugins:npm:@openclaw/plugin-example@1.0.0"]);
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
