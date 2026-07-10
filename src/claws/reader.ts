// Local package and development-manifest reader for Claws.
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseClawManifest } from "./schema.js";
import type { ClawDiagnostic, ClawReadResult, ClawSourceIdentity } from "./types.js";

type PackageJson = {
  name: string;
  version: string;
  openclaw: { claw: string };
};

const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fileDiagnostic(code: string, message: string, path = "$"): ClawDiagnostic {
  return { level: "error", code, path, message };
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function parsePackageJson(value: unknown): PackageJson | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const openclaw = record.openclaw;
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
    return undefined;
  }
  const claw = (openclaw as Record<string, unknown>).claw;
  if (
    typeof record.name !== "string" ||
    record.name.trim() === "" ||
    typeof record.version !== "string" ||
    !EXACT_VERSION_PATTERN.test(record.version.trim()) ||
    typeof claw !== "string" ||
    claw.trim() === ""
  ) {
    return undefined;
  }
  return { name: record.name, version: record.version, openclaw: { claw } };
}

async function readJson(
  path: string,
  code: string,
): Promise<
  { ok: true; raw: string; value: unknown } | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      diagnostics: [fileDiagnostic(code, `Could not read ${path}: ${(error as Error).message}`)],
    };
  }
  try {
    return { ok: true, raw, value: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic("invalid_json", `Could not parse ${path}: ${(error as Error).message}`),
      ],
    };
  }
}

async function resolvePackageSource(
  packageRoot: string,
): Promise<
  | { ok: true; source: Omit<ClawSourceIdentity, "integrity"> }
  | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  const packageRootReal = await realpath(packageRoot).catch(() => undefined);
  if (!packageRootReal) {
    return {
      ok: false,
      diagnostics: [fileDiagnostic("package_read_failed", `Could not resolve ${packageRoot}.`)],
    };
  }
  const packageJsonPath = resolve(packageRootReal, "package.json");
  const packageJsonResult = await readJson(packageJsonPath, "package_read_failed");
  if (!packageJsonResult.ok) {
    return packageJsonResult;
  }
  const packageJson = parsePackageJson(packageJsonResult.value);
  if (!packageJson) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic(
          "invalid_package_metadata",
          "package.json must declare non-empty name, version, and openclaw.claw fields.",
        ),
      ],
    };
  }
  if (isAbsolute(packageJson.openclaw.claw)) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic("manifest_escapes_package", "openclaw.claw must be package-relative."),
      ],
    };
  }
  const manifestPath = await realpath(resolve(packageRootReal, packageJson.openclaw.claw)).catch(
    () => undefined,
  );
  if (!manifestPath || !isContained(packageRootReal, manifestPath)) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic(
          "manifest_escapes_package",
          "The declared Claw manifest must resolve inside its package root.",
        ),
      ],
    };
  }
  return {
    ok: true,
    source: {
      kind: "package",
      name: packageJson.name,
      version: packageJson.version,
      packageRoot: packageRootReal,
      manifestPath,
    },
  };
}

async function resolveSource(
  path: string,
): Promise<
  | { ok: true; source: Omit<ClawSourceIdentity, "integrity"> }
  | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  const inputPath = resolve(path);
  const inputStat = await stat(inputPath).catch(() => undefined);
  if (!inputStat) {
    return {
      ok: false,
      diagnostics: [fileDiagnostic("read_failed", `Could not resolve Claw source ${inputPath}.`)],
    };
  }
  if (inputStat.isDirectory()) {
    return resolvePackageSource(inputPath);
  }
  if (!inputStat.isFile()) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic("unsupported_source", "Claw source must be a file or directory."),
      ],
    };
  }

  const manifestPath = await realpath(inputPath);
  const packageRoot = await realpath(dirname(manifestPath));
  return {
    ok: true,
    source: {
      kind: "development",
      name: `local:${basename(manifestPath).replace(/\.json$/i, "")}`,
      version: "0.0.0-development",
      packageRoot,
      manifestPath,
    },
  };
}

export async function readClawManifestFile(path: string): Promise<ClawReadResult> {
  const sourceResult = await resolveSource(path);
  if (!sourceResult.ok) {
    return sourceResult;
  }
  const manifestResult = await readJson(sourceResult.source.manifestPath, "read_failed");
  if (!manifestResult.ok) {
    return manifestResult;
  }
  const parsed = parseClawManifest(manifestResult.value);
  if (!parsed.ok) {
    return parsed;
  }
  const source: ClawSourceIdentity = {
    ...sourceResult.source,
    integrity: `sha256:${createHash("sha256").update(manifestResult.raw).digest("hex")}`,
  };
  return { ok: true, manifest: parsed.manifest, source, diagnostics: parsed.diagnostics };
}
