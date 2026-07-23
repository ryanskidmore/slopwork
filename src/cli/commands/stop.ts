import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop stop` — design.md §2, §4.3, D16; work item C1. */
export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description(
      "End the current session on <ref> without completing it (hands off; " +
        "captures the transcript per D16).",
    )
    .argument("<ref>", "ticket to stop")
    .option("--note <text>", "handoff note for the next session")
    .action(() => notImplemented("stop", "C1"));
}
