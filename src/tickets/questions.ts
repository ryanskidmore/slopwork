/**
 * Elicitations (G4, t-jggg9) — pure derivation over `question.asked`/
 * `question.answered` events (`src/core/entities/event.ts`'s EVENT_VERBS
 * doc). No I/O anywhere in this file, same "pure core, thin CLI/web shell"
 * split every other `src/tickets/*.ts` module follows (`ready.ts`,
 * `status.ts`, `list.ts`, `overlay.ts`).
 *
 * Design constraint (coordinator decision): questions are events, not a
 * new stored entity — a `Question` here is always FOLDED from the event
 * log, never itself persisted. A question is identified by its
 * `question.asked` event's own id; an answer references it by
 * `payload.question_id`. This module is the ONE place that fold happens —
 * `src/tickets/overlay.ts`'s `computeAwaitingInputOverlay`/
 * `computeAwaitingInputByTicket` (the shared CLI+web `awaiting_input`
 * overlay), `slop ask`/`slop answer`/`slop questions`
 * (`src/cli/commands/*.ts`), `slop show`'s "open questions" section, and
 * the web `/api/questions` panel + ticket-detail overlay all consume
 * {@link deriveQuestions} rather than re-deriving the fold independently.
 */
import type { Actor, Event, EventId, TicketId } from "../core/index.js";
import { idMatchesRef, isTicketId } from "../core/index.js";

/** A `question.answered` event, folded onto the `Question` it answers. */
export interface QuestionAnswer {
  /** The `question.answered` event's own id. */
  id: EventId;
  by: Actor;
  text: string;
  /** ISO timestamp — the answer event's own `at`. */
  at: string;
}

/** One `question.asked` event, folded together with its answer (if any). */
export interface Question {
  /** The `question.asked` event's own id — what `slop answer <question-id>` and `payload.question_id` reference. */
  id: EventId;
  ticketId: TicketId;
  askedBy: Actor;
  /** ISO timestamp — the ask event's own `at`. */
  askedAt: string;
  text: string;
  /** Multiple-choice options, `[]` when none were given (`--option`, repeatable). */
  options: string[];
  /** `null` iff still open (unanswered). */
  answer: QuestionAnswer | null;
}

/** Free-text/multiple-choice question length caps — enforced at the CLI
 * layer (`assertMaxLength`, `src/cli/commands/shared.ts`), same convention
 * as `--note`/`--reason`/`--outcome`'s caps (`ticket.ts`/`session.ts`).
 * Event payloads have no zod schema of their own to attach a `.max()` to
 * (`eventSchema.payload` is deliberately open-ended — event.ts), so these
 * live here instead, next to the domain they bound. */
