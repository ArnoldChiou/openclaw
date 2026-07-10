/**
 * View-model for tool-call rows.
 *
 * Classifies a tool call into a small set of presentation kinds (command,
 * read, edit, write, search, fetch, generic) across the arg spellings used by
 * the OpenClaw session tools and foreign harnesses (Claude/Codex style).
 */

import {
  buildWriteDiffLines,
  computeLineDiff,
  countTextLines,
  diffStat,
  joinDiffSections,
  parseDiffDetailsString,
  type DiffLine,
  type DiffStat,
} from "./tool-call-diff.ts";

export type ToolCallKind = "command" | "read" | "edit" | "write" | "search" | "fetch" | "generic";

export type ToolCallViewSource = {
  name: string;
  args?: unknown;
  details?: unknown;
};

export type ToolCallView = {
  kind: ToolCallKind;
  /** Full command text for `command` rows (first line shown collapsed). */
  command?: string;
  /** File basename or primary target shown bold in the row. */
  target?: string;
  /** Dimmed secondary detail (directory, query scope, URL host…). */
  targetDetail?: string;
  /** Inline diff rows for edit/write calls. */
  diff?: DiffLine[];
  stat?: DiffStat;
};

const COMMAND_TOOL_NAMES = new Set(["bash", "exec", "shell", "run_command", "run_terminal_cmd"]);
const READ_TOOL_NAMES = new Set(["read", "read_file", "readfile", "notebookread", "notebook_read"]);
const EDIT_TOOL_NAMES = new Set([
  "edit",
  "edit_file",
  "multiedit",
  "multi_edit",
  "str_replace_editor",
  "notebookedit",
  "notebook_edit",
]);
const WRITE_TOOL_NAMES = new Set(["write", "write_file", "create_file"]);
const SEARCH_TOOL_NAMES = new Set(["grep", "find", "glob", "ls", "list", "codebase_search"]);
const FETCH_TOOL_NAMES = new Set(["web_fetch", "webfetch", "fetch"]);
const PATCH_TOOL_NAMES = new Set(["apply_patch", "applypatch", "patch"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolvePathArg(args: Record<string, unknown> | null): string | undefined {
  if (!args) {
    return undefined;
  }
  return (
    readString(args.path) ??
    readString(args.file_path) ??
    readString(args.filePath) ??
    readString(args.filename) ??
    readString(args.notebook_path)
  );
}

export function splitPathForDisplay(path: string): { base: string; dir?: string } {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) {
    return { base: normalized || path };
  }
  return { base: normalized.slice(slash + 1), dir: normalized.slice(0, slash) };
}

type EditPair = { oldText: string; newText: string };

function readEditPairs(args: Record<string, unknown>): EditPair[] {
  const pairs: EditPair[] = [];
  const push = (oldText: unknown, newText: unknown) => {
    if (typeof oldText === "string" && typeof newText === "string") {
      pairs.push({ oldText, newText });
    }
  };
  if (Array.isArray(args.edits)) {
    for (const entry of args.edits) {
      const record = asRecord(entry);
      if (record) {
        push(
          record.oldText ?? record.old_string ?? record.oldString,
          record.newText ?? record.new_string ?? record.newString,
        );
      }
    }
  } else {
    push(
      args.oldText ?? args.old_string ?? args.oldString,
      args.newText ?? args.new_string ?? args.newString,
    );
  }
  return pairs;
}

function readDetailsDiff(details: unknown): DiffLine[] | null {
  const record = asRecord(details);
  const diffText = record ? readString(record.diff) : undefined;
  if (!diffText) {
    return null;
  }
  return parseDiffDetailsString(diffText);
}

function resolveEditDiff(source: ToolCallViewSource): DiffLine[] | null {
  const fromDetails = readDetailsDiff(source.details);
  if (fromDetails) {
    return fromDetails;
  }
  const args = asRecord(source.args);
  if (!args) {
    return null;
  }
  const pairs = readEditPairs(args);
  if (pairs.length === 0) {
    return null;
  }
  const sections = pairs.map((pair) => computeLineDiff(pair.oldText, pair.newText));
  const joined = joinDiffSections(sections);
  return joined.length > 0 ? joined : null;
}

/**
 * Minimal Codex-style patch reader: extracts the target path plus add/del
 * rows so patch calls render like edits. Anything unrecognized stays generic.
 */
function resolvePatchView(args: Record<string, unknown> | null): ToolCallView | null {
  const patchText = args
    ? (readString(args.patch) ?? readString(args.input) ?? readString(args.diff))
    : undefined;
  if (!patchText) {
    return null;
  }
  let target: string | undefined;
  const lines: DiffLine[] = [];
  for (const raw of patchText.split("\n")) {
    const fileMatch = raw.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\+\+\+ (?:b\/)?(.+)$/);
    if (fileMatch) {
      target ??= (fileMatch[1] ?? fileMatch[2])?.trim();
      continue;
    }
    if (/^\*\*\*|^---|^@@|^index |^diff /.test(raw)) {
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1) });
    } else {
      lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
    }
  }
  const stat = diffStat(lines);
  if (!target && stat.added === 0 && stat.removed === 0) {
    return null;
  }
  const pathParts = target ? splitPathForDisplay(target) : null;
  return {
    kind: "edit",
    target: pathParts?.base,
    targetDetail: pathParts?.dir,
    diff: lines,
    stat,
  };
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase();
}

