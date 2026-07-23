import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop draft` — design.md §4.2, D13; work item B2. */
export function registerDraftCommand(program: Command): void {
  program
    .command("draft")
    .description("Move a ticket to draft state (drafts are never `ready` and never started).")
    .argument("<ref>", "ticket to move to draft")
    .action(() => notImplemented("draft", "B2"));
}
