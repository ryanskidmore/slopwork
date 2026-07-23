import type { Command } from "commander";
import { isTicketId } from "../../core/index.js";
import {
  listSessions,
  listTickets,
  loadIndex,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
} from "../../repo/index.js";
import type { RepoPaths } from "../../repo/index.js";
import { budgetCharsFromTokens, renderContextPack } from "../../tickets/context.js";
import type { ContextPackData } from "../../tickets/context.js";
import { formatTicketDetail } from "../../tickets/detail.js";
import { jiraBrowseUrl } from "../../tickets/jira.js";
import { buildTree, renderTreeLines } from "../../tickets/tree.js";
import { loadConfig } from "../actor.js";
import { parseIntegerOption } from "./shared.js";

interface ShowCommandOptions {
  context?: boolean;
  tree?: boolean;
  budget?: number;
}

async function printTree(paths: RepoPaths, ticketId: string): Promise<void> {
  const all = await listTickets(paths);
  const ticket = all.find((t) => t.id === ticketId);
  if (!ticket) return; // unreachable in practice: resolveTicketRef already found it
  const root = all.find((t) => t.id === ticket.root_id) ?? ticket;
  const tree = buildTree(root.id, all);
  const config = await loadConfig(paths);
  const externalParentRef =
    root.parent !== undefined && !isTicketId(root.parent) ? root.parent : undefined;
  const jiraUrl = externalParentRef !== undefined ? jiraBrowseUrl(config, externalParentRef) : null;
  const lines = renderTreeLines(tree, ticket.id, externalParentRef, jiraUrl);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function runShow(ref: string, opts: ShowCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);

  const ticket = await resolveTicketRef(paths, ref);

  let printedSomething = false;

  if (opts.tree) {
    await printTree(paths, ticket.id);
    printedSomething = true;
  }

  if (opts.context) {
    const allTickets = await listTickets(paths);
    const byId = new Map(allTickets.map((t) => [t.id, t] as const));

    const ancestors = ticket.path
      .map((id) => byId.get(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined);
    const rootTicket = byId.get(ticket.root_id);
    const externalParentRef =
      rootTicket?.parent !== undefined && !isTicketId(rootTicket.parent)
        ? rootTicket.parent
        : undefined;

    const { index } = await loadIndex(paths);
    const row = index.tickets.find((r) => r.id === ticket.id);
    const blockedByIds = row?.blocked_by ?? [];
    const blockers = blockedByIds
      .map((id) => byId.get(id))
      .filter(
        (t): t is NonNullable<typeof t> =>
          t !== undefined && t.state !== "done" && t.state !== "dropped",
      );

    const sessions = (await listSessions(paths))
      .filter((s) => s.ticket === ticket.id)
      .sort((a, b) => b.started_at.localeCompare(a.started_at));

    const data: ContextPackData = {
      ticket,
      config,
      ancestors,
      externalParentRef,
      blockers,
      sessions,
    };
    const budgetChars = opts.budget !== undefined ? budgetCharsFromTokens(opts.budget) : undefined;
    process.stdout.write(`${renderContextPack(data, budgetChars)}\n`);
    printedSomething = true;
  }

  if (!printedSomething) {
    process.stdout.write(`${formatTicketDetail(ticket, config)}\n`);
  }
}

/** `slop show` — design.md §4.2; work item B1. */
export function registerShowCommand(program: Command): void {
  program
    .command("show")
    .description("Show a ticket's details: spec, state, edges, sessions, and history.")
    .argument("<ref>", "ticket to show")
    .option("--context", "include the full context pack")
    .option("--tree", "render the ticket's ancestry/descendant tree")
    .option(
      "--budget <n>",
      "cap --context output to roughly N tokens (B1's cheap version; E1 generalises this)",
      parseIntegerOption("--budget"),
    )
    .action(runShow);
}
