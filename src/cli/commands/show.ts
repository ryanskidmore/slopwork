import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop show` — design.md §4.2; work item B1. */
export function registerShowCommand(program: Command): void {
  program
    .command("show")
    .description("Show a ticket's details: spec, state, edges, sessions, and history.")
    .argument("<ref>", "ticket to show")
    .option("--context", "include the full context pack")
    .option("--tree", "render the ticket's ancestry/descendant tree")
    .action(() => notImplemented("show", "B1"));
}
