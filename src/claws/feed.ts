// Local Claw feed parsing and read-only manifest resolution.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseClawManifest } from "./schema.js";
import {
  CLAW_FEED_SCHEMA_VERSION,
  type ClawDiagnostic,
  type ClawFeed,
  type ClawFeedEntry,
  type ClawFeedManifestReadResult,
  type ClawFeedReadResult,
} from "./types.js";

const nonEmptyString = z.string().trim().min(1);
const optionalString = z.string().trim().min(1).optional();

const feedEntrySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    version: nonEmptyString,
    source: nonEmptyString,
    publisher: optionalString,
    description: optionalString,
    owner: z
      .object({
        type: z.enum(["publisher", "clawhub", "local"]),
        id: nonEmptyString,
      })
      .strict()
      .optional(),
    trust: z
      .object({
        level: z.enum(["unknown", "source", "verified"]),
      })
      .strict()
      .optional(),
  })
  .strict();

const feedSchema = z
  .object({
    schemaVersion: z.literal(CLAW_FEED_SCHEMA_VERSION),
    id: nonEmptyString,
    name: nonEmptyString,
    publisher: optionalString,
    description: optionalString,
    generatedAt: optionalString,
    entries: z.array(feedEntrySchema).min(1),
  })
  .strict();

function formatIssuePath(path: PropertyKey[]): string {
  if (path.length === 0) {
    return "$";
  }
  return `$${path
    .map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`))
    .join("")}`;
}

function diagnosticsFromZodError(error: z.ZodError): ClawDiagnostic[] {
  return error.issues.map((issue) => ({
    level: "error",
    code: "invalid_feed",
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
}

function fileDiagnostic(code: string, message: string): ClawDiagnostic {
  return {
    level: "error",
    code,
    path: "$",
    message,
  };
}

function feedEntryDiagnostic(
  level: ClawDiagnostic["level"],
  code: string,
  index: number,
  message: string,
): ClawDiagnostic {
  return {
    level,
    code,
    path: `$.entries[${index}]`,
    message,
  };
}

function normalizeFeedEntry(value: z.infer<typeof feedEntrySchema>): ClawFeedEntry {
  return {
    id: value.id,
    name: value.name,
    version: value.version,
    source: value.source,
    ...(value.publisher ? { publisher: value.publisher } : {}),
    ...(value.description ? { description: value.description } : {}),
    ...(value.owner ? { owner: value.owner } : {}),
    ...(value.trust ? { trust: value.trust } : {}),
  };
}

function normalizeFeed(value: z.infer<typeof feedSchema>): ClawFeed {
  return {
    schemaVersion: value.schemaVersion,
    id: value.id,
    name: value.name,
    ...(value.publisher ? { publisher: value.publisher } : {}),
    ...(value.description ? { description: value.description } : {}),
    ...(value.generatedAt ? { generatedAt: value.generatedAt } : {}),
    entries: value.entries.map(normalizeFeedEntry),
  };
}

function validateFeedEntries(entries: ClawFeedEntry[]): ClawDiagnostic[] {
  const diagnostics: ClawDiagnostic[] = [];
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const existingIndex = seen.get(entry.id);
    if (existingIndex !== undefined) {
      diagnostics.push(
        feedEntryDiagnostic(
          "error",
          "duplicate_feed_entry",
          index,
          `Feed entry id ${JSON.stringify(entry.id)} duplicates $.entries[${existingIndex}].`,
        ),
      );
    } else {
      seen.set(entry.id, index);
    }
    if (!entry.owner) {
      diagnostics.push(
        feedEntryDiagnostic(
          "warning",
          "feed_entry_owner_missing",
          index,
          "Feed entry does not declare an owner; install trust decisions will need out-of-band ownership evidence.",
        ),
      );
    }
  });
  return diagnostics;
}

export function parseClawFeed(value: unknown): ClawFeedReadResult {
  const parsed = feedSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, diagnostics: diagnosticsFromZodError(parsed.error) };
  }

  const feed = normalizeFeed(parsed.data);
  const diagnostics = validateFeedEntries(feed.entries);
  if (diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    return { ok: false, diagnostics };
  }

  return { ok: true, feed, diagnostics };
}

export async function readClawFeedFile(path: string): Promise<ClawFeedReadResult> {
  const sourcePath = resolve(path);
  let raw: string;
  try {
    raw = await readFile(sourcePath, "utf8");
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic("feed_read_failed", `Could not read claw feed: ${(error as Error).message}`),
      ],
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic(
          "invalid_feed_json",
          `Could not parse claw feed JSON: ${(error as Error).message}`,
        ),
      ],
    };
  }

  return parseClawFeed(value);
}

function hasUrlProtocol(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

function validateManifestPathWithinFeedRoot(params: {
  feedDir: string;
  manifestPath: string;
  entryIndex: number;
}): { ok: true; manifestPath: string } | { ok: false; diagnostics: ClawDiagnostic[] } {
  const manifestPath = resolve(params.manifestPath);
  const relativePath = relative(params.feedDir, manifestPath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return {
      ok: false,
      diagnostics: [
        feedEntryDiagnostic(
          "error",
          "feed_source_escapes_root",
          params.entryIndex,
          "Claw feed source must stay under the directory containing the feed file.",
        ),
      ],
    };
  }
  return { ok: true, manifestPath };
}

export function resolveClawFeedEntrySource(params: {
  feedPath: string;
  entry: ClawFeedEntry;
  entryIndex: number;
}): { ok: true; manifestPath: string } | { ok: false; diagnostics: ClawDiagnostic[] } {
  const source = params.entry.source;
  const feedDir = resolve(params.feedPath, "..");
  if (hasUrlProtocol(source)) {
    if (source.startsWith("file:")) {
      try {
        return validateManifestPathWithinFeedRoot({
          feedDir,
          manifestPath: fileURLToPath(source),
          entryIndex: params.entryIndex,
        });
      } catch (error) {
        return {
          ok: false,
          diagnostics: [
            feedEntryDiagnostic(
              "error",
              "invalid_feed_source",
              params.entryIndex,
              `Could not parse file URL source: ${(error as Error).message}`,
            ),
          ],
        };
      }
    }
    return {
      ok: false,
      diagnostics: [
        feedEntryDiagnostic(
          "error",
          "unsupported_feed_source",
          params.entryIndex,
          "Claw feed sources must be local paths or file URLs in this read-only PR.",
        ),
      ],
    };
  }

  if (isAbsolute(source)) {
    return {
      ok: false,
      diagnostics: [
        feedEntryDiagnostic(
          "error",
          "absolute_feed_source",
          params.entryIndex,
          "Claw feed sources must be relative to the feed file.",
        ),
      ],
    };
  }

  return validateManifestPathWithinFeedRoot({
    feedDir,
    manifestPath: resolve(feedDir, source),
    entryIndex: params.entryIndex,
  });
}

async function validateManifestRealPathWithinFeedRoot(params: {
  feedPath: string;
  manifestPath: string;
  entryIndex: number;
}): Promise<{ ok: true } | { ok: false; diagnostics: ClawDiagnostic[] }> {
  let feedRoot: string;
  let manifestRealPath: string;
  try {
    feedRoot = await realpath(resolve(params.feedPath, ".."));
    manifestRealPath = await realpath(params.manifestPath);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        feedEntryDiagnostic(
          "error",
          "feed_manifest_read_failed",
          params.entryIndex,
          `Could not resolve claw manifest from feed source: ${(error as Error).message}`,
        ),
      ],
    };
  }

  const relativePath = relative(feedRoot, manifestRealPath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return {
      ok: false,
      diagnostics: [
        feedEntryDiagnostic(
          "error",
          "feed_source_escapes_root",
          params.entryIndex,
          "Claw feed source must stay under the directory containing the feed file.",
        ),
      ],
    };
  }

  return { ok: true };
}

function findFeedEntry(
  feed: ClawFeed,
  entryId: string,
): { entry: ClawFeedEntry; index: number } | undefined {
  const index = feed.entries.findIndex((entry) => entry.id === entryId);
  if (index < 0) {
    return undefined;
  }
  return { entry: feed.entries[index], index };
}

export async function readClawManifestFromFeed(params: {
  feedPath: string;
  entryId: string;
}): Promise<ClawFeedManifestReadResult> {
  const feedPath = resolve(params.feedPath);
  const feedResult = await readClawFeedFile(feedPath);
  if (!feedResult.ok) {
    return { ok: false, diagnostics: feedResult.diagnostics };
  }

  const found = findFeedEntry(feedResult.feed, params.entryId);
  if (!found) {
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic(
          "feed_entry_not_found",
          `Claw feed entry ${JSON.stringify(params.entryId)} was not found.`,
        ),
      ],
    };
  }

  const sourceResult = resolveClawFeedEntrySource({
    feedPath,
    entry: found.entry,
    entryIndex: found.index,
  });
  if (!sourceResult.ok) {
    return { ok: false, diagnostics: [...feedResult.diagnostics, ...sourceResult.diagnostics] };
  }

  const realPathResult = await validateManifestRealPathWithinFeedRoot({
    feedPath,
    manifestPath: sourceResult.manifestPath,
    entryIndex: found.index,
  });
  if (!realPathResult.ok) {
    return { ok: false, diagnostics: [...feedResult.diagnostics, ...realPathResult.diagnostics] };
  }

  let raw: string;
  try {
    raw = await readFile(sourceResult.manifestPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        ...feedResult.diagnostics,
        feedEntryDiagnostic(
          "error",
          "feed_manifest_read_failed",
          found.index,
          `Could not read claw manifest from feed source: ${(error as Error).message}`,
        ),
      ],
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        ...feedResult.diagnostics,
        feedEntryDiagnostic(
          "error",
          "invalid_feed_manifest_json",
          found.index,
          `Could not parse claw manifest JSON from feed source: ${(error as Error).message}`,
        ),
      ],
    };
  }

  const manifestResult = parseClawManifest(value);
  if (!manifestResult.ok) {
    return { ok: false, diagnostics: [...feedResult.diagnostics, ...manifestResult.diagnostics] };
  }

  const source = {
    kind: "package" as const,
    name: found.entry.id,
    version: found.entry.version,
    packageRoot: resolve(sourceResult.manifestPath, ".."),
    manifestPath: sourceResult.manifestPath,
    integrity: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
  };

  return {
    ok: true,
    feed: feedResult.feed,
    entry: found.entry,
    manifest: manifestResult.manifest,
    source,
    manifestPath: sourceResult.manifestPath,
    diagnostics: [...feedResult.diagnostics, ...manifestResult.diagnostics],
  };
}

export { CLAW_FEED_SCHEMA_VERSION };
