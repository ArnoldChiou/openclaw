// Shared Claw artifact identity helpers for installed artifact records.
import { dirname, isAbsolute, resolve } from "node:path";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { isExactSemverVersion, parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import {
  parseNpmPackPrefixPath,
  resolveFileNpmSpecToLocalPath,
} from "../infra/plugin-install-specs.js";
import type { ClawApplyPlanEntry } from "./types.js";

function npmArtifactKeyFromRecord(record: PluginInstallRecord): string | undefined {
  const name = record.resolvedName?.trim();
  const version = record.resolvedVersion?.trim() || record.version?.trim();
  if (name && version) {
    return `plugins:npm:${name}@${version}`;
  }
  for (const candidate of [record.resolvedSpec, record.spec]) {
    if (!candidate) {
      continue;
    }
    const parsed = parseRegistryNpmSpec(candidate.trim().replace(/^npm:/i, ""));
    if (parsed?.name) {
      return `plugins:npm:${parsed.name}${parsed.selector ? `@${parsed.selector}` : ""}`;
    }
  }
  return undefined;
}

export function pluginArtifactKeyFromInstallRecord(
  pluginId: string,
  record: PluginInstallRecord,
): string | undefined {
  switch (record.source) {
    case "npm":
      return npmArtifactKeyFromRecord(record);
    case "path":
    case "archive":
      return `plugins:path:${record.sourcePath ?? record.installPath ?? pluginId}`;
    case "git":
      return record.spec ? `plugins:${record.spec}` : undefined;
    case "clawhub": {
      const name = record.clawhubPackage ?? record.spec?.replace(/^clawhub:/i, "");
      const version = record.version ?? record.resolvedVersion;
      return name ? `plugins:clawhub:${name}${version ? `@${version}` : ""}` : undefined;
    }
    default:
      return undefined;
  }
}

function isLocalAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\");
}

function resolveLocalIdentity(selector: string, sourcePath?: string): string {
  const npmPackPath = parseNpmPackPrefixPath(selector);
  const fileSpec = npmPackPath === null ? resolveFileNpmSpecToLocalPath(selector) : null;
  const localPath = npmPackPath ?? (fileSpec?.ok ? fileSpec.path : selector);
  if (isLocalAbsolutePath(localPath)) {
    return localPath;
  }
  return resolve(sourcePath ? dirname(sourcePath) : process.cwd(), localPath);
}

function recordNpmName(record: PluginInstallRecord): string | undefined {
  const resolved = record.resolvedName?.trim();
  if (resolved) {
    return resolved;
  }
  for (const candidate of [record.resolvedSpec, record.spec]) {
    if (!candidate) {
      continue;
    }
    const parsed = parseRegistryNpmSpec(candidate.trim().replace(/^npm:/i, ""));
    if (parsed?.name) {
      return parsed.name;
    }
  }
  return undefined;
}

function recordNpmSelector(record: PluginInstallRecord): string | undefined {
  const resolved = record.resolvedVersion?.trim() || record.version?.trim();
  if (resolved) {
    return resolved;
  }
  for (const candidate of [record.resolvedSpec, record.spec]) {
    if (!candidate) {
      continue;
    }
    const parsed = parseRegistryNpmSpec(candidate.trim().replace(/^npm:/i, ""));
    if (parsed?.selector) {
      return parsed.selector;
    }
  }
  return undefined;
}

function recordRequestedNpmSelector(record: PluginInstallRecord): string | undefined {
  for (const candidate of [record.spec, record.resolvedSpec]) {
    if (!candidate) {
      continue;
    }
    const parsed = parseRegistryNpmSpec(candidate.trim().replace(/^npm:/i, ""));
    if (parsed?.selector) {
      return parsed.selector;
    }
  }
  return undefined;
}

function normalizeExactNpmVersion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return isExactSemverVersion(trimmed) ? trimmed.replace(/^v/i, "") : trimmed;
}

function isExactNpmEntry(artifact: NonNullable<ClawApplyPlanEntry["artifact"]>): boolean {
  return artifact.provenance.pinning === "pinned" && Boolean(artifact.version);
}