export const QUESTION_TEXT_MAX_LENGTH = 10_000;
export const QUESTION_OPTION_MAX_LENGTH = 500;
export const ANSWER_TEXT_MAX_LENGTH = 10_000;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Fold every `question.asked`/`question.answered` event in `events` into
 * `Question` records, sorted oldest-asked-first (ascending by the
 * question's own id — ULIDs sort chronologically, same convention every
 * other cursor-ordered listing in this codebase relies on).
 *
 * `events` may span the WHOLE db (the `slop questions` inbox, the web
 * `/api/questions` panel) or be pre-scoped to one ticket (the
 * `awaiting_input` overlay, `slop show`'s open-questions section) — this
 * function doesn't care either way; it groups purely by each event's own
 * ids, never by `entity.id`, so scope is entirely the caller's choice.
 *
 * Multiple `question.answered` events naming the same `question_id`
 * should never happen in practice — `slop answer` rejects answering an
 * already-answered question as a CONFLICT (exit 6), under the storage
 * backend's transaction lock, before a second one is ever emitted. This
 * fold is defensive anyway: the EARLIEST answer (by event id) wins, so a
 * hand-edited or corrupted db degrades to "the first answer stands"
 * rather than flip-flopping between reads depending on event order.
 *
 * A `question.answered` event whose `payload.question_id` doesn't match
 * any `question.asked` event IN THIS `events` SET is silently dropped —
 * either a dangling/malformed payload, or (the ordinary, expected case
 * when `events` is ticket-scoped) the question and its answer are both
 * ticket-scoped to the SAME ticket by construction, so this only bites a
 * caller that scoped `events` incorrectly.
 */
export function deriveQuestions(events: readonly Event[]): Question[] {
  const byId = new Map<string, Question>();

  for (const event of events) {
    if (event.verb !== "question.asked") continue;
    if (event.entity.kind !== "ticket" || !isTicketId(event.entity.id)) continue;
    const text = typeof event.payload.text === "string" ? event.payload.text : "";
    const options = isStringArray(event.payload.options) ? event.payload.options : [];
    byId.set(event.id, {
      id: event.id,
      ticketId: event.entity.id,
      askedBy: event.actor,
      askedAt: event.at,
      text,
      options,
      answer: null,
    });
  }

  for (const event of events) {
    if (event.verb !== "question.answered") continue;
    const questionId = event.payload.question_id;
    if (typeof questionId !== "string") continue;
    const question = byId.get(questionId);
    if (!question) continue; // dangling reference — see module doc.
    if (question.answer !== null && question.answer.id <= event.id) continue; // earliest wins.
    const text = typeof event.payload.text === "string" ? event.payload.text : "";
    question.answer = { id: event.id, by: event.actor, text, at: event.at };
  }

  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function isAnswered(question: Question): boolean {
  return question.answer !== null;
}

/** Still-open questions, in the same (oldest-first) order `deriveQuestions` already returns. */
export function unansweredQuestions(questions: readonly Question[]): Question[] {
  return questions.filter((q) => !isAnswered(q));
}

/**
 * Resolve `ref` (a full `question.asked` event id, or a unique short
 * prefix — the same `idMatchesRef` rule ticket/session/event ids already
 * share, core/ids.ts) against `questions`. Returns every match: 0 (not
 * found), 1 (resolved), or >1 (ambiguous) — the caller (`slop answer`,
 * `src/cli/commands/answer.ts`) turns that into NOT_FOUND (4)/
 * AMBIGUOUS_REF (5)/ok, exactly like ticket ref resolution.
 */
export function matchQuestionsByRef(questions: readonly Question[], ref: string): Question[] {
  return questions.filter((q) => idMatchesRef(q.id, ref));
}

/** One ticket's group of questions for the `slop questions`/`/api/questions`
 * inbox — `questions` oldest-first (mirrors `deriveQuestions`'s own order). */
export interface QuestionGroup {
  ticketId: TicketId;
  questions: Question[];
}

/**
 * Group `questions` by ticket — groups ordered by their OLDEST question
 * (the ticket that's been waiting longest sorts first, same
 * longest-waiting-first convention `tickets/status.ts`'s `sortReviewRows`
 * uses for the awaiting-review section); each group's own `questions`
 * stays oldest-first. `questions` need not be pre-sorted — this function
 * sorts independently at both levels, so it's safe to call on an
 * already-filtered (e.g. unanswered-only) subset in any order.
 */
export function groupQuestionsByTicket(questions: readonly Question[]): QuestionGroup[] {
  const byTicket = new Map<TicketId, Question[]>();
  for (const q of questions) {
    const list = byTicket.get(q.ticketId);
    if (list) list.push(q);
    else byTicket.set(q.ticketId, [q]);
  }
  const groups: QuestionGroup[] = [...byTicket.entries()].map(([ticketId, qs]) => ({
    ticketId,
    questions: [...qs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }));
  groups.sort((a, b) => {
    const aFirst = a.questions[0]?.id ?? "";
    const bFirst = b.questions[0]?.id ?? "";
    return aFirst < bFirst ? -1 : aFirst > bFirst ? 1 : 0;
  });
  return groups;
}
