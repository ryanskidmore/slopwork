import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop undraft` — design.md §4.2, D13; work item B2. */
export function registerUndraftCommand(program: Command): void {
  program
    .command("undraft")
    .description("Move a draft ticket to open, making it eligible for `ready`.")
    .argument("<ref>", "draft ticket to open")
    .action(() => notImplemented("undraft", "B2"));
}
