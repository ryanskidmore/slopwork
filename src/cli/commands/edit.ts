import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop edit` — design.md §4.2; work item B1. */
export function registerEditCommand(program: Command): void {
  program
    .command("edit")
    .description("Open <ref>'s ticket JSONC file in $EDITOR.")
    .argument("<ref>", "ticket to edit")
    .action(() => notImplemented("edit", "B1"));
}
