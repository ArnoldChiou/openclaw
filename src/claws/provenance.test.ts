// Tests for Claw-owned SQLite provenance and artifact reference accounting.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { buildClawApplyPlan } from "./lifecycle.js";
import { buildClawPlan } from "./plan.js";
import {
  persistClawArtifactApplyProvenance,
  readClawArtifactRefsForPluginInstallRecord,
} from "./provenance.js";
import { parseClawManifest } from "./schema.js";

function stateEnv() {
  return { OPENCLAW_STATE_DIR: mkdtempSync(join(tmpdir(), "openclaw-claw-provenance-")) };
}

function applyPlan(params?: {
  clawId?: string;
  selector?: string;
  entries?: unknown[];
  sourcePath?: string;
}) {
  const parsed = parseClawManifest({
    schemaVersion: "openclaw.claw.v1",
    id: params?.clawId ?? "starter",
    name: "Starter",
    version: "1.0.0",
    entries: params?.entries ?? [
      {
        kind: "plugin",
        id: "terminal-plugin",
        selector: params?.selector ?? "npm:@openclaw/plugin-terminal@2.0.0",
      },
      {
        kind: "workspaceFile",
        id: "soul",
        path: "SOUL.md",
        source: "files/SOUL.md",
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
      sourcePath: params?.sourcePath ?? "/tmp/claw.json",
    }),
  );
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("persistClawArtifactApplyProvenance", () => {
  it("persists skill artifact refs", () => {
    const result = persistClawArtifactApplyProvenance(
      applyPlan({
        entries: [{ kind: "skill", id: "sec-filings", selector: "clawhub:sec-filings@1.0.0" }],
      }),
      { env: stateEnv(), nowMs: 1 },
    );

    expect(result.summary).toMatchObject({
      recordedArtifactRefs: 1,
      provenanceRecords: 1,
    });
    expect(result.artifacts[0]).toMatchObject({
      clawId: "starter",
      entryId: "sec-filings",
      artifactKey: "skills:clawhub:sec-filings@1.0.0",
      installSurface: "skills",
      provenanceRecord: "skill.clawhubOrigin",
    });
  });

  it("persists MCP server artifact refs", () => {
    const result = persistClawArtifactApplyProvenance(
      applyPlan({
        entries: [
          {
            kind: "mcpServer",
            id: "docs",
            selector: JSON.stringify({ command: "uvx", args: ["docs-mcp"] }),
          },
        ],
      }),
      { env: stateEnv(), nowMs: 1 },
    );

    expect(result.summary).toMatchObject({
      recordedArtifactRefs: 1,
      provenanceRecords: 1,
    });
    expect(result.artifacts[0]).toMatchObject({
      clawId: "starter",
      entryId: "docs",
      artifactKey:
        "mcpServers:inline:docs:inline:sha256:e66355547d6263e05f38367f38b1c2a0f98d20ea19fac5d08b101923f5fd91a6",
      installSurface: "mcpServers",
      source: "inline",
      packageName: "docs",
      provenanceRecord: "mcpServer.installRecord",
    });
  });

  it("does not persist inline MCP secret material in artifact identity fields", () => {
    const result = persistClawArtifactApplyProvenance(
      applyPlan({
        entries: [
          {
            kind: "mcpServer",
            id: "docs",
            selector: JSON.stringify({
              url: "https://mcp.example.com/mcp",
              transport: "streamable-http",
              headers: { Authorization: "Bearer secret-token" },
            }),
          },
        ],
      }),
      { env: stateEnv(), nowMs: 1 },
    );

    expect(result.artifacts[0].artifactKey).toMatch(/^mcpServers:inline:docs:inline:sha256:/);
    expect(result.artifacts[0].selector).toMatch(/^inline:sha256:/);
    expect(JSON.stringify(result.artifacts[0])).not.toContain("secret-token");
    expect(JSON.stringify(result.artifacts[0])).not.toContain("Authorization");
  });

  it("persists only package-like artifact refs and leaves workspace entries preview-only", () => {
    const result = persistClawArtifactApplyProvenance(applyPlan(), {
      env: stateEnv(),
      nowMs: 1,
    });

    expect(result).toMatchObject({
      schemaVersion: "openclaw.clawApplyResult.v1",
      dryRun: false,
      mutationAllowed: true,
      summary: {
        totalEntries: 2,
        recordedArtifactRefs: 1,
        previewOnlyEntries: 1,
        blockedEntries: 0,
        provenanceRecords: 1,
      },
      artifacts: [
        {
          clawId: "starter",
          entryId: "terminal-plugin",
          artifactKey: "plugins:npm:@openclaw/plugin-terminal@2.0.0",
          selector: "npm:@openclaw/plugin-terminal@2.0.0",
          installSurface: "plugins",
          source: "npm",
          packageName: "@openclaw/plugin-terminal",
          version: "2.0.0",
          provenanceRecord: "plugin.installRecord",
          ownership: {
            state: "referenced",
            createdByThisApply: false,
            preexistingDirectInstall: false,
            clawRefs: ["starter"],
            refCount: 1,
          },
        },
      ],
      previewOnlyEntries: [{ id: "soul", phase: "workspace" }],
    });
  });

  it("preserves Claw-created ownership across idempotent reapply", () => {
    const env = stateEnv();
    const artifactKey = "plugins:npm:@openclaw/plugin-terminal@2.0.0";
    persistClawArtifactApplyProvenance(applyPlan(), {
      env,
      nowMs: 1,
      createdArtifactKeys: new Set([artifactKey]),
    });

    const reapplied = persistClawArtifactApplyProvenance(applyPlan(), { env, nowMs: 2 });

    expect(reapplied.artifacts[0]).toMatchObject({
      artifactKey,
      ownership: {
        state: "newly-created",
        createdByThisApply: true,
        preexistingDirectInstall: false,
        refCount: 1,
      },
    });
  });

  it("does not carry created ownership across changed artifact selectors", () => {
    const env = stateEnv();
    persistClawArtifactApplyProvenance(applyPlan(), {
      env,
      nowMs: 1,
      createdArtifactKeys: new Set(["plugins:npm:@openclaw/plugin-terminal@2.0.0"]),
    });

    const changed = persistClawArtifactApplyProvenance(
      applyPlan({ selector: "npm:@openclaw/plugin-terminal@3.0.0" }),
      { env, nowMs: 2 },
    );

    expect(changed.artifacts[0]).toMatchObject({
      artifactKey: "plugins:npm:@openclaw/plugin-terminal@3.0.0",
      ownership: {
        state: "referenced",
        createdByThisApply: false,
        refCount: 1,
      },
    });
  });

  it("does not match exact persisted npm refs to a different installed version", () => {
    const env = stateEnv();
    persistClawArtifactApplyProvenance(
      applyPlan({ selector: "npm:@openclaw/plugin-terminal@1.0.0" }),
      {
        env,
        nowMs: 1,
      },
    );

    const refs = readClawArtifactRefsForPluginInstallRecord(
      "terminal",
      {
        source: "npm",
        spec: "@openclaw/plugin-terminal@2.0.0",
        resolvedName: "@openclaw/plugin-terminal",
        resolvedVersion: "2.0.0",
        installPath: "/tmp/plugin-terminal",
      } satisfies PluginInstallRecord,
      { env },
    );

    expect(refs).toEqual([]);
  });

  it("records shared artifact refs when another Claw already references the same artifact", () => {
    const env = stateEnv();
    persistClawArtifactApplyProvenance(applyPlan({ clawId: "first" }), { env, nowMs: 1 });

    const second = persistClawArtifactApplyProvenance(applyPlan({ clawId: "second" }), {
      env,
      nowMs: 2,
    });

    expect(second.artifacts[0]).toMatchObject({
      clawId: "second",
      artifactKey: "plugins:npm:@openclaw/plugin-terminal@2.0.0",
      ownership: {
        state: "shared",
        createdByThisApply: false,
        preexistingDirectInstall: false,
        clawRefs: ["first", "second"],
        refCount: 2,
      },
    });

    const first = persistClawArtifactApplyProvenance(applyPlan({ clawId: "first" }), {
      env,
      nowMs: 3,
    });
    expect(first.artifacts[0]).toMatchObject({
      clawId: "first",
      ownership: { state: "shared", clawRefs: ["first", "second"], refCount: 2 },
    });
  });

  it("canonicalizes equivalent package selectors for ownership refs", () => {
    const env = stateEnv();
    persistClawArtifactApplyProvenance(
      applyPlan({ clawId: "first", selector: "npm:@openclaw/plugin-terminal@2.0.0" }),
      { env, nowMs: 1 },
    );

    const second = persistClawArtifactApplyProvenance(
      applyPlan({ clawId: "second", selector: "npm: @openclaw/plugin-terminal@2.0.0" }),
      { env, nowMs: 2 },
    );

    expect(second.artifacts[0]).toMatchObject({
      artifactKey: "plugins:npm:@openclaw/plugin-terminal@2.0.0",
      ownership: { state: "shared", clawRefs: ["first", "second"], refCount: 2 },
    });
  });

  it("removes stale artifact refs when a Claw is reapplied without artifacts", () => {
    const env = stateEnv();
    persistClawArtifactApplyProvenance(applyPlan({ clawId: "starter" }), { env, nowMs: 1 });

    const result = persistClawArtifactApplyProvenance(
      applyPlan({
        clawId: "starter",
        entries: [
          {
            kind: "workspaceFile",
            id: "soul",
            path: "SOUL.md",
            source: "files/SOUL.md",
          },
        ],
      }),
      { env, nowMs: 2 },
    );

    expect(result.summary).toMatchObject({
      recordedArtifactRefs: 0,
      previewOnlyEntries: 1,
      provenanceRecords: 0,
    });
    expect(result.artifacts).toEqual([]);
  });

  it("refreshes shared ownership when a Claw changes an artifact selector", () => {
    const env = stateEnv();
    persistClawArtifactApplyProvenance(applyPlan({ clawId: "first" }), { env, nowMs: 1 });
    persistClawArtifactApplyProvenance(applyPlan({ clawId: "second" }), { env, nowMs: 2 });

    const changed = persistClawArtifactApplyProvenance(
      applyPlan({ clawId: "first", selector: "npm:@openclaw/plugin-terminal@3.0.0" }),
      { env, nowMs: 3 },
    );
    expect(changed.artifacts[0]).toMatchObject({
      clawId: "first",
      artifactKey: "plugins:npm:@openclaw/plugin-terminal@3.0.0",
      ownership: { state: "referenced", clawRefs: ["first"], refCount: 1 },
    });

    const second = persistClawArtifactApplyProvenance(applyPlan({ clawId: "second" }), {
      env,
      nowMs: 4,
    });
    expect(second.artifacts[0]).toMatchObject({
      clawId: "second",
      artifactKey: "plugins:npm:@openclaw/plugin-terminal@2.0.0",
      ownership: { state: "referenced", clawRefs: ["second"], refCount: 1 },
    });
  });

  it("keys relative path artifacts by their manifest directory", () => {
    const env = stateEnv();

    const first = persistClawArtifactApplyProvenance(
      applyPlan({ clawId: "first", selector: "./plugin", sourcePath: "/tmp/first/claw.json" }),
      { env, nowMs: 1 },
    );
    const second = persistClawArtifactApplyProvenance(
      applyPlan({ clawId: "second", selector: "./plugin", sourcePath: "/tmp/second/claw.json" }),
      { env, nowMs: 2 },
    );

    expect(first.artifacts[0]).toMatchObject({
      artifactKey: "plugins:path:/tmp/first/plugin",
      ownership: { state: "referenced", clawRefs: ["first"], refCount: 1 },
    });
    expect(second.artifacts[0]).toMatchObject({
      artifactKey: "plugins:path:/tmp/second/plugin",
      ownership: { state: "referenced", clawRefs: ["second"], refCount: 1 },
    });
  });

  it("shares relative path artifact refs from the same manifest directory", () => {
    const env = stateEnv();
    persistClawArtifactApplyProvenance(
      applyPlan({ clawId: "first", selector: "./plugin", sourcePath: "/tmp/shared/claw-a.json" }),
      { env, nowMs: 1 },
    );

    const second = persistClawArtifactApplyProvenance(
      applyPlan({ clawId: "second", selector: "./plugin", sourcePath: "/tmp/shared/claw-b.json" }),
      { env, nowMs: 2 },
    );

    expect(second.artifacts[0]).toMatchObject({
      artifactKey: "plugins:path:/tmp/shared/plugin",
      ownership: { state: "shared", clawRefs: ["first", "second"], refCount: 2 },
    });
  });

  it("does not persist provenance when required artifacts are blocked", () => {
    const result = persistClawArtifactApplyProvenance(
      applyPlan({
        entries: [
          {
            kind: "plugin",
            id: "bad-plugin",
            selector: "registry.example.com/plugin.tgz",
          },
        ],
      }),
      { env: stateEnv(), nowMs: 1 },
    );

    expect(result.summary).toMatchObject({
      recordedArtifactRefs: 0,
      blockedEntries: 1,
      provenanceRecords: 0,
    });
    expect(result.artifacts).toEqual([]);
  });
});
