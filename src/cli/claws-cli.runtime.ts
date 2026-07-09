// Runtime handlers for local Claws CLI commands.
import { resolve } from "node:path";
import {
  applyClawArtifactInstallers,
  ClawArtifactApplyError,
} from "../claws/artifact-installers.js";
import { exportClawManifest } from "../claws/export.js";
import { readClawFeedFile, readClawManifestFromFeed } from "../claws/feed.js";
import { readClawStatus, removeClawState } from "../claws/lifecycle-state.js";
import { buildClawApplyPlan } from "../claws/lifecycle.js";
import { buildClawPlan } from "../claws/plan.js";
import { persistClawArtifactApplyProvenance } from "../claws/provenance.js";
import { readClawManifestFile } from "../claws/reader.js";
import type { ClawApplyPlan, PersistedClawWorkspaceFileRef } from "../claws/types.js";
import { applyClawWorkspaceFiles, ClawWorkspaceApplyError } from "../claws/workspace.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type {
  ClawsApplyOptions,
  ClawsExportOptions,
  ClawsFeedApplyOptions,
  ClawsFeedInspectOptions,
  ClawsInspectOptions,
  ClawsRemoveOptions,
  ClawsStatusOptions,
} from "./claws-cli.js";

type DiagnosticLike = { level: string; code: string; path: string; message: string };

function formatDiagnostics(diagnostics: DiagnosticLike[]): string {
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.level.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
    )
    .join("\n");
}

function logClawApplyPlanSummary(plan: ClawApplyPlan, runtime: RuntimeEnv): void {
  runtime.log("Dry-run: true");
  runtime.log("Mutation allowed: false");
  runtime.log(`Entries: ${plan.summary.totalEntries}`);
  runtime.log(`Install actions: ${plan.summary.installActions}`);
  runtime.log(`Consent required: ${plan.summary.consentRequired}`);
  runtime.log(`Provenance records: ${plan.summary.provenanceRecords}`);
  runtime.log(`Rollback actions: ${plan.summary.rollbackActions}`);
  if (plan.summary.blockedEntries > 0) {
    runtime.log(`Blocked entries: ${plan.summary.blockedEntries}`);
  }
}

function failUnsafeApply(
  opts: { dryRun?: boolean; json?: boolean; yes?: boolean },
  runtime: RuntimeEnv,
): boolean {
  if (opts.dryRun || opts.yes) {
    return false;
  }
  const message =
    "Claw apply mutates workspace files and package-like artifact provenance in this OpenClaw build; pass --dry-run to preview or --yes to apply supported Claw mutations.";
  if (opts.json) {
    writeRuntimeJson(runtime, { ok: false, error: { code: "confirmation_required", message } });
  } else {
    runtime.error(message);
  }
  runtime.exit(1);
  return true;
}

function failBlockedApply(
  plan: ClawApplyPlan,
  opts: { json?: boolean },
  runtime: RuntimeEnv,
): boolean {
  if (plan.summary.blockedEntries === 0) {
    return false;
  }
  const message =
    "Claw apply is blocked by required unsupported entries; run with --dry-run --json to inspect blockers.";
  if (opts.json) {
    writeRuntimeJson(runtime, { ok: false, error: { code: "apply_blocked", message }, plan });
  } else {
    runtime.error(message);
  }
  runtime.exit(1);
  return true;
}

function logClawStatusResult(status: ReturnType<typeof readClawStatus>, runtime: RuntimeEnv): void {
  runtime.log(`Claws: ${status.summary.claws}`);
  runtime.log(`Artifact refs: ${status.summary.artifactRefs}`);
  runtime.log(`Workspace file refs: ${status.summary.workspaceFileRefs}`);
  for (const record of status.records) {
    const version = record.clawVersion ? `@${record.clawVersion}` : "";
    runtime.log(`Claw: ${record.clawId}${version}`);
    runtime.log(`  Artifacts: ${record.artifacts.length}`);
    runtime.log(`  Workspace files: ${record.workspaceFiles.length}`);
  }
}

