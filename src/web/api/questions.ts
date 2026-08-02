/**
 * `GET /api/questions` — the elicitations inbox (G4, t-jggg9): every
 * unanswered question across the project, oldest first, grouped by ticket
 * (mirrors `/api/review`'s shape/rationale — a human triaging questions
 * wants the same "who's waited longest" ordering a reviewer wants for
 * MRs). See `src/cli/commands/questions.ts` for the CLI's identical
 * derivation (`src/tickets/questions.ts`'s `deriveQuestions`/
 * `groupQuestionsByTicket`) — same one-implementation discipline as every
 * other overlay/derivation shared between the CLI and this web package.
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

export async function handleQuestionsPanel(
  _req: BunRequest,
  dataSource: WebDataSource,
): Promise<Response> {
  const [tickets, { config, warning }, events] = await Promise.all([
    dataSource.listTickets(),
    dataSource.getConfig(),
    dataSource.listEvents(),
  ]);
  const byId = new Map<TicketId, Ticket>(tickets.map((t) => [t.id, t]));

  const open = unansweredQuestions(deriveQuestions(events));
  const groups = groupQuestionsByTicket(open);

  const body: QuestionsResponseDTO = {
    config: configDto(config, warning),
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
  };
  return jsonResponse(body);
}
