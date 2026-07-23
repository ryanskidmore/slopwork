import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop status` — design.md §4.2; work item D4. */
export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description(
      "Project pulse: counts by state, in-progress tickets with sessions, stale " +
        "items, and tickets awaiting review with MR links.",
    )
    .action(() => notImplemented("status", "D4"));
}
