import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop reindex` — design.md §3, D3, D14; work item A3. */
export function registerReindexCommand(program: Command): void {
  program
    .command("reindex")
    .description(
      "Rebuild the derived, gitignored .slop/db/index.jsonc from the tickets, " +
        "sessions, and events on disk.",
    )
    .action(() => notImplemented("reindex", "A3"));
}