function failUnsafeRemove(
  opts: { dryRun?: boolean; json?: boolean; yes?: boolean },
  runtime: RuntimeEnv,
): boolean {
  if (opts.dryRun || opts.yes) {
    return false;
  }
  const message =
    "Claw remove deletes Claw-managed workspace files and persisted Claw refs; pass --dry-run to preview or --yes to remove.";
  if (opts.json) {
    writeRuntimeJson(runtime, { ok: false, error: { code: "confirmation_required", message } });
  } else {
    runtime.error(message);
  }
  runtime.exit(1);
  return true;
}

function logClawRemoveResult(
  result: Awaited<ReturnType<typeof removeClawState>>,
  runtime: RuntimeEnv,
): void {
  runtime.log(`Dry-run: ${result.dryRun ? "true" : "false"}`);
  runtime.log(`Claw: ${result.clawId}`);
  runtime.log(`Found: ${result.found ? "true" : "false"}`);
  runtime.log(`Artifact refs removed: ${result.summary.artifactRefsRemoved}`);
  runtime.log(`Workspace file refs removed: ${result.summary.workspaceFileRefsRemoved}`);
  runtime.log(`Workspace files deleted: ${result.summary.workspaceFilesDeleted}`);
  runtime.log(`Workspace files retained: ${result.summary.workspaceFilesRetained}`);
  if (result.summary.errors > 0) {
    runtime.log(`Errors: ${result.summary.errors}`);
  }
}

function logClawExportSummary(
  result: Awaited<ReturnType<typeof exportClawManifest>>,
  runtime: RuntimeEnv,
): void {
  runtime.log(`Claw manifest written: ${result.outputPath}`);
  runtime.log(`Plugins: ${result.summary.plugins}`);
  runtime.log(`Workspace files: ${result.summary.workspaceFiles}`);
  runtime.log(`Personas: ${result.summary.personas}`);
  runtime.log(`Excluded: ${result.summary.excluded}`);
  if (result.warnings.length > 0) {
    runtime.log(`Warnings: ${result.warnings.length}`);
    for (const warning of result.warnings) {
      runtime.log(`  ${warning}`);
    }
  }
}

function logClawApplyResultSummary(
  result: ReturnType<typeof persistClawArtifactApplyProvenance>,
  runtime: RuntimeEnv,
): void {
  runtime.log("Dry-run: false");
  runtime.log("Mutation allowed: true");
  runtime.log(`Entries: ${result.summary.totalEntries}`);
  runtime.log(`Recorded artifact refs: ${result.summary.recordedArtifactRefs}`);
  runtime.log(`Applied workspace files: ${result.summary.appliedWorkspaceFiles}`);
  runtime.log(`Preview-only entries: ${result.summary.previewOnlyEntries}`);
  runtime.log(`Provenance records: ${result.summary.provenanceRecords}`);
  if (result.summary.skippedUnsupported > 0) {
    runtime.log(`Skipped unsupported entries: ${result.summary.skippedUnsupported}`);
  }
}

function combineApplyResult(
  result: ReturnType<typeof persistClawArtifactApplyProvenance>,
  workspaceFiles: PersistedClawWorkspaceFileRef[],
): ReturnType<typeof persistClawArtifactApplyProvenance> {
  const previewOnlyEntries = result.previewOnlyEntries.filter(
    (entry) => entry.phase !== "workspace",
  );
  return {
    ...result,
    summary: {
      ...result.summary,
      appliedWorkspaceFiles: workspaceFiles.filter((file) => file.operation !== "unchanged").length,
      previewOnlyEntries: previewOnlyEntries.length,
      provenanceRecords: result.artifacts.length + workspaceFiles.length,
    },
    workspaceFiles,
    previewOnlyEntries,
  };
}

