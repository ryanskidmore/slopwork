import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop review` — design.md §2, D15; work item C3.
 *
 * Moves in_progress -> review. `--mr` is required-with-warning (D15): can
 * enter review without an MR link, but the CLI nags. That nag is C3's
 * concern, not A1's — the flag itself is registered as optional here so
 * the warning path is reachable.
 */
export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Move <ref> from in_progress to review, recording the MR link.")
    .argument("<ref>", "ticket to move into review")
    .option("--mr <url>", "merge/pull request URL (strongly recommended, see D15)")
    .action(() => notImplemented("review", "C3"));
}
