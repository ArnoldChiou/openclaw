// Builds Claw manifests from local OpenClaw state and explicit workspace selections.
import { copyFile, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { CLAW_SCHEMA_VERSION, type ClawEntry, type ClawManifest } from "./types.js";
import { MAX_CLAW_WORKSPACE_FILE_BYTES } from "./workspace.js";

type ExportedClawManifest = Omit<ClawManifest, "optionalUnknownEntries">;

export type ClawExportIncludeKind = "plugins" | "workspace" | "persona";

export type ClawExportOptions = {
  id: string;
  name: string;
  version?: string;
  publisher?: string;
  description?: string;
  workspaceRoot?: string;
  outPath?: string;
  include?: string[];
  exclude?: string[];
  plugins?: string[];
  workspaceFiles?: string[];
  personas?: string[];
};

export type ClawExportResult = {
  schemaVersion: "openclaw.clawExport.v1";
  manifest: ExportedClawManifest;
  summary: {
    plugins: number;
    workspaceFiles: number;
    personas: number;
    excluded: number;
    warnings: number;
  };
  outputPath?: string;
  warnings: string[];
};

const DEFAULT_INCLUDE_KINDS = new Set<ClawExportIncludeKind>(["plugins", "workspace", "persona"]);

function splitList(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseIncludeKinds(values: string[] | undefined): Set<ClawExportIncludeKind> {
  const raw = splitList(values);
  if (raw.length === 0) {
    return new Set(DEFAULT_INCLUDE_KINDS);
  }
  const kinds = new Set<ClawExportIncludeKind>();
  for (const value of raw) {
    if (value === "plugin" || value === "plugins") {
      kinds.add("plugins");
    } else if (
      value === "workspace" ||
      value === "workspaceFile" ||
      value === "workspaceFiles"
    ) {
      kinds.add("workspace");
    } else if (value === "persona" || value === "personas") {
      kinds.add("persona");
    }
  }
  return kinds;
}

type Excludes = {
  kinds: Set<ClawExportIncludeKind>;
  plugins: Set<string>;
  workspaceFiles: Set<string>;
  personas: Set<string>;
};

function parseExcludes(values: string[] | undefined): Excludes {
  const excludes: Excludes = {
    kinds: new Set(),
    plugins: new Set(),
    workspaceFiles: new Set(),
    personas: new Set(),
  };
  for (const value of splitList(values)) {
    const separator = value.indexOf(":");
    const rawKind = separator >= 0 ? value.slice(0, separator) : value;
    const rawTarget = separator >= 0 ? value.slice(separator + 1).trim() : "";
    if (rawKind === "plugin" || rawKind === "plugins") {
      if (rawTarget) {
        excludes.plugins.add(rawTarget);
      } else {
        excludes.kinds.add("plugins");
      }
    } else if (
      rawKind === "workspace" ||
      rawKind === "workspaceFile" ||
      rawKind === "workspaceFiles"
    ) {
      if (rawTarget) {
        excludes.workspaceFiles.add(normalizeRelativePath(rawTarget));
      } else {
        excludes.kinds.add("workspace");
      }
    } else if (rawKind === "persona" || rawKind === "personas") {
      if (rawTarget) {
        excludes.personas.add(normalizeRelativePath(rawTarget));
      } else {
        excludes.kinds.add("persona");
      }
    } else {
      excludes.plugins.add(value);
      excludes.workspaceFiles.add(normalizeRelativePath(value));
      excludes.personas.add(normalizeRelativePath(value));
    }
  }
  return excludes;
}

function normalizeIdPart(value: string): string {
  return value
    .trim()
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function nextExportEntryId(prefix: string, value: string, usedIds: Set<string>): string {
  const normalized = normalizeIdPart(value);
  const baseId = prefix + "-" + (normalized || String(usedIds.size + 1));
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = baseId + "-" + String(suffix);
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveWorkspacePath(workspaceRoot: string, pathValue: string): string {
  return isAbsolute(pathValue) ? resolve(pathValue) : resolve(workspaceRoot, pathValue);
}

function workspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  return normalizeRelativePath(relative(workspaceRoot, absolutePath));
}

function sourcePathForManifest(params: { outPath?: string; targetPath: string }): string {
  return params.outPath ? normalizeRelativePath(join("files", params.targetPath)) : params.targetPath;
}

async function copyFileSourceForManifest(params: {
  outPath?: string;
  absolutePath: string;
  targetPath: string;
}): Promise<void> {
  if (!params.outPath) {
    return;
  }
  const destination = resolve(dirname(resolve(params.outPath)), "files", params.targetPath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(params.absolutePath, destination);
}

function pluginSelectorFromRecord(record: PluginInstallRecord): string | undefined {
  if (record.source === "npm") {
    const name = record.resolvedName?.trim();
    const version = record.resolvedVersion?.trim() || record.version?.trim();
    if (name && version) {
      return `npm:${name}@${version}`;
    }
    if (record.resolvedSpec?.trim()) {
      return `npm:${record.resolvedSpec.trim().replace(/^npm:/i, "")}`;
    }
    if (record.spec?.trim()) {
      return `npm:${record.spec.trim().replace(/^npm:/i, "")}`;
    }
  }
  if (record.source === "clawhub") {
    const name = record.clawhubPackage ?? record.spec?.replace(/^clawhub:/i, "").trim();
    const version = record.version ?? record.resolvedVersion;
    return name ? `clawhub:${name}${version ? `@${version}` : ""}` : undefined;
  }
  if (record.source === "git") {
    if (record.spec) {
      return record.spec;
    }
    return record.gitUrl
      ? `git:${record.gitUrl}${record.gitRef ? `#${record.gitRef}` : ""}`
      : undefined;
  }
  if (record.source === "path" || record.source === "archive") {
    return record.sourcePath ?? record.installPath ?? record.spec;
  }
  if (record.source === "marketplace") {
    return record.marketplacePlugin
      ? `clawhub:${record.marketplacePlugin}${record.version ? `@${record.version}` : ""}`
      : record.spec;
  }
  return record.spec;
}

async function buildPluginEntries(params: {
  includes: Set<ClawExportIncludeKind>;
  excludes: Excludes;
  selectedPlugins: string[];
  usedEntryIds: Set<string>;
  warnings: string[];
}): Promise<{ entries: ClawEntry[]; excluded: number }> {
  if (!params.includes.has("plugins") || params.excludes.kinds.has("plugins")) {
    return { entries: [], excluded: 0 };
  }
  const records = await loadInstalledPluginIndexInstallRecords();
  const selected = new Set(params.selectedPlugins);
  const entries: ClawEntry[] = [];
  let excluded = 0;
  for (const [pluginId, record] of Object.entries(records).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (selected.size > 0 && !selected.has(pluginId)) {
      continue;
    }
    if (params.excludes.plugins.has(pluginId)) {
      excluded += 1;
      continue;
    }
    const selector = pluginSelectorFromRecord(record);
    if (!selector) {
      params.warnings.push(
        `Skipped plugin ${JSON.stringify(pluginId)} because its install record has no reusable selector.`,
      );
      continue;
    }
    entries.push({
      kind: "plugin",
      id: nextExportEntryId("plugin", pluginId, params.usedEntryIds),
      selector,
      required: true,
    });
  }
  for (const pluginId of selected) {
    if (!Object.hasOwn(records, pluginId)) {
      params.warnings.push(
        `Requested plugin ${JSON.stringify(pluginId)} is not installed and was not exported.`,
      );
    }
  }
  return { entries, excluded };
}

async function buildFileEntries(params: {
  kind: "workspaceFile" | "persona";
  values: string[];
  includes: Set<ClawExportIncludeKind>;
  excludes: Excludes;
  workspaceRoot: string;
  realWorkspaceRoot: string;
  outPath?: string;
  selectedTargets: Set<string>;
  usedEntryIds: Set<string>;
  warnings: string[];
}): Promise<{ entries: ClawEntry[]; excluded: number }> {
  const includeKind = params.kind === "persona" ? "persona" : "workspace";
  const excludedSet =
    params.kind === "persona" ? params.excludes.personas : params.excludes.workspaceFiles;
  if (!params.includes.has(includeKind) || params.excludes.kinds.has(includeKind)) {
    return { entries: [], excluded: 0 };
  }
  const entries: ClawEntry[] = [];
  let excluded = 0;
  for (const raw of params.values) {
    const absolutePath = resolveWorkspacePath(params.workspaceRoot, raw);
    if (!isPathInside(params.workspaceRoot, absolutePath)) {
      params.warnings.push(
        `Skipped ${params.kind} ${JSON.stringify(raw)} because it is outside the workspace root.`,
      );
      continue;
    }
    const targetPath = workspaceRelativePath(params.workspaceRoot, absolutePath);
    if (excludedSet.has(targetPath) || params.selectedTargets.has(targetPath)) {
      excluded += 1;
      continue;
    }
    let realSourcePath: string;
    try {
      realSourcePath = await realpath(absolutePath);
    } catch {
      params.warnings.push(
        `Skipped ${params.kind} ${JSON.stringify(raw)} because the file could not be read.`,
      );
      continue;
    }
    if (!isPathInside(params.realWorkspaceRoot, realSourcePath)) {
      params.warnings.push(
        `Skipped ${params.kind} ${JSON.stringify(raw)} because it resolves outside the workspace root.`,
      );
      continue;
    }
    const sourceStat = await stat(realSourcePath);
    if (!sourceStat.isFile()) {
      params.warnings.push(
        `Skipped ${params.kind} ${JSON.stringify(raw)} because it is not a regular file.`,
      );
      continue;
    }
    if (sourceStat.size > MAX_CLAW_WORKSPACE_FILE_BYTES) {
      params.warnings.push(
        `Skipped ${params.kind} ${JSON.stringify(raw)} because it is larger than ${MAX_CLAW_WORKSPACE_FILE_BYTES} bytes.`,
      );
      continue;
    }
    params.selectedTargets.add(targetPath);
    await copyFileSourceForManifest({
      outPath: params.outPath,
      absolutePath: realSourcePath,
      targetPath,
    });
    entries.push({
      kind: params.kind,
      id: nextExportEntryId(
        params.kind === "persona" ? "persona" : "file",
        targetPath,
        params.usedEntryIds,
      ),
      path: targetPath,
      source: sourcePathForManifest({ outPath: params.outPath, targetPath }),
      required: true,
    });
  }
  return { entries, excluded };
}

export async function exportClawManifest(options: ClawExportOptions): Promise<ClawExportResult> {
  const includes = parseIncludeKinds(options.include);
  const excludes = parseExcludes(options.exclude);
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const warnings: string[] = [];
  const selectedFileTargets = new Set<string>();
  const usedEntryIds = new Set<string>();
  const pluginResult = await buildPluginEntries({
    includes,
    excludes,
    selectedPlugins: splitList(options.plugins),
    usedEntryIds,
    warnings,
  });
  const workspaceResult = await buildFileEntries({
    kind: "workspaceFile",
    values: splitList(options.workspaceFiles),
    includes,
    excludes,
    workspaceRoot,
    realWorkspaceRoot,
    outPath: options.outPath,
    selectedTargets: selectedFileTargets,
    usedEntryIds,
    warnings,
  });
  const personaResult = await buildFileEntries({
    kind: "persona",
    values: splitList(options.personas),
    includes,
    excludes,
    workspaceRoot,
    realWorkspaceRoot,
    outPath: options.outPath,
    selectedTargets: selectedFileTargets,
    usedEntryIds,
    warnings,
  });
  const manifest: ExportedClawManifest = {
    schemaVersion: CLAW_SCHEMA_VERSION,
    id: options.id,
    name: options.name,
    version: options.version ?? "1.0.0",
    ...(options.publisher ? { publisher: options.publisher } : {}),
    ...(options.description ? { description: options.description } : {}),
    entries: [...pluginResult.entries, ...workspaceResult.entries, ...personaResult.entries],
  };
  if (manifest.entries.length === 0) {
    warnings.push(
      "No Claw entries were selected; pass --plugin, --workspace-file, --persona, or adjust --include/--exclude.",
    );
  }
  const result: ClawExportResult = {
    schemaVersion: "openclaw.clawExport.v1",
    manifest,
    summary: {
      plugins: pluginResult.entries.length,
      workspaceFiles: workspaceResult.entries.length,
      personas: personaResult.entries.length,
      excluded: pluginResult.excluded + workspaceResult.excluded + personaResult.excluded,
      warnings: warnings.length,
    },
    ...(options.outPath ? { outputPath: resolve(options.outPath) } : {}),
    warnings,
  };
  if (options.outPath && manifest.entries.length > 0) {
    const outputPath = resolve(options.outPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  return result;
}
