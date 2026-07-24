import type { Command } from "commander";
import { EXIT_CODES } from "../../core/exit-codes.js";
import {
  formatIndexProblems,
  listTickets,
  rebuildIndex,
  repoPaths,
  requireRepoRoot,
  sweepStaleTempFiles,
} from "../../repo/index.js";
import { SlopError } from "../errors.js";

interface ReindexOptions {
  strict?: boolean;
}

/**
 * `slop reindex` — design.md §3, D3, D14; work item A3.
 *
 * The recovery path for a corrupt db (D3, D14). Fault-tolerant by default
 * (adversarial-review Finding 3): a single unreadable ticket file no
 * longer aborts the whole run — every good ticket is rebuilt and
 * persisted, every bad one is reported in one pass with its full
 * actionable error (db-index.ts's `formatIndexProblems`, same message
 * quality `readTicket` itself would throw), and the command exits
 * non-zero (`GENERIC_ERROR`, 1) only if any problem remains, so scripts
 * can still branch on success. `--strict` restores the pre-fault
 * -tolerance all-or-nothing behavior for anyone who explicitly wants a
 * hard fail on the first bad file instead.
 */
export async function runReindex(options: ReindexOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);

  if (options.strict) {
    // Fail fast, exactly like any other direct-by-id read: the first
    // unreadable ticket file throws its full, actionable error and
    // nothing else runs — index.jsonc is left untouched. `buildIndex`
    // itself is always fault-tolerant now; --strict is implemented as
    // this up-front gate specifically so `reindex` alone can opt back
    // into the old all-or-nothing behavior.
    await listTickets(paths);
  }

  const index = await rebuildIndex(paths);

  const swept = await sweepStaleTempFiles([
    paths.dbDir,
    paths.ticketsDir,
    paths.sessionsDir,
    paths.eventsDir,
  ]);

  const slugCount = Object.keys(index.slugs).length;
  const sweptNote = swept.length > 0 ? `; swept ${swept.length} stale temp file(s)` : "";

  if (index.problems.length > 0) {
    process.stderr.write(`${formatIndexProblems(index.problems)}\n`);
    process.stdout.write(
      `reindexed: ${index.tickets.length} ticket(s) rebuilt, ${index.problems.length} skipped due to errors, ${slugCount} slug(s)${sweptNote}\n`,
    );
    throw new SlopError(
      `reindex finished with ${index.problems.length} unreadable ticket file(s) (see the errors above); ` +
        "fix them and re-run `slop reindex` — everything else was rebuilt and saved successfully",
      EXIT_CODES.GENERIC_ERROR,
    );
  }

  process.stdout.write(
    `reindexed: ${index.tickets.length} ticket(s), ${slugCount} slug(s)${sweptNote}\n`,
  );
}

export function registerReindexCommand(program: Command): void {
  program
    .command("reindex")
    .description(
      "Rebuild the derived, gitignored .slop/db/index.jsonc from the tickets, " +
        "sessions, and events on disk.",
    )
    .option(
      "--strict",
      "fail fast on the first unreadable ticket file instead of skipping it and rebuilding the rest (pre-fault-tolerance behavior)",
    )
    .action(runReindex);
}
