// Tests for openclaw.claw.v1 manifest parsing.
import { describe, expect, it } from "vitest";
import { buildClawApplyPlan } from "./lifecycle.js";
import { buildClawPlan } from "./plan.js";
import { parseClawManifest } from "./schema.js";

const baseManifest = {
  schemaVersion: "openclaw.claw.v1",
  id: "financial-analyst",
  name: "Financial Analyst",
  version: "1.0.0",
  entries: [
    {
      kind: "skill",
      id: "sec-filings",
      selector: "clawhub:sec-filings@1.0.0",
    },
    {
      kind: "workspaceFile",
      id: "soul",
      path: "SOUL.md",
      source: "files/SOUL.md",
    },
  ],
};

describe("parseClawManifest", () => {
  it("parses known claw entries and defaults entries to required", () => {
    const result = parseClawManifest(baseManifest);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected manifest to parse");
    }
    expect(result.manifest.entries).toHaveLength(2);
    expect(result.manifest.entries[0]).toMatchObject({
      kind: "skill",
      id: "sec-filings",
      required: true,
    });
  });

  it("warns for optional unknown entry kinds without invalidating the manifest", () => {
    const result = parseClawManifest({
      ...baseManifest,
      entries: [
        ...baseManifest.entries,
        {
          kind: "futureThing",
          id: "future-entry",
          required: false,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected manifest to parse");
    }
    expect(result.manifest.optionalUnknownEntries).toEqual([
      { kind: "futureThing", id: "future-entry", required: false },
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "unsupported_optional_entry",
        path: "$.entries[2]",
      }),
    ]);
  });

  it("allows multiple optional unknown entries without ids", () => {
    const result = parseClawManifest({
      ...baseManifest,
      entries: [
        ...baseManifest.entries,
        {
          kind: "futureThing",
          required: false,
        },
        {
          kind: "anotherFutureThing",
          required: false,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected manifest to parse");
    }
    expect(result.manifest.optionalUnknownEntries).toEqual([
      { kind: "futureThing", required: false },
      { kind: "anotherFutureThing", required: false },
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "unsupported_optional_entry", path: "$.entries[2]" }),
      expect.objectContaining({ code: "unsupported_optional_entry", path: "$.entries[3]" }),
    ]);
  });

  it("fails unknown top-level manifest keys", () => {
    const result = parseClawManifest({
      ...baseManifest,
      surprise: true,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        path: "$",
      }),
    ]);
  });

  it("fails unknown keys on known entries", () => {
    const result = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "plugin",
          id: "example-plugin",
          selector: "npm:@openclaw/plugin-example@1.0.0",
          extra: true,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        path: "$.entries[0]",
      }),
    ]);
  });

  it("fails malformed optional entries with known kinds", () => {
    const result = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "plugin",
          id: "missing-selector",
          required: false,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        path: "$.entries[0].selector",
      }),
    ]);
  });

  it("reports nested paths for malformed known entry fields", () => {
    const result = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "plugin",
          id: "bad-selector",
          selector: 1,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        path: "$.entries[0].selector",
      }),
    ]);
  });

  it("fails required unknown entry kinds", () => {
    const result = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "futureThing",
          id: "future-entry",
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.level === "error")).toBe(true);
  });

  it("fails duplicate entry ids", () => {
    const result = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "skill",
          id: "duplicate",
          selector: "clawhub:first@1.0.0",
        },
        {
          kind: "futureThing",
          id: "future-entry",
          required: false,
        },
        {
          kind: "plugin",
          id: "duplicate",
          selector: "npm:@openclaw/plugin-second@1.0.0",
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "unsupported_optional_entry",
        path: "$.entries[1]",
      }),
      expect.objectContaining({
        level: "error",
        code: "duplicate_claw_entry",
        path: "$.entries[2]",
      }),
    ]);
  });

  it("fails optional unknown entry ids that duplicate known entries", () => {
    const result = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "skill",
          id: "duplicate",
          selector: "clawhub:first@1.0.0",
        },
        {
          kind: "futureThing",
          id: "duplicate",
          required: false,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "unsupported_optional_entry",
        path: "$.entries[1]",
      }),
      expect.objectContaining({
        level: "error",
        code: "duplicate_claw_entry",
        path: "$.entries[1]",
      }),
    ]);
  });
});

