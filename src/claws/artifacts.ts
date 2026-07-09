// Read-only Claw artifact selector and provenance preview helpers.
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { isImmutableGitCommitRef, parseGitPluginSpec } from "../infra/git-plugin-spec.js";
import { isExactSemverVersion, parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import {
  parseNpmPackPrefixPath,
  resolveFileNpmSpecToLocalPath,
} from "../infra/plugin-install-specs.js";
import type {
  ClawArtifactInstallSurface,
  ClawArtifactPreview,
  ClawArtifactProvenanceRecord,
  ClawArtifactSource,
  ClawPackageEntry,
} from "./types.js";

type ParsedSelector = {
  source: ClawArtifactSource;
  packageName?: string;
  version?: string;
  pinned?: boolean;
  supported: boolean;
};

const INSTALL_SURFACE_BY_KIND: Record<ClawPackageEntry["kind"], ClawArtifactInstallSurface> = {
  skill: "skills",
  plugin: "plugins",
  mcpServer: "mcpServers",
  connector: "connectors",
};

const PROVENANCE_RECORD_BY_KIND: Record<ClawPackageEntry["kind"], ClawArtifactProvenanceRecord> = {
  skill: "skill.clawhubOrigin",
  plugin: "plugin.installRecord",
  mcpServer: "mcpServer.installRecord",
  connector: "connector.installRecord",
};

function isAbsoluteLocalPath(selector: string): boolean {
  return (
    selector.startsWith("/") || /^[A-Za-z]:[\\/]/.test(selector) || selector.startsWith("\\\\")
  );
}

function parseInlineMcpServerSelector(
  selector: string,
  entry: ClawPackageEntry,
): ParsedSelector | undefined {
  if (entry.kind !== "mcpServer") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(selector) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return {
        source: "inline",
        packageName: entry.id,
        supported: true,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseArtifactSelector(entry: ClawPackageEntry): ParsedSelector {
  const selector = entry.selector;
  const inlineMcp = parseInlineMcpServerSelector(selector, entry);
  if (inlineMcp) {
    return inlineMcp;
  }
  const clawHub = parseClawHubPluginSpec(selector);
  if (clawHub) {
    return {
      source: "clawhub",
      packageName: clawHub.name,
      ...(clawHub.version ? { version: clawHub.version } : {}),
      pinned: clawHub.version ? isExactSemverVersion(clawHub.version) : false,
      supported: true,
    };
  }
  if (selector.trim().toLowerCase().startsWith("clawhub:")) {
    return { source: "clawhub", supported: false };
  }

  if (selector.trim().toLowerCase().startsWith("npm:")) {
    const spec = selector.trim().slice("npm:".length).trim();
    const npm = parseRegistryNpmSpec(spec);
    return npm
      ? {
          source: "npm",
          packageName: npm.name,
          ...(npm.selector ? { version: npm.selector } : {}),
          pinned: npm.selectorKind === "exact-version",
          supported: true,
        }
      : { source: "npm", supported: false };
  }

  const npmPackPath = parseNpmPackPrefixPath(selector);
  if (npmPackPath !== null) {
    return { source: "npmPack", supported: npmPackPath.length > 0 };
  }

  if (selector.trim().toLowerCase().startsWith("git:")) {
    const git = parseGitPluginSpec(selector);
    return {
      source: "git",
      ...(git?.ref ? { version: git.ref } : {}),
      pinned: git?.ref ? isImmutableGitCommitRef(git.ref) : false,
      supported: git !== null,
    };
  }
  if (selector.trim().toLowerCase().startsWith("git+")) {
    return { source: "git", supported: false };
  }

  const fileSpec = resolveFileNpmSpecToLocalPath(selector);
  if (fileSpec !== null) {
    return { source: "path", supported: fileSpec.ok };
  }
  if (selector.startsWith("./") || selector.startsWith("../") || isAbsoluteLocalPath(selector)) {
    return { source: "path", supported: true };
  }
  return { source: "unknown", supported: false };
}

function pinningFor(parsed: ParsedSelector): ClawArtifactPreview["provenance"]["pinning"] {
  if (!parsed.supported) {
    return "unknown";
  }
  return parsed.pinned ? "pinned" : "floating";
}

export function buildClawArtifactPreview(entry: ClawPackageEntry): ClawArtifactPreview {
  const parsed = parseArtifactSelector(entry);
  return {
    source: parsed.source,
    selector: entry.selector,
    installSurface: INSTALL_SURFACE_BY_KIND[entry.kind],
    ...(parsed.packageName ? { packageName: parsed.packageName } : {}),
    ...(parsed.version ? { version: parsed.version } : {}),
    provenance: {
      record: PROVENANCE_RECORD_BY_KIND[entry.kind],
      requestedSpecifier: entry.selector,
      pinning: pinningFor(parsed),
    },
    supported: parsed.supported,
  };
}