async function applyArtifacts(
  plan: ClawApplyPlan,
  sourcePath: string,
  opts: { json?: boolean },
  runtime: RuntimeEnv,
): Promise<Awaited<ReturnType<typeof applyClawArtifactInstallers>> | null> {
  try {
    return await applyClawArtifactInstallers(plan, { sourcePath, runtime, quiet: opts.json });
  } catch (error) {
    if (!(error instanceof ClawArtifactApplyError)) {
      throw error;
    }
    if (error.partialResult && error.partialResult.createdArtifactKeys.size > 0) {
      persistClawArtifactApplyProvenance(plan, {
        sourcePath,
        createdArtifactKeys: error.partialResult.createdArtifactKeys,
        artifactKeys: error.partialResult.createdArtifactKeys,
      });
    }
    const message = "Claw apply could not safely install package-like artifacts.";
    if (opts.json) {
      writeRuntimeJson(runtime, {
        ok: false,
        error: { code: "artifact_apply_failed", message },
        diagnostics: error.diagnostics,
      });
    } else {
      runtime.error(`${message}\n${formatDiagnostics(error.diagnostics)}`);
    }
    runtime.exit(1);
    return null;
  }
}

function failWorkspaceApply(
  error: unknown,
  opts: { json?: boolean },
  runtime: RuntimeEnv,
): boolean {
  if (!(error instanceof ClawWorkspaceApplyError)) {
    throw error;
  }
  const message = "Claw apply could not safely write workspace files.";
  if (opts.json) {
    writeRuntimeJson(runtime, {
      ok: false,
      error: { code: "workspace_apply_failed", message },
      diagnostics: error.diagnostics,
    });
  } else {
    runtime.error(`${message}\n${formatDiagnostics(error.diagnostics)}`);
  }
  runtime.exit(1);
  return true;
}

export async function runClawsInspectCommand(
  manifestPath: string,
  opts: ClawsInspectOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const result = await readClawManifestFile(manifestPath);
  if (!result.ok) {
    if (opts.json) {
      writeRuntimeJson(runtime, { valid: false, diagnostics: result.diagnostics });
    } else {
      runtime.error(formatDiagnostics(result.diagnostics));
    }
    runtime.exit(1);
    return;
  }

  const payload = {
    valid: true,
    sourcePath: resolve(manifestPath),
    manifest: result.manifest,
    diagnostics: result.diagnostics,
  };

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  runtime.log(`Claw: ${result.manifest.name} (${result.manifest.id}@${result.manifest.version})`);
  runtime.log(`Entries: ${result.manifest.entries.length}`);
  if (result.manifest.optionalUnknownEntries.length > 0) {
    runtime.log(`Optional unsupported entries: ${result.manifest.optionalUnknownEntries.length}`);
  }
  if (result.diagnostics.length > 0) {
    runtime.log(formatDiagnostics(result.diagnostics));
  }
}

export async function runClawsApplyCommand(
  manifestPath: string,
  opts: ClawsApplyOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  if (failUnsafeApply(opts, runtime)) {
    return;
  }

  const result = await readClawManifestFile(manifestPath);
  if (!result.ok) {
    if (opts.json) {
      writeRuntimeJson(runtime, { valid: false, diagnostics: result.diagnostics });
    } else {
      runtime.error(formatDiagnostics(result.diagnostics));
    }
    runtime.exit(1);
    return;
  }

  const plan = buildClawApplyPlan(
    buildClawPlan({
      manifest: result.manifest,
      diagnostics: result.diagnostics,
      sourcePath: resolve(manifestPath),
    }),
  );

  if (opts.dryRun) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
      return;
    }

    runtime.log(`Claw apply plan: ${plan.claw.name} (${plan.claw.id}@${plan.claw.version})`);
    logClawApplyPlanSummary(plan, runtime);
    return;
  }

  if (failBlockedApply(plan, opts, runtime)) {
    return;
  }
  const sourcePath = resolve(manifestPath);
  try {
    await applyClawWorkspaceFiles(plan, {
      sourcePath,
      workspaceRoot: opts.workspace,
      validateOnly: true,
    });
  } catch (error) {
    if (failWorkspaceApply(error, opts, runtime)) {
      return;
    }
    throw error;
  }
  const artifactInstall = await applyArtifacts(plan, sourcePath, opts, runtime);
  if (!artifactInstall) {
    return;
  }
  persistClawArtifactApplyProvenance(plan, {
    sourcePath,
    createdArtifactKeys: artifactInstall.createdArtifactKeys,
    artifactKeys: artifactInstall.installedArtifactKeys,
  });
  let workspaceFiles: PersistedClawWorkspaceFileRef[];
  try {
    workspaceFiles = await applyClawWorkspaceFiles(plan, {
      sourcePath,
      workspaceRoot: opts.workspace,
    });
  } catch (error) {
    if (failWorkspaceApply(error, opts, runtime)) {
      return;
    }
    throw error;
  }
  const applied = combineApplyResult(
    persistClawArtifactApplyProvenance(plan, {
      sourcePath,
      createdArtifactKeys: artifactInstall.createdArtifactKeys,
      artifactKeys: artifactInstall.installedArtifactKeys,
    }),
    workspaceFiles,
  );
  if (opts.json) {
    writeRuntimeJson(runtime, applied);
    return;
  }
  runtime.log(`Claw applied: ${applied.claw.name} (${applied.claw.id}@${applied.claw.version})`);
  logClawApplyResultSummary(applied, runtime);
}

