import type { Command } from "commander";
import { notImplemented } from "../errors.js";
import { collect, parsePriority } from "./shared.js";

/** `slop new` — design.md §4.2; work item B1. */
export function registerNewCommand(program: Command): void {
  program
    .command("new")
    .description('Create a new ticket, e.g. slop new "Adding new auth provider".')
    .argument("<name>", "short ticket name")
    .option("--spec <json>", 'ticket spec as JSON; pass "-" to read from stdin')
    .option("--parent <ref>", "parent ticket ref, slug, or external ref (e.g. jira:PROJ-123)")
    .option(
      "--blocks <ref>",
      "ref of a ticket this one blocks (repeatable)",
      collect,
      [] as string[],
    )
    .option("--discovered-from <ref>", "ref of the ticket this work was discovered while doing")
    .option("--label <key:value>", "label in key:value form (repeatable)", collect, [] as string[])
    .option("--draft", "create in draft state (drafts never appear in `ready`)")
    .option("--adhoc", "mark as created outside normal planning")
    .option("--owner <actor>", "owning actor (roots require a human owner, D1)")
    .option("--priority <0-3>", "priority: 0 urgent .. 3 low, default 2", parsePriority)
    .action(() => notImplemented("new", "B1"));
}
