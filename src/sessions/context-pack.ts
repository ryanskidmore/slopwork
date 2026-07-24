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
 * tickets go through `listTicketsTolerant` (repo/tickets.ts, the same
 * fail-soft path the index auto-heal already uses — adversarial-review
 * Finding 3), and unreadable sessions go through this module's own
 * `listSessionsTolerant` below (sessions.ts has no such helper and is out
 * of this ticket's edit scope, so it's a small, local, parallel
 * construction of the exact same pattern — see `listTicketsTolerant`'s
 * doc). Either way, a bad file elsewhere is skipped and warned about on
 * stderr, never thrown.
 */
import type { Config, Session, SessionId, Ticket } from "../core/index.js";
import { isTicketId } from "../core/index.js";
import {
  formatIndexProblems,
  listSessionIds,
  listTicketsTolerant,
  loadIndex,
  readSession,
  sessionFilePath,
} from "../repo/index.js";
import type { RepoPaths } from "../repo/index.js";
import type { ContextPackData } from "../tickets/context.js";

/** The sessions.ts analogue of db-index.ts's `TicketReadProblem` — one
 * session file `listSessionsTolerant` could not read, captured instead of
 * thrown. */
interface SessionReadProblem {
  id: SessionId;
  path: string;
  message: string;
}

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

/**
 * Like {@link listSessions} (repo/sessions.ts), but never throws on a bad
 * file: every session that reads and validates cleanly goes in
 * `sessions`, every one that doesn't goes in `problems` instead, carrying
 * the exact same error `readSession` would have thrown — just captured
 * rather than propagated. See this module's doc for why this exists
 * (mirrors `listTicketsTolerant`, repo/tickets.ts).
 */
async function listSessionsTolerant(
  paths: RepoPaths,
): Promise<{ sessions: Session[]; problems: SessionReadProblem[] }> {
  const ids = await listSessionIds(paths);
  const settled = await Promise.allSettled(ids.map((id) => readSession(paths, id)));

  const sessions: Session[] = [];
  const problems: SessionReadProblem[] = [];
  for (let i = 0; i < settled.length; i++) {
    const id = ids[i];
    const outcome = settled[i];
    if (id === undefined || outcome === undefined) continue; // unreachable: settled/ids are the same length
    if (outcome.status === "fulfilled") {
      sessions.push(outcome.value);
    } else {
      const message =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      problems.push({ id, path: sessionFilePath(paths, id), message });
    }
  }
  return { sessions, problems };
}

export async function buildContextPackData(
  paths: RepoPaths,
  ticket: Ticket,
  config: Config,
): Promise<ContextPackData> {
  const { tickets: allTickets, problems: ticketProblems } = await listTicketsTolerant(paths);
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

  const { index } = await loadIndex(paths);
  const row = index.tickets.find((r) => r.id === ticket.id);
  const blockedByIds = row?.blocked_by ?? [];
  const blockers = blockedByIds
    .map((id) => byId.get(id))
    .filter((t): t is Ticket => t !== undefined && t.state !== "done" && t.state !== "dropped");

  const { sessions: allSessions, problems: sessionProblems } = await listSessionsTolerant(paths);
  if (sessionProblems.length > 0) {
    process.stderr.write(`warning: ${formatSessionProblems(sessionProblems)}\n`);
  }
  const sessions = allSessions
    .filter((s) => s.ticket === ticket.id)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));

  return { ticket, config, ancestors, externalParentRef, blockers, sessions };
}
