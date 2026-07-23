import type { Command } from "commander";
import { repoPaths, requireRepoRoot, rebuildIndex, sweepStaleTempFiles } from "../../repo/index.js";

/** `slop reindex` — design.md §3, D3, D14; work item A3. */
export function registerReindexCommand(program: Command): void {
  program
    .command("reindex")
    .description(
      "Rebuild the derived, gitignored .slop/db/index.jsonc from the tickets, " +
        "sessions, and events on disk.",
    )
    .action(async () => {
      const root = requireRepoRoot(process.cwd());
      const paths = repoPaths(root);

      const index = await rebuildIndex(paths);

      const swept = await sweepStaleTempFiles([
        paths.dbDir,
        paths.ticketsDir,
        paths.sessionsDir,
        paths.eventsDir,
      ]);

      const slugCount = Object.keys(index.slugs).length;
      const sweptNote = swept.length > 0 ? `; swept ${swept.length} stale temp file(s)` : "";
      process.stdout.write(
        `reindexed: ${index.tickets.length} ticket(s), ${slugCount} slug(s)${sweptNote}\n`,
      );
    });
}
