import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop drop` — design.md §2; work item C3. */
export function registerDropCommand(program: Command): void {
  program
    .command("drop")
    .description("Mark <ref> dropped (wontdo) from any state.")
    .argument("<ref>", "ticket to drop")
    .requiredOption("--reason <text>", "why this ticket is being dropped")
    .action(() => notImplemented("drop", "C3"));
}