export async function runClawsFeedInspectCommand(
  feedPath: string,
  opts: ClawsFeedInspectOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const result = await readClawFeedFile(feedPath);
  if (!result.ok) {
    if (opts.json) {
      writeRuntimeJson(runtime, { valid: false, diagnostics: result.diagnostics });
    } else {
      runtime.error(formatDiagnostics(result.diagnostics));
    }
    runtime.exit(1);
    return;
  }

  const payload = {
    valid: true,
    sourcePath: resolve(feedPath),
    feed: result.feed,
    diagnostics: result.diagnostics,
  };

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  runtime.log(`Claw feed: ${result.feed.name} (${result.feed.id})`);
  runtime.log(`Entries: ${result.feed.entries.length}`);
  if (result.diagnostics.length > 0) {
    runtime.log(formatDiagnostics(result.diagnostics));
  }
}

export async function runClawsFeedApplyCommand(
  feedPath: string,
  clawId: string,
  opts: ClawsFeedApplyOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  if (failUnsafeApply(opts, runtime)) {
    return;
  }

  const result = await readClawManifestFromFeed({ feedPath, entryId: clawId });
  if (!result.ok) {
    if (opts.json) {
      writeRuntimeJson(runtime, { valid: false, diagnostics: result.diagnostics });
    } else {
      runtime.error(formatDiagnostics(result.diagnostics));
    }
    runtime.exit(1);
    return;
  }

  const plan = buildClawApplyPlan(
    buildClawPlan({
      manifest: result.manifest,
      diagnostics: result.diagnostics,
      sourcePath: result.manifestPath,
    }),
  );
  const payload = {
    ...plan,
    feed: {
      id: result.feed.id,
      name: result.feed.name,
      sourcePath: resolve(feedPath),
      entry: result.entry,
    },
  };

  if (opts.dryRun) {
    if (opts.json) {
      writeRuntimeJson(runtime, payload);
      return;
    }

    runtime.log(`Claw apply plan: ${plan.claw.name} (${plan.claw.id}@${plan.claw.version})`);
    runtime.log(`Feed: ${result.feed.name} (${result.feed.id})`);
    logClawApplyPlanSummary(plan, runtime);
    if (result.diagnostics.length > 0) {
      runtime.log(formatDiagnostics(result.diagnostics));
    }
    return;
  }

  if (failBlockedApply(plan, opts, runtime)) {
    return;
  }
  try {
    await applyClawWorkspaceFiles(plan, {
      sourcePath: result.manifestPath,
      workspaceRoot: opts.workspace,
      validateOnly: true,
    });
  } catch (error) {
    if (failWorkspaceApply(error, opts, runtime)) {
      return;
    }
    throw error;
  }
  const artifactInstall = await applyArtifacts(plan, result.manifestPath, opts, runtime);
  if (!artifactInstall) {
    return;
  }
  persistClawArtifactApplyProvenance(plan, {
    sourcePath: result.manifestPath,
    feed: {
      id: result.feed.id,
      name: result.feed.name,
      sourcePath: resolve(feedPath),
      entry: result.entry,
    },
    createdArtifactKeys: artifactInstall.createdArtifactKeys,
    artifactKeys: artifactInstall.installedArtifactKeys,
  });
  let workspaceFiles: PersistedClawWorkspaceFileRef[];
  try {
    workspaceFiles = await applyClawWorkspaceFiles(plan, {
      sourcePath: result.manifestPath,
      workspaceRoot: opts.workspace,
    });
  } catch (error) {
    if (failWorkspaceApply(error, opts, runtime)) {
      return;
    }
    throw error;
  }
  const applied = combineApplyResult(
    persistClawArtifactApplyProvenance(plan, {
      sourcePath: result.manifestPath,
      feed: {
        id: result.feed.id,
        name: result.feed.name,
        sourcePath: resolve(feedPath),
        entry: result.entry,
      },
      createdArtifactKeys: artifactInstall.createdArtifactKeys,
      artifactKeys: artifactInstall.installedArtifactKeys,
    }),
    workspaceFiles,
  );
  const appliedPayload = { ...applied, feed: payload.feed };
  if (opts.json) {
    writeRuntimeJson(runtime, appliedPayload);
    return;
  }
  runtime.log(`Claw applied: ${applied.claw.name} (${applied.claw.id}@${applied.claw.version})`);
  runtime.log(`Feed: ${result.feed.name} (${result.feed.id})`);
  logClawApplyResultSummary(applied, runtime);
  if (result.diagnostics.length > 0) {
    runtime.log(formatDiagnostics(result.diagnostics));
  }
}

