// Strict parser for grouped Claw schema version 1 manifests.
import { z } from "zod";
import { parseDurationMs } from "../cli/parse-duration.js";
import { computeNextRunAtMs } from "../cron/schedule.js";
import {
  CLAW_BOOTSTRAP_FILE_NAMES,
  CLAW_SCHEMA_VERSION,
  type ClawDiagnostic,
  type ClawManifest,
} from "./types.js";

const nonEmptyString = z.string().trim().min(1);
const optionalString = nonEmptyString.optional();
const agentId = nonEmptyString.regex(
  /^[a-z][a-z0-9_-]{0,63}$/,
  "Agent id must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens.",
);
const exactVersion = nonEmptyString.regex(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  "Package version must be an exact semantic version.",
);

function isSafeRelativePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return false;
  }
  const segments = normalized.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const packageRelativePath = nonEmptyString.refine(isSafeRelativePath, {
  message: "Path must be package-relative and must not contain traversal segments.",
});

const durationString = nonEmptyString.superRefine((value, ctx) => {
  try {
    parseDurationMs(value, { defaultUnit: "m" });
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid duration; use ms, s, m, or h." });
  }
});

const identitySchema = z
  .object({
    name: optionalString,
    theme: optionalString,
    emoji: optionalString,
    avatar: optionalString,
  })
  .strict();

const agentSchema = z
  .object({
    id: agentId,
    name: optionalString,
    description: optionalString,
    identity: identitySchema.optional(),
    groupChat: z
      .object({ mentionPatterns: z.array(nonEmptyString).min(1).optional() })
      .strict()
      .optional(),
    sandbox: z
      .object({
        mode: z.enum(["off", "non-main", "all"]).optional(),
        scope: z.enum(["session", "agent", "shared"]).optional(),
        workspaceAccess: z.enum(["none", "ro", "rw"]).optional(),
      })
      .strict()
      .optional(),
    tools: z
      .object({
        allow: z.array(nonEmptyString).min(1).optional(),
        deny: z.array(nonEmptyString).min(1).optional(),
      })
      .strict()
      .optional(),
    heartbeat: z
      .object({
        every: durationString.optional(),
        activeHours: z
          .object({ start: optionalString, end: optionalString, timezone: optionalString })
          .strict()
          .optional(),
        lightContext: z.boolean().optional(),
        isolatedSession: z.boolean().optional(),
        skipWhenBusy: z.boolean().optional(),
        timeoutSeconds: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    humanDelay: z
      .object({
        mode: z.enum(["off", "natural", "custom"]).optional(),
        minMs: z.number().int().nonnegative().optional(),
        maxMs: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const workspaceSourceSchema = z.object({ source: packageRelativePath }).strict();
const bootstrapFilesSchema = z
  .object(
    Object.fromEntries(
      CLAW_BOOTSTRAP_FILE_NAMES.map((name) => [name, workspaceSourceSchema.optional()]),
    ) as Record<
      (typeof CLAW_BOOTSTRAP_FILE_NAMES)[number],
      z.ZodOptional<typeof workspaceSourceSchema>
    >,
  )
  .partial()
  .strict();

const workspaceFileSchema = z
  .object({ source: packageRelativePath, path: packageRelativePath })
  .strict();

const workspaceSchema = z
  .object({
    bootstrapFiles: bootstrapFilesSchema.optional().default({}),
    files: z.array(workspaceFileSchema).optional().default([]),
  })
  .strict()
  .default({ bootstrapFiles: {}, files: [] });

const packageSchema = z
  .object({
    kind: z.enum(["skill", "plugin"]),
    source: z.literal("clawhub"),
    ref: nonEmptyString,
    version: exactVersion,
  })
  .strict();

const environmentReference = nonEmptyString.regex(
  /^\$\{[A-Z_][A-Z0-9_]*\}$/,
  "MCP environment values must be unresolved ${ENV_VAR} references.",
);

const mcpServerSchema = z
  .object({
    command: nonEmptyString,
    args: z.array(nonEmptyString).optional(),
    env: z.record(nonEmptyString, environmentReference).optional(),
    toolFilter: z
      .object({
        include: z.array(nonEmptyString).min(1).optional(),
        exclude: z.array(nonEmptyString).min(1).optional(),
      })
      .strict()
      .optional(),
    timeout: z.number().positive().optional(),
    connectTimeout: z.number().positive().optional(),
  })
  .strict();

const cronJobSchema = z
  .object({
    id: agentId,
    name: optionalString,
    schedule: z.object({ cron: nonEmptyString, timezone: optionalString }).strict(),
    session: z.enum(["main", "isolated", "current"]),
    message: nonEmptyString,
    delivery: z
      .object({
        mode: z.enum(["none", "announce"]),
        channel: z.literal("last").optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((job, ctx) => {
    try {
      computeNextRunAtMs(
        { kind: "cron", expr: job.schedule.cron, tz: job.schedule.timezone },
        Date.now(),
      );
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["schedule", "cron"],
        message: "Invalid cron expression or timezone.",
      });
    }
  });

const manifestSchema = z
  .object({
    schemaVersion: z.literal(CLAW_SCHEMA_VERSION),
    agent: agentSchema,
    workspace: workspaceSchema.optional().default({ bootstrapFiles: {}, files: [] }),
    packages: z.array(packageSchema).optional().default([]),
    mcpServers: z
      .record(
        nonEmptyString.regex(/^[a-z][a-z0-9_-]{0,63}$/, "Invalid MCP server name."),
        mcpServerSchema,
      )
      .optional()
      .default({}),
    cronJobs: z.array(cronJobSchema).optional().default([]),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const workspaceTargets = new Set<string>();
    for (const name of CLAW_BOOTSTRAP_FILE_NAMES) {
      if (manifest.workspace.bootstrapFiles[name]) {
        workspaceTargets.add(name);
      }
    }
    manifest.workspace.files.forEach((file, index) => {
      if (workspaceTargets.has(file.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["workspace", "files", index, "path"],
          message: `Workspace destination ${JSON.stringify(file.path)} is declared more than once.`,
        });
      }
      workspaceTargets.add(file.path);
    });

    const packageKeys = new Set<string>();
    manifest.packages.forEach((pkg, index) => {
      const key = `${pkg.kind}:${pkg.source}:${pkg.ref}`;
      if (packageKeys.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["packages", index],
          message: `Package ${JSON.stringify(pkg.ref)} is declared more than once for ${pkg.kind}.`,
        });
      }
      packageKeys.add(key);
    });

    const cronIds = new Set<string>();
    manifest.cronJobs.forEach((job, index) => {
      if (cronIds.has(job.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["cronJobs", index, "id"],
          message: `Cron job id ${JSON.stringify(job.id)} is declared more than once.`,
        });
      }
      cronIds.add(job.id);
    });
  });

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
    code: "invalid_manifest",
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
}

export function parseClawManifest(
  value: unknown,
):
  | { ok: true; manifest: ClawManifest; diagnostics: ClawDiagnostic[] }
  | { ok: false; diagnostics: ClawDiagnostic[] } {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, diagnostics: diagnosticsFromZodError(parsed.error) };
  }
  return { ok: true, manifest: parsed.data as ClawManifest, diagnostics: [] };
}

export { CLAW_SCHEMA_VERSION };
