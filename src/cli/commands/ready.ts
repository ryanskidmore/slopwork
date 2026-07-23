import type { Command } from "commander";
import { notImplemented } from "../errors.js";
import { parseIntegerOption } from "./shared.js";

/** `slop ready` — design.md §2, §4.2; work item B4.
 *
 * ready = open ∧ no live blockers ∧ no active session. Drafts and review
 * items never appear (design.md §2).
 */
export function registerReadyCommand(program: Command): void {
  program
    .command("ready")
    .description("List ready tickets: open, no live blockers, no active session.")
    .option("--label <label>", "filter to tickets carrying this label")
    .option("--resumable", "also include stale in_progress/review tickets worth resuming")
    .option("--json", "machine-readable output")
    .option("--budget <n>", "cap output size to roughly N tokens", parseIntegerOption("--budget"))
    .action(() => notImplemented("ready", "B4"));
}
