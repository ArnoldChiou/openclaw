// Shared Claw artifact identity helpers for installed artifact records.
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";

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
