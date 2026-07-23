import type { Command } from "commander";
import { notImplemented } from "../errors.js";
import { parseIntegerOption } from "./shared.js";

/** `slop web` — design.md §4.4; work item D5. */
export function registerWebCommand(program: Command): void {
  program
    .command("web")
    .description(
      "Serve the read-only local web explorer: ticket list/filters, tree view, " +
        "ticket detail, transcript viewer, review panel, stale panel.",
    )
    .option("--port <n>", "port to listen on", parseIntegerOption("--port"), 4553)
    .action(() => notImplemented("web", "D5"));
}