describe("buildClawPlan", () => {
  it("adds package artifact and provenance previews", () => {
    const parsed = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "skill",
          id: "sec-filings",
          selector: "clawhub:sec-filings@1.0.0",
        },
        {
          kind: "plugin",
          id: "terminal-plugin",
          selector: "npm:@openclaw/plugin-terminal@2.0.0+build.5",
        },
        {
          kind: "plugin",
          id: "packed-plugin",
          selector: "npm-pack:dist/plugin.tgz",
        },
        {
          kind: "plugin",
          id: "tagged-plugin",
          selector: "npm:tagged-plugin@beta",
        },
        {
          kind: "plugin",
          id: "git-plugin",
          selector: "git:github.com/acme/demo#0123456789abcdef0123456789abcdef01234567",
        },
        {
          kind: "plugin",
          id: "file-plugin",
          selector: "file:///tmp/openclaw-plugin",
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected manifest to parse");
    }

    const plan = buildClawPlan({ manifest: parsed.manifest, sourcePath: "/tmp/claw.json" });

    expect(plan.summary).toMatchObject({
      totalEntries: 6,
      unsupportedRequiredEntries: 0,
      unsupportedOptionalEntries: 0,
    });
    expect(plan.entries[0]).toMatchObject({
      id: "sec-filings",
      decision: "inspectOnly",
      artifact: {
        source: "clawhub",
        installSurface: "skills",
        packageName: "sec-filings",
        version: "1.0.0",
        provenance: {
          record: "skill.clawhubOrigin",
          requestedSpecifier: "clawhub:sec-filings@1.0.0",
          pinning: "pinned",
        },
        supported: true,
      },
    });
    expect(plan.entries[1]).toMatchObject({
      id: "terminal-plugin",
      artifact: {
        source: "npm",
        installSurface: "plugins",
        packageName: "@openclaw/plugin-terminal",
        version: "2.0.0+build.5",
        provenance: { record: "plugin.installRecord" },
      },
    });
    expect(plan.entries[2]).toMatchObject({
      id: "packed-plugin",
      decision: "inspectOnly",
      artifact: {
        source: "npmPack",
        selector: "npm-pack:dist/plugin.tgz",
        installSurface: "plugins",
        supported: true,
      },
    });
    expect(plan.entries[3]).toMatchObject({
      id: "tagged-plugin",
      artifact: {
        source: "npm",
        packageName: "tagged-plugin",
        version: "beta",
        provenance: { pinning: "floating" },
        supported: true,
      },
    });
    expect(plan.entries[4]).toMatchObject({
      id: "git-plugin",
      artifact: {
        source: "git",
        version: "0123456789abcdef0123456789abcdef01234567",
        provenance: { pinning: "pinned" },
        supported: true,
      },
    });
    expect(plan.entries[5]).toMatchObject({
      id: "file-plugin",
      artifact: {
        source: "path",
        selector: "file:///tmp/openclaw-plugin",
        supported: true,
      },
    });
  });

  it("previews absolute local package selectors as path artifacts", () => {
    const parsed = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "plugin",
          id: "absolute-posix-plugin",
          selector: "/tmp/openclaw-plugin",
        },
        {
          kind: "plugin",
          id: "absolute-windows-plugin",
          selector: "C:/tmp/openclaw-plugin",
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected manifest to parse");
    }

    const plan = buildClawPlan({ manifest: parsed.manifest });

    expect(plan.summary).toMatchObject({
      totalEntries: 2,
      unsupportedRequiredEntries: 0,
    });
    expect(plan.entries.map((entry) => entry.artifact)).toEqual([
      expect.objectContaining({
        source: "path",
        selector: "/tmp/openclaw-plugin",
        installSurface: "plugins",
        supported: true,
      }),
      expect.objectContaining({
        source: "path",
        selector: "C:/tmp/openclaw-plugin",
        installSurface: "plugins",
        supported: true,
      }),
    ]);
  });

  it("blocks trailing-at package selectors in the read-only plan", () => {
    const parsed = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "skill",
          id: "bad-skill",
          selector: "clawhub:demo@",
        },
        {
          kind: "plugin",
          id: "bad-plugin",
          selector: "npm:demo@",
        },
        {
          kind: "plugin",
          id: "bad-git",
          selector: "git:",
        },
        {
          kind: "plugin",
          id: "bad-git-plus",
          selector: "git+",
        },
        {
          kind: "plugin",
          id: "bad-git-plus-url",
          selector: "git+ssh://github.com/acme/demo.git",
        },
        {
          kind: "plugin",
          id: "bad-file",
          selector: "file:",
        },
        {
          kind: "plugin",
          id: "bad-hosted-file",
          selector: "file://example.com/demo.tgz",
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected manifest to parse");
    }

    const plan = buildClawPlan({ manifest: parsed.manifest });

    expect(plan.summary).toMatchObject({ unsupportedRequiredEntries: 7 });
    expect(plan.entries.map((entry) => entry.artifact?.supported)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("blocks unsupported package selectors in the read-only plan", () => {
    const parsed = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "plugin",
          id: "bad-plugin",
          selector: "registry.example.com/plugin.tgz",
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected manifest to parse");
    }

    const plan = buildClawPlan({ manifest: parsed.manifest });

    expect(plan.summary).toMatchObject({
      unsupportedRequiredEntries: 1,
      unsupportedOptionalEntries: 0,
    });
    expect(plan.entries[0]).toMatchObject({
      decision: "blockedUnsupported",
      artifact: { source: "unknown", supported: false },
    });
  });

  it("marks workspace and automation entries as future consent points", () => {
    const parsed = parseClawManifest({
      ...baseManifest,
      entries: [
        ...baseManifest.entries,
        {
          kind: "schedule",
          id: "morning-brief",
          source: "automations/morning-brief.json",
          enableDefault: false,
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected manifest to parse");
    }

    const plan = buildClawPlan({ manifest: parsed.manifest, sourcePath: "/tmp/claw.json" });

    expect(plan.readOnly).toBe(true);
    expect(plan.summary).toMatchObject({
      totalEntries: 3,
      requiredEntries: 3,
      requiresConsent: 2,
    });
    expect(plan.entries.map((entry) => entry.decision)).toEqual([
      "inspectOnly",
      "requiresConsent",
      "requiresConsent",
    ]);
  });
});

describe("buildClawApplyPlan", () => {
  it("builds a dry-run lifecycle plan with provenance and rollback actions", () => {
    const parsed = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "plugin",
          id: "terminal-plugin",
          selector: "npm:@openclaw/plugin-terminal@2.0.0",
        },
        {
          kind: "workspaceFile",
          id: "soul",
          path: "SOUL.md",
          source: "files/SOUL.md",
        },
        {
          kind: "schedule",
          id: "morning-brief",
          source: "automations/morning-brief.json",
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected manifest to parse");
    }

    const applyPlan = buildClawApplyPlan(buildClawPlan({ manifest: parsed.manifest }));

    expect(applyPlan).toMatchObject({
      schemaVersion: "openclaw.clawApplyPlan.v1",
      dryRun: true,
      mutationAllowed: false,
      summary: {
        totalEntries: 3,
        installActions: 3,
        consentRequired: 2,
        blockedEntries: 0,
        provenanceRecords: 3,
        rollbackActions: 3,
      },
    });
    expect(applyPlan.entries).toEqual([
      expect.objectContaining({
        id: "terminal-plugin",
        phase: "artifact",
        action: "installArtifact",
        consentRequired: false,
        provenanceRecord: "plugin.installRecord",
        rollback: { action: "uninstallArtifact", target: "npm:@openclaw/plugin-terminal@2.0.0" },
      }),
      expect.objectContaining({
        id: "soul",
        phase: "workspace",
        action: "writeWorkspaceFile",
        consentRequired: true,
        provenanceRecord: "workspaceFile.installRecord",
        rollback: { action: "removeWorkspaceFile", target: "SOUL.md" },
      }),
      expect.objectContaining({
        id: "morning-brief",
        phase: "automation",
        action: "registerAutomation",
        consentRequired: true,
        provenanceRecord: "automation.installRecord",
        rollback: { action: "disableAutomation", target: "morning-brief" },
      }),
    ]);
  });

  it("skips optional unsupported entries without blocking apply", () => {
    const parsed = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "plugin",
          id: "bad-optional-plugin",
          selector: "registry.example.com/plugin.tgz",
          required: false,
        },
        {
          kind: "futureThing",
          id: "future-optional",
          required: false,
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected manifest to parse");
    }

    const applyPlan = buildClawApplyPlan(buildClawPlan({ manifest: parsed.manifest }));

    expect(applyPlan.summary).toMatchObject({
      installActions: 0,
      blockedEntries: 0,
      rollbackActions: 0,
    });
    expect(applyPlan.entries).toEqual([
      expect.objectContaining({
        id: "bad-optional-plugin",
        action: "skipUnsupported",
        blocked: false,
      }),
      expect.objectContaining({
        id: "future-optional",
        action: "skipUnsupported",
        blocked: false,
      }),
    ]);
  });

  it("carries unsupported required artifacts into blocked apply actions", () => {
    const parsed = parseClawManifest({
      ...baseManifest,
      entries: [
        {
          kind: "plugin",
          id: "bad-plugin",
          selector: "registry.example.com/plugin.tgz",
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected manifest to parse");
    }

    const applyPlan = buildClawApplyPlan(buildClawPlan({ manifest: parsed.manifest }));

    expect(applyPlan.summary).toMatchObject({
      installActions: 0,
      blockedEntries: 1,
      rollbackActions: 0,
    });
    expect(applyPlan.entries[0]).toMatchObject({
      id: "bad-plugin",
      phase: "unsupported",
      action: "skipUnsupported",
      blocked: true,
      rollback: { action: "none" },
    });
  });
});
