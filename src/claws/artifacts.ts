// Package preview helpers for grouped Claw skill and plugin declarations.
import type { ClawPackage } from "./types.js";

export function buildClawArtifactPreview(pkg: ClawPackage) {
  return {
    kind: pkg.kind,
    source: pkg.source,
    ref: pkg.ref,
    version: pkg.version,
    selector: `${pkg.source}:${pkg.ref}@${pkg.version}`,
    installSurface: pkg.kind === "skill" ? "skills" : "plugins",
    supported: true,
  } as const;
}
