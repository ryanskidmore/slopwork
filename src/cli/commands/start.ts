import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop start` — design.md §2, §4.2, §4.3, D9, D17; work item C1. */
export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description(
      "Start a session on <ref>: creates a session (harness+git capture), moves the " +
        "ticket to in_progress, and prints the context pack.",
    )
    .argument("<ref>", "ticket to start")
    .option("--as <name>", "override actor identity for this session (see D17)")
    .option(
      "--harness <kind>",
      "override harness auto-detection (claude-code|opencode|codex|other)",
    )
    .option("--takeover", "take over a ticket with another active session (logged)")
    .action(() => notImplemented("start", "C1"));
}
