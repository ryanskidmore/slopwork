/**
 * `GET /api/questions` — the elicitations inbox (G4, t-jggg9): every
 * unanswered question across the project, oldest first, grouped by ticket
 * (mirrors `/api/review`'s shape/rationale — a human triaging questions
 * wants the same "who's waited longest" ordering a reviewer wants for
 * MRs). See `src/cli/commands/questions.ts` for the CLI's identical
 * derivation (`src/tickets/questions.ts`'s `deriveQuestions`/
 * `groupQuestionsByTicket`) — same one-implementation discipline as every
 * other overlay/derivation shared between the CLI and this web package.
 *
 * Bounded the same `page`/`limit` way `GET /api/tickets` is (paginating
 * the flat, already oldest-first `Question` list BEFORE grouping — see
 * `pagination.ts`'s doc) — `total_questions`/`total_tickets` stay
 * whole-inbox counts, same "total vs. this page" split `GET /api/tickets`
 * makes with `total`/`pagination.filtered_total`.
 */
import type { BunRequest } from "bun";
import type { Ticket, TicketId } from "../../core/index.js";
import {
  deriveQuestions,
  groupQuestionsByTicket,
  unansweredQuestions,
} from "../../tickets/questions.js";
import type { WebDataSource } from "../data-source.js";
import { configDto, jsonResponse, questionGroupDto } from "./shared.js";
import type { QuestionsResponseDTO } from "./types.js";
import { paginate, parsePage } from "./pagination.js";

export async function handleQuestionsPanel(
  req: BunRequest,
  dataSource: WebDataSource,
): Promise<Response> {
  const pageInput = parsePage(new URL(req.url));
  if (pageInput instanceof Response) return pageInput;
  const [tickets, { config, warning }, eventResult] = await Promise.all([
    dataSource.listTickets(),
    dataSource.getConfig(),
    dataSource.listEvents(),
  ]);
  const byId = new Map<TicketId, Ticket>(tickets.map((t) => [t.id, t]));

  // deriveQuestions already sorts oldest-asked-first by (unique) event id —
  // no additional tiebreak needed before paginating.
  const open = unansweredQuestions(deriveQuestions(eventResult.events));
  const totalTickets = new Set(open.map((question) => question.ticketId)).size;
  const page = paginate(open, pageInput);
  const groups = groupQuestionsByTicket(page.items);

  const body: QuestionsResponseDTO = {
    config: configDto(config, warning, eventResult.problems),
    // A question's own ticket should always resolve (tickets are never
    // deleted, only dropped/done) — a group whose ticket somehow can't be
    // found (a corrupt/unreadable ticket file) is skipped rather than
    // surfaced with a dangling ref, same fault-tolerance posture
    // `src/cli/commands/questions.ts`'s `loadTicketsFor` applies.
    groups: groups.flatMap((g) => {
      const ticket = byId.get(g.ticketId);
      return ticket ? [questionGroupDto(ticket, g.questions)] : [];
    }),
    total_questions: open.length,
    total_tickets: totalTickets,
    pagination: page.pagination,
  };
  return jsonResponse(body);
}