export function resolveToolCallKind(name: string, args?: unknown): ToolCallKind {
  const key = normalizeKey(name);
  if (COMMAND_TOOL_NAMES.has(key)) {
    return "command";
  }
  if (READ_TOOL_NAMES.has(key)) {
    return "read";
  }
  if (EDIT_TOOL_NAMES.has(key) || PATCH_TOOL_NAMES.has(key)) {
    return "edit";
  }
  if (WRITE_TOOL_NAMES.has(key)) {
    return "write";
  }
  if (SEARCH_TOOL_NAMES.has(key)) {
    return "search";
  }
  if (FETCH_TOOL_NAMES.has(key)) {
    return "fetch";
  }
  // Arg-shape fallback for harness-specific command tools.
  const record = asRecord(args);
  if (record && typeof record.command === "string" && Object.keys(record).length <= 3) {
    return "command";
  }
  return "generic";
}

const toolCallViewCache = new WeakMap<object, ToolCallView>();

export function resolveToolCallView(source: ToolCallViewSource): ToolCallView {
  const args = asRecord(source.args);
  const cacheKey = args ?? asRecord(source.details);
  if (cacheKey) {
    const cached = toolCallViewCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }
  const view = buildToolCallView(source, args);
  if (cacheKey) {
    toolCallViewCache.set(cacheKey, view);
  }
  return view;
}

function buildToolCallView(
  source: ToolCallViewSource,
  args: Record<string, unknown> | null,
): ToolCallView {
  const kind = resolveToolCallKind(source.name, source.args);
  const key = normalizeKey(source.name);

  if (kind === "command") {
    const command = args ? readString(args.command) : undefined;
    return { kind, command };
  }

  if (kind === "read") {
    const path = resolvePathArg(args);
    if (!path) {
      return { kind: "generic" };
    }
    const { base, dir } = splitPathForDisplay(path);
    return { kind, target: base, targetDetail: dir };
  }

  if (kind === "edit") {
    if (PATCH_TOOL_NAMES.has(key)) {
      return resolvePatchView(args) ?? { kind: "generic" };
    }
    const path = resolvePathArg(args);
    if (!path) {
      return { kind: "generic" };
    }
    const { base, dir } = splitPathForDisplay(path);
    const diff = resolveEditDiff(source);
    return {
      kind,
      target: base,
      targetDetail: dir,
      ...(diff ? { diff, stat: diffStat(diff) } : {}),
    };
  }

  if (kind === "write") {
    const path = resolvePathArg(args);
    if (!path) {
      return { kind: "generic" };
    }
    const { base, dir } = splitPathForDisplay(path);
    const content = args ? readString(args.content) : undefined;
    if (!content) {
      return { kind, target: base, targetDetail: dir };
    }
    const diff = buildWriteDiffLines(content);
    return {
      kind,
      target: base,
      targetDetail: dir,
      diff,
      stat: { added: countTextLines(content), removed: 0 },
    };
  }

  if (kind === "search") {
    const pattern = args
      ? (readString(args.pattern) ?? readString(args.query) ?? readString(args.glob))
      : undefined;
    const path = resolvePathArg(args) ?? (args ? readString(args.path) : undefined);
    if (!pattern && !path) {
      return { kind: "generic" };
    }
    return { kind, target: pattern ?? path, targetDetail: pattern ? path : undefined };
  }

  if (kind === "fetch") {
    const url = args ? readString(args.url) : undefined;
    if (!url) {
      return { kind: "generic" };
    }
    return { kind, target: url };
  }

  return { kind: "generic" };
}
