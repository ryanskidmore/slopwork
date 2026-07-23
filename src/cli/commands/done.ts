import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop done` — design.md §2, §4.3, D16; work item C3. */
export function registerDoneCommand(program: Command): void {
  program
    .command("done")
    .description(
      "Complete <ref>: finalize the session (end summary + transcript per D16), " +
        "cascade unblocks, and mark done.",
    )
    .argument("<ref>", "ticket to complete")
    .option("--note <text>", "completion note")
    .action(() => notImplemented("done", "C3"));
}
