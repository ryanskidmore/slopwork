import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop split` — design.md §4.2; work item B2. */
export function registerSplitCommand(program: Command): void {
  program
    .command("split")
    .description("Split <ref> into new sub-tickets, one per name given.")
    .argument("<ref>", "ticket to split")
    .argument("<names...>", 'names of the sub-tickets, e.g. "sub1" "sub2"')
    .action(() => notImplemented("split", "B2"));
}
