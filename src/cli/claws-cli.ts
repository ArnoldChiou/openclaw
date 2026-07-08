// Commander registration for Claws inspection and apply lifecycle commands.
import type { Command } from "commander";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

export type ClawsInspectOptions = {
  json?: boolean;
};

export type ClawsApplyOptions = {
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
  workspace?: string;
};

export type ClawsFeedInspectOptions = {
  json?: boolean;
};

export type ClawsFeedApplyOptions = {
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
  workspace?: string;
};

export type ClawsStatusOptions = {
  json?: boolean;
};

export type ClawsRemoveOptions = {
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
};

export type ClawsExportOptions = {
  id: string;
  name: string;
  version?: string;
  publisher?: string;
  description?: string;
  workspace?: string;
  include?: string[];
  exclude?: string[];
  plugin?: string[];
  workspaceFile?: string[];
  persona?: string[];
  out?: string;
  json?: boolean;
};

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerClawsCli(program: Command) {
  const claws = program.command("claws").description("Inspect and apply OpenClaw Claws");

  claws
    .command("inspect")
    .description("Validate and summarize a local claw manifest")
    .argument("<manifest>", "Path to an openclaw.claw.v1 JSON manifest")
    .option("--json", "Print JSON", false)
    .action(async (manifest: string, opts: ClawsInspectOptions) => {
      const { runClawsInspectCommand } = await import("./claws-cli.runtime.js");
      await runClawsInspectCommand(manifest, opts);
    });

  claws
    .command("apply")
    .description("Preview or apply Claw workspace files and artifact provenance")
    .argument("<manifest>", "Path to an openclaw.claw.v1 JSON manifest")
    .option("--dry-run", "Preview apply actions without installing or writing files", false)
    .option("--yes", "Apply supported Claw mutations without prompting", false)
    .option("--workspace <dir>", "Workspace root for workspace and persona file writes")
    .option("--json", "Print JSON", false)
    .action(async (manifest: string, opts: ClawsApplyOptions) => {
      const { runClawsApplyCommand } = await import("./claws-cli.runtime.js");
      await runClawsApplyCommand(manifest, opts);
    });

  claws
    .command("status")
    .description("Show persisted Claw apply state")
    .argument("[claw]", "Claw id to inspect")
    .option("--json", "Print JSON", false)
    .action(async (claw: string | undefined, opts: ClawsStatusOptions) => {
      const { runClawsStatusCommand } = await import("./claws-cli.runtime.js");
      await runClawsStatusCommand(claw, opts);
    });

  claws
    .command("remove")
    .description("Remove persisted Claw refs and managed workspace files")
    .argument("<claw>", "Claw id to remove")
    .option("--dry-run", "Preview removal without deleting files or refs", false)
    .option("--yes", "Remove supported Claw state without prompting", false)
    .option("--json", "Print JSON", false)
    .action(async (claw: string, opts: ClawsRemoveOptions) => {
      const { runClawsRemoveCommand } = await import("./claws-cli.runtime.js");
      await runClawsRemoveCommand(claw, opts);
    });

  claws
    .command("export")
    .description("Create a Claw manifest from selected local OpenClaw state")
    .requiredOption("--id <id>", "Claw id for the exported manifest")
    .requiredOption("--name <name>", "Claw display name for the exported manifest")
    .option("--version <version>", "Claw version", "1.0.0")
    .option("--publisher <publisher>", "Claw publisher")
    .option("--description <description>", "Claw description")
    .option("--workspace <dir>", "Workspace root for selected workspace files")
    .option("--include <items>", "Comma-separated entry kinds to include", collectOption, [])
    .option("--exclude <items>", "Comma-separated entry kinds, ids, or paths to exclude", collectOption, [])
    .option("--plugin <id>", "Installed plugin id to include; repeat for multiple plugins", collectOption, [])
    .option("--workspace-file <path>", "Workspace file path to include; repeat for multiple files", collectOption, [])
    .option("--persona <path>", "Persona file path to include; repeat for multiple files", collectOption, [])
    .option("--out <manifest>", "Write the generated manifest to a file")
    .option("--json", "Print JSON export result", false)
    .action(async (opts: ClawsExportOptions) => {
      const { runClawsExportCommand } = await import("./claws-cli.runtime.js");
      await runClawsExportCommand(opts);
    });

  const feed = claws.command("feed").description("Inspect and apply Claws from a local feed");

  feed
    .command("inspect")
    .description("Validate and summarize a local claw feed")
    .argument("<feed>", "Path to an openclaw.clawFeed.v1 JSON feed")
    .option("--json", "Print JSON", false)
    .action(async (feedPath: string, opts: ClawsFeedInspectOptions) => {
      const { runClawsFeedInspectCommand } = await import("./claws-cli.runtime.js");
      await runClawsFeedInspectCommand(feedPath, opts);
    });

  feed
    .command("apply")
    .description("Preview or apply feed Claw workspace files and artifact provenance")
    .argument("<feed>", "Path to an openclaw.clawFeed.v1 JSON feed")
    .argument("<claw>", "Claw feed entry id")
    .option("--dry-run", "Preview apply actions without installing or writing files", false)
    .option("--yes", "Apply supported Claw mutations without prompting", false)
    .option("--workspace <dir>", "Workspace root for workspace and persona file writes")
    .option("--json", "Print JSON", false)
    .action(async (feedPath: string, claw: string, opts: ClawsFeedApplyOptions) => {
      const { runClawsFeedApplyCommand } = await import("./claws-cli.runtime.js");
      await runClawsFeedApplyCommand(feedPath, claw, opts);
    });

  applyParentDefaultHelpAction(feed);

  applyParentDefaultHelpAction(claws);
}
