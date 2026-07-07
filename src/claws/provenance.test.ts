// Tests root Claw install ownership and the narrow agent/workspace mutation slice.
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan, ClawAddMutationError } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { persistClawInstallRecord, readClawInstallRecord } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function makePlan(manifestValue: unknown = { schemaVersion: 1, agent: { id: "worker" } }) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-claw-add-"));
  const parsed = parseClawManifest(manifestValue);
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrity: "sha256:manifest",
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(root, "workspace-worker") },
  });
  return { root, plan };
}

function stateEnv(root: string) {
  return { OPENCLAW_STATE_DIR: join(root, "state") };
}

describe("Claw root install provenance", () => {
  it("persists package identity, agent ownership, workspace, and config digest", async () => {
    const { root, plan } = await makePlan();

    const record = persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 42 });

    expect(record).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v1",
      claw: { name: "@acme/worker", version: "1.0.0", integrity: "sha256:manifest" },
      agentId: "worker",
      workspace: plan.agent.workspace,
      status: "complete",
      addedAtMs: 42,
    });
    expect(record.agentConfigDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(readClawInstallRecord("worker", { env: stateEnv(root) })).toEqual(record);
  });

  it("does not overwrite an existing install record for the same agent", async () => {
    const { root, plan } = await makePlan();
    persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 1 });

    expect(() => persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 2 })).toThrow();
    expect(readClawInstallRecord("worker", { env: stateEnv(root) })?.addedAtMs).toBe(1);
  });
});

describe("applyClawAddPlan", () => {
  it("appends one agent, preserves defaults and existing agents, and creates a new workspace", async () => {
    const { root, plan } = await makePlan({
      schemaVersion: 1,
      agent: {
        id: "worker",
        name: "Worker",
        identity: { name: "Work" },
        tools: { deny: ["exec"] },
      },
    });
    let config: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/operator/default" },
        list: [{ id: "main", default: true }],
      },
    };

    const result = await applyClawAddPlan(plan, {
      env: stateEnv(root),
      nowMs: 10,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(result).toMatchObject({
      schemaVersion: "openclaw.clawAddResult.v1",
      stability: "experimental",
      status: "complete",
      workspaceCreated: true,
      configCommitted: true,
      installRecord: { agentId: "worker" },
    });
    expect(config.agents?.defaults).toEqual({ workspace: "/operator/default" });
    expect(config.agents?.list).toEqual([
      { id: "main", default: true },
      {
        id: "worker",
        name: "Worker",
        identity: { name: "Work" },
        tools: { deny: ["exec"] },
        workspace: plan.agent.workspace,
      },
    ]);
    await expect(access(plan.agent.workspace)).resolves.toBeUndefined();
  });

  it("rechecks agent collisions during the config commit and cleans the reserved workspace", async () => {
    const { plan } = await makePlan();

    await expect(
      applyClawAddPlan(plan, {
        commitConfig: async (transform) => {
          transform({ agents: { list: [{ id: "worker" }] } });
        },
      }),
    ).rejects.toMatchObject({ code: "agent_id_collision" });
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("blocks declared components that this lifecycle slice cannot yet create", async () => {
    const { plan } = await makePlan({
      schemaVersion: 1,
      agent: { id: "worker" },
      packages: [{ kind: "skill", source: "clawhub", ref: "demo", version: "1.0.0" }],
    });

    await expect(applyClawAddPlan(plan)).rejects.toEqual(
      expect.objectContaining<Partial<ClawAddMutationError>>({ code: "unsupported_components" }),
    );
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("reports a partial add when provenance persistence fails after config commit", async () => {
    const { plan } = await makePlan();
    let config: OpenClawConfig = {};

    const result = await applyClawAddPlan(plan, {
      commitConfig: async (transform) => {
        config = transform(config);
      },
      persistRecord: () => {
        throw new Error("database unavailable");
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: true,
      configCommitted: true,
      error: { code: "provenance_failed", message: "database unavailable" },
    });
    expect(config.agents?.list?.[0]?.id).toBe("worker");
  });
});
