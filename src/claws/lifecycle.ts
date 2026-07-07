// Builds dry-run Claw apply plans without mutating user state.
import {
  CLAW_APPLY_PLAN_SCHEMA_VERSION,
  type ClawApplyPlan,
  type ClawApplyPlanEntry,
  type ClawPlan,
  type ClawPlanEntry,
} from "./types.js";

function artifactAction(entry: ClawPlanEntry): ClawApplyPlanEntry {
  const unsupported =
    entry.decision === "blockedUnsupported" || entry.artifact?.supported === false;
  const blocked = unsupported && entry.required;
  return {
    id: entry.id,
    kind: entry.kind,
    required: entry.required,
    phase: unsupported ? "unsupported" : "artifact",
    action: unsupported ? "skipUnsupported" : "installArtifact",
    ...(entry.target ? { target: entry.target } : {}),
    consentRequired: false,
    blocked,
    ...(entry.artifact && !unsupported
      ? { artifact: entry.artifact, provenanceRecord: entry.artifact.provenance.record }
      : {}),
    rollback: unsupported
      ? { action: "none" }
      : { action: "uninstallArtifact", ...(entry.target ? { target: entry.target } : {}) },
    reason: unsupported
      ? entry.required
        ? "This required artifact selector is unsupported and blocks apply until the Claw is rewritten."
        : "This optional artifact selector is unsupported and would be skipped during apply."
      : "Dry-run would install the artifact and record provenance for rollback/update.",
  };
}

function workspaceAction(entry: ClawPlanEntry): ClawApplyPlanEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    required: entry.required,
    phase: "workspace",
    action: entry.kind === "persona" ? "writePersonaFile" : "writeWorkspaceFile",
    ...(entry.target ? { target: entry.target } : {}),
    ...(entry.source ? { source: entry.source } : {}),
    consentRequired: true,
    blocked: false,
    provenanceRecord: "workspaceFile.installRecord",
    rollback: { action: "removeWorkspaceFile", ...(entry.target ? { target: entry.target } : {}) },
    reason: "Dry-run would require explicit consent before writing workspace-owned files.",
  };
}

function automationAction(entry: ClawPlanEntry): ClawApplyPlanEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    required: entry.required,
    phase: "automation",
    action: "registerAutomation",
    ...(entry.target ? { target: entry.target } : {}),
    ...(entry.source ? { source: entry.source } : {}),
    consentRequired: true,
    blocked: false,
    provenanceRecord: "automation.installRecord",
    rollback: { action: "disableAutomation", ...(entry.target ? { target: entry.target } : {}) },
    reason:
      "Dry-run would require explicit consent before registering or enabling automation state.",
  };
}

function applyEntry(entry: ClawPlanEntry): ClawApplyPlanEntry {
  if (entry.artifact) {
    return artifactAction(entry);
  }
  if (entry.kind === "workspaceFile" || entry.kind === "persona") {
    return workspaceAction(entry);
  }
  if (entry.kind === "heartbeat" || entry.kind === "schedule" || entry.kind === "automation") {
    return automationAction(entry);
  }
  return {
    id: entry.id,
    kind: entry.kind,
    required: entry.required,
    phase: "unsupported",
    action: "skipUnsupported",
    consentRequired: false,
    blocked: entry.required,
    rollback: { action: "none" },
    reason: entry.required
      ? "This required entry kind is not supported by the dry-run apply planner."
      : "This optional entry kind is not supported and would be skipped during apply.",
  };
}

export function buildClawApplyPlan(plan: ClawPlan): ClawApplyPlan {
  const entries = plan.entries.map(applyEntry);
  return {
    schemaVersion: CLAW_APPLY_PLAN_SCHEMA_VERSION,
    dryRun: true,
    mutationAllowed: false,
    claw: plan.claw,
    summary: {
      totalEntries: entries.length,
      installActions: entries.filter(
        (entry) => !entry.blocked && entry.action !== "skipUnsupported",
      ).length,
      consentRequired: entries.filter((entry) => entry.consentRequired).length,
      blockedEntries: entries.filter((entry) => entry.blocked).length,
      provenanceRecords: entries.filter((entry) => entry.provenanceRecord).length,
      rollbackActions: entries.filter((entry) => entry.rollback.action !== "none").length,
    },
    entries,
    diagnostics: plan.diagnostics,
  };
}
