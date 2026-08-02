/**
 * Assembling {@link ContextPackData} (`src/tickets/context.ts`, B1) for
 * `slop start`/`slop context` (C1) — the exact same shape `slop show
 * --context` already renders, factored out here so both of C1's commands
 * share one implementation instead of duplicating `show.ts`'s inline
 * data-gathering (that file is B1's and off limits to edit — see the C1
 * brief's ground rules — and its logic isn't exported, so this is a
 * deliberate, small, parallel construction, not a refactor of it).
 *
 * **Fault tolerance (ticket_01KY93E32PXJW76FA9CXYAA0B7):** `start`
 * prints this pack *after* its `withLock` mutation has already committed
 * (session created, ticket -> in_progress). A corrupt/unreadable file
 * ANYWHERE else in the db — an unrelated ticket, an unrelated session —
 * must never be able to turn that already-successful `start` into a
 * thrown error and a non-zero exit; a retry would then hit
 * `activeSessionConflict` on the very session it just started. So, unlike
 * a direct-by-id read, every read this module does is tolerant: unreadable
 * tickets go through `backend.listTicketsTolerant()` (the same fail-soft
 * path the index auto-heal already uses — adversarial-review Finding 3),
 * and unreadable sessions go through `backend.listSessionsTolerant()`.
 * Either way, a bad file elsewhere is skipped and warned about on stderr,
 * never thrown.
 */
import type { Config, Ticket } from "../core/index.js";
import { isTicketId } from "../core/index.js";
import { formatIndexProblems } from "../storage/backend.js";
import type { SessionReadProblem, StorageBackend } from "../storage/backend.js";
import type { ContextPackData } from "../tickets/context.js";

function formatSessionProblems(problems: SessionReadProblem[]): string {
  const header = `${problems.length} session file(s) could not be read and were skipped while building the context pack:`;
  const body = problems.map((p) => {
    const indented = p.message
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    return `  - ${p.path}\n${indented}`;
  });
  return [header, ...body].join("\n");
}

export async function buildContextPackData(
  backend: StorageBackend,
  ticket: Ticket,
  config: Config,
): Promise<ContextPackData> {
  const { tickets: allTickets, problems: ticketProblems } = await backend.listTicketsTolerant();
  if (ticketProblems.length > 0) {
    process.stderr.write(`warning: ${formatIndexProblems(ticketProblems)}\n`);
  }
  const byId = new Map(allTickets.map((t) => [t.id, t] as const));

  const ancestors = ticket.path
    .map((id) => byId.get(id))
    .filter((t): t is Ticket => t !== undefined);
  const rootTicket = byId.get(ticket.root_id);
  const externalParentRef =
    rootTicket?.parent !== undefined && !isTicketId(rootTicket.parent)
      ? rootTicket.parent
      : undefined;

  const { index } = await backend.loadIndex();
  const row = index.tickets.find((r) => r.id === ticket.id);
  const blockedByIds = row?.blocked_by ?? [];
  const blockers = blockedByIds
    .map((id) => byId.get(id))
    .filter((t): t is Ticket => t !== undefined && t.state !== "done" && t.state !== "dropped");

  const { sessions: allSessions, problems: sessionProblems } = await backend.listSessionsTolerant();
  if (sessionProblems.length > 0) {
    process.stderr.write(`warning: ${formatSessionProblems(sessionProblems)}\n`);
  }
  const sessions = allSessions
    .filter((s) => s.ticket === ticket.id)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));

  return { ticket, config, ancestors, externalParentRef, blockers, sessions };
}
