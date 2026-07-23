import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop context` — design.md §4.2, §5.2; work item C1. */
export function registerContextCommand(program: Command): void {
  program
    .command("context")
    .description(
      "Reprint <ref>'s context pack (spec, ancestry, blockers, prior sessions) " +
        "mid-session, without changing state.",
    )
    .argument("<ref>", "ticket whose context pack to print")
    .action(() => notImplemented("context", "C1"));
}