export async function runClawsStatusCommand(
  clawId: string | undefined,
  opts: ClawsStatusOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const status = readClawStatus(clawId);
  if (opts.json) {
    writeRuntimeJson(runtime, status);
    return;
  }
  logClawStatusResult(status, runtime);
}

export async function runClawsRemoveCommand(
  clawId: string,
  opts: ClawsRemoveOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  if (failUnsafeRemove(opts, runtime)) {
    return;
  }
  const result = await removeClawState(clawId, { dryRun: opts.dryRun });
  if (!result.found) {
    const message = `No persisted Claw state found for ${JSON.stringify(clawId)}.`;
    if (opts.json) {
      writeRuntimeJson(runtime, { ...result, error: { code: "claw_not_found", message } });
    } else {
      runtime.error(message);
    }
    runtime.exit(1);
    return;
  }
  if (result.summary.errors > 0) {
    const message = "Claw remove could not safely remove all managed workspace files.";
    if (opts.json) {
      writeRuntimeJson(runtime, { ...result, error: { code: "claw_remove_failed", message } });
    } else {
      runtime.error(message);
      logClawRemoveResult(result, runtime);
    }
    runtime.exit(1);
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  logClawRemoveResult(result, runtime);
}

export async function runClawsExportCommand(
  opts: ClawsExportOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const result = await exportClawManifest({
    id: opts.id,
    name: opts.name,
    version: opts.version,
    publisher: opts.publisher,
    description: opts.description,
    workspaceRoot: opts.workspace,
    outPath: opts.out,
    include: opts.include,
    exclude: opts.exclude,
    plugins: opts.plugin,
    workspaceFiles: opts.workspaceFile,
    personas: opts.persona,
  });
  if (result.manifest.entries.length === 0) {
    const message = "Claw export did not select any entries.";
    if (opts.json) {
      writeRuntimeJson(runtime, { ...result, error: { code: "claw_export_empty", message } });
    } else {
      runtime.error(message);
    }
    runtime.exit(1);
    return;
  }
  if (!result.outputPath && (result.summary.workspaceFiles > 0 || result.summary.personas > 0)) {
    const message = "Claw export requires --out when exporting workspace or persona files.";
    if (opts.json) {
      writeRuntimeJson(runtime, { ...result, error: { code: "claw_export_out_required", message } });
    } else {
      runtime.error(message);
    }
    runtime.exit(1);
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  if (result.outputPath) {
    logClawExportSummary(result, runtime);
    return;
  }
  runtime.log(JSON.stringify(result.manifest, null, 2));
}
