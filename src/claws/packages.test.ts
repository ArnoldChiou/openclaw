import { describe, expect, it, vi } from "vitest";
import { installClawPackages } from "./packages.js";
import type { PersistedClawPackageRef } from "./provenance.js";
import type { ClawAddPlan, ClawPackage } from "./types.js";

function plan(packages: ClawPackage[]): ClawAddPlan {
  return {
    schemaVersion: "openclaw.clawAddPlan.v1",
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    claw: {
      kind: "package",
      name: "incident-claw",
      version: "1.0.0",
      packageRoot: "/tmp/claw",
      manifestPath: "/tmp/claw/claw.json",
      integrity: "sha256:claw",
    },
    agent: {
      requestedId: "incident",
      finalId: "incident-2",
      workspace: "/tmp/incident-2",
      config: { id: "incident-2", workspace: "/tmp/incident-2" },
    },
    summary: {
      totalActions: packages.length,
      agentActions: 0,
      workspaceActions: 0,
      packageActions: packages.length,
      mcpServerActions: 0,
      cronJobActions: 0,
      blockedActions: 0,
    },
    actions: packages.map((pkg) => ({
      kind: "package",
      id: `${pkg.kind}:${pkg.ref}`,
      action: "install",
      target: `${pkg.source}:${pkg.ref}@${pkg.version}`,
      details: pkg,
      blocked: false,
    })),
    blockers: [],
    diagnostics: [],
  };
}

describe("installClawPackages", () => {
  it("installs skills into the created agent workspace at the pinned version", async () => {
    const installSkill = vi.fn().mockResolvedValue({
      ok: true,
      slug: "@owner/triage",
      version: "1.2.3",
      targetDir: "/tmp/incident-2/skills/triage",
    });
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "skill" });

    await installClawPackages(
      plan([{ kind: "skill", source: "clawhub", ref: "@owner/triage", version: "1.2.3" }]),
      { deps: { installSkill, persistPackageRef } },
    );

    expect(installSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/incident-2",
        slug: "@owner/triage",
        version: "1.2.3",
      }),
    );
    expect(persistPackageRef).toHaveBeenCalledOnce();
  });

  it("installs plugins through the shared plugin surface", async () => {
    const installPlugin = vi.fn().mockResolvedValue(undefined);
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "plugin" });

    await installClawPackages(
      plan([{ kind: "plugin", source: "clawhub", ref: "@owner/audit", version: "2.0.1" }]),
      { deps: { installPlugin, persistPackageRef } },
    );

    expect(installPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: "clawhub:@owner/audit@2.0.1",
        opts: {},
        invalidateRuntimeCache: false,
      }),
    );
  });

  it("retains successful package references when a later install fails", async () => {
    const installSkill = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, slug: "one", version: "1.0.0", targetDir: "/one" })
      .mockResolvedValueOnce({ ok: false, error: "registry unavailable" });
    const persisted = { kind: "skill", ref: "one" } as PersistedClawPackageRef;
    const persistPackageRef = vi.fn().mockReturnValue(persisted);

    await expect(
      installClawPackages(
        plan([
          { kind: "skill", source: "clawhub", ref: "one", version: "1.0.0" },
          { kind: "skill", source: "clawhub", ref: "two", version: "1.0.0" },
        ]),
        { deps: { installSkill, persistPackageRef } },
      ),
    ).rejects.toMatchObject({
      code: "package_install_failed",
      message: "registry unavailable",
      installedPackages: [persisted],
    });
  });
});
