import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop events` — design.md §3, §4.2; work item D3. */
export function registerEventsCommand(program: Command): void {
  program
    .command("events")
    .description("List immutable events, optionally since a cursor or scoped to a ticket.")
    .option("--since <event_id>", "only events after this event id (cursor)")
    .option("--ticket <ref>", "only events for this ticket")
    .option("--json", "machine-readable output")
    .action(() => notImplemented("events", "D3"));
}