function npmRecordMatchesEntry(
  artifact: NonNullable<ClawApplyPlanEntry["artifact"]>,
  record: PluginInstallRecord,
): boolean {
  if (record.source !== "npm" || record.artifactKind === "npm-pack") {
    return false;
  }
  if (!artifact.packageName || recordNpmName(record) !== artifact.packageName) {
    return false;
  }
  if (!isExactNpmEntry(artifact)) {
    return !artifact.version || recordRequestedNpmSelector(record) === artifact.version;
  }
  return (
    normalizeExactNpmVersion(recordNpmSelector(record)) ===
    normalizeExactNpmVersion(artifact.version)
  );
}

function npmPackRecordMatchesEntry(
  entry: ClawApplyPlanEntry,
  record: PluginInstallRecord,
  sourcePath?: string,
): boolean {
  if (record.artifactKind !== "npm-pack") {
    return false;
  }
  const selector = entry.artifact?.selector ?? entry.target ?? entry.id;
  const expectedPath = resolveLocalIdentity(selector, sourcePath);
  return [record.sourcePath, record.spec?.replace(/^npm-pack:/i, "")]
    .filter((value): value is string => Boolean(value))
    .some((value) => resolveLocalIdentity(value, sourcePath) === expectedPath);
}

function clawhubNameFromSpec(spec: string | undefined): string | undefined {
  const raw = spec?.replace(/^clawhub:/i, "").trim();
  if (!raw) {
    return undefined;
  }
  const versionSeparator = raw.lastIndexOf("@");
  return versionSeparator > 0 ? raw.slice(0, versionSeparator) : raw;
}

function clawhubRecordMatchesEntry(
  artifact: NonNullable<ClawApplyPlanEntry["artifact"]>,
  record: PluginInstallRecord,
): boolean {
  if (record.source !== "clawhub" || !artifact.packageName) {
    return false;
  }
  const recordName = record.clawhubPackage ?? clawhubNameFromSpec(record.spec);
  if (recordName !== artifact.packageName) {
    return false;
  }
  if (!artifact.version) {
    return true;
  }
  return (record.version ?? record.resolvedVersion) === artifact.version;
}

function resolveLocalGitIdentity(selector: string, sourcePath?: string): string {
  const trimmed = selector.trim();
  if (!trimmed.toLowerCase().startsWith("git:")) {
    return selector;
  }
  const body = trimmed.slice("git:".length).trim();
  if (!(body.startsWith("./") || body.startsWith("../"))) {
    return selector;
  }
  const hashIndex = body.lastIndexOf("#");
  const atIndex = body.lastIndexOf("@");
  const splitIndex = hashIndex > 0 ? hashIndex : atIndex > 0 ? atIndex : -1;
  const base = splitIndex > 0 ? body.slice(0, splitIndex) : body;
  const refSuffix = splitIndex > 0 ? body.slice(splitIndex) : "";
  return `git:file://${resolve(sourcePath ? dirname(sourcePath) : process.cwd(), base)}${refSuffix}`;
}

function requestedArtifactKey(entry: ClawApplyPlanEntry, sourcePath?: string): string | undefined {
  const artifact = entry.artifact;
  if (!artifact) {
    return undefined;
  }
  const selector = artifact.selector ?? entry.target ?? entry.id;
  if (artifact.source === "path" || artifact.source === "npmPack") {
    return `${artifact.installSurface}:${artifact.source}:${resolveLocalIdentity(selector, sourcePath)}`;
  }
  if (artifact.source === "git") {
    return `${artifact.installSurface}:${resolveLocalGitIdentity(selector, sourcePath)}`;
  }
  if (artifact.packageName) {
    return `${artifact.installSurface}:${artifact.source}:${artifact.packageName}${artifact.version ? `@${artifact.version}` : ""}`;
  }
  return `${artifact.installSurface}:${selector}`;
}

export function pluginInstallRecordMatchesClawArtifact(
  entry: ClawApplyPlanEntry,
  record: PluginInstallRecord,
  sourcePath?: string,
): boolean {
  const artifact = entry.artifact;
  if (!artifact || artifact.installSurface !== "plugins") {
    return false;
  }
  switch (artifact.source) {
    case "npm":
      return npmRecordMatchesEntry(artifact, record);
    case "npmPack":
      return npmPackRecordMatchesEntry(entry, record, sourcePath);
    case "clawhub":
      return clawhubRecordMatchesEntry(artifact, record);
    case "path":
    case "git":
      return (
        pluginArtifactKeyFromInstallRecord(entry.id, record) ===
        requestedArtifactKey(entry, sourcePath)
      );
    default:
      return false;
  }
}
