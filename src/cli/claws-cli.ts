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
};

export type ClawsFeedInspectOptions = {
  json?: boolean;
};

export type ClawsFeedApplyOptions = {
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
};

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
    .description("Preview or persist Claw artifact provenance")
    .argument("<manifest>", "Path to an openclaw.claw.v1 JSON manifest")
    .option("--dry-run", "Preview apply actions without installing or writing files", false)
    .option("--yes", "Persist package-like Claw artifact provenance without prompting", false)
    .option("--json", "Print JSON", false)
    .action(async (manifest: string, opts: ClawsApplyOptions) => {
      const { runClawsApplyCommand } = await import("./claws-cli.runtime.js");
      await runClawsApplyCommand(manifest, opts);
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
    .description("Preview or persist feed Claw artifact provenance")
    .argument("<feed>", "Path to an openclaw.clawFeed.v1 JSON feed")
    .argument("<claw>", "Claw feed entry id")
    .option("--dry-run", "Preview apply actions without installing or writing files", false)
    .option("--yes", "Persist package-like Claw artifact provenance without prompting", false)
    .option("--json", "Print JSON", false)
    .action(async (feedPath: string, claw: string, opts: ClawsFeedApplyOptions) => {
      const { runClawsFeedApplyCommand } = await import("./claws-cli.runtime.js");
      await runClawsFeedApplyCommand(feedPath, claw, opts);
    });

  applyParentDefaultHelpAction(feed);

  applyParentDefaultHelpAction(claws);
}
