/**
 * Assembling {@link ContextPackData} (`src/tickets/context.ts`, B1) for
 * `slop start`/`slop context` (C1) — the exact same shape `slop show
 * --context` already renders, factored out here so both of C1's commands
 * share one implementation instead of duplicating `show.ts`'s inline
 * data-gathering (that file is B1's and off limits to edit — see the C1
 * brief's ground rules — and its logic isn't exported, so this is a
 * deliberate, small, parallel construction, not a refactor of it).
 */
import { isTicketId } from "../core/index.js";
import type { Config, Ticket } from "../core/index.js";
import { listSessions, listTickets, loadIndex } from "../repo/index.js";
import type { RepoPaths } from "../repo/index.js";
import type { ContextPackData } from "../tickets/context.js";

export async function buildContextPackData(
  paths: RepoPaths,
  ticket: Ticket,
  config: Config,
): Promise<ContextPackData> {
  const allTickets = await listTickets(paths);
  const byId = new Map(allTickets.map((t) => [t.id, t] as const));

  const ancestors = ticket.path
    .map((id) => byId.get(id))
    .filter((t): t is Ticket => t !== undefined);
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
    .filter((t): t is Ticket => t !== undefined && t.state !== "done" && t.state !== "dropped");

  const sessions = (await listSessions(paths))
    .filter((s) => s.ticket === ticket.id)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));

  return { ticket, config, ancestors, externalParentRef, blockers, sessions };
}
