/**
 * `slop answer <question-id> "<answer>"` (G4, t-jggg9) — records a
 * `question.answered` event referencing the question it closes. Once
 * answered, the question no longer counts toward its ticket's
 * `awaiting_input` overlay (`src/tickets/overlay.ts`'s
 * `computeAwaitingInputOverlay`) or `slop questions`' default (unanswered
 * -only) listing.
 *
 * `<question-id>` accepts the same ref forms every other id in this CLI
 * does: a full `event_<ULID>` id, or a unique short prefix (design
 * constraint: "accept unique short prefixes wherever a question id is
 * taken" — `src/tickets/questions.ts`'s `matchQuestionsByRef`, the same
 * `idMatchesRef` rule ticket/session/event ids already share). Resolution
 * scans every `question.asked` event in the db (there is no per-verb
 * index today — see this ticket's report for the follow-up this leaves).
 *
 * Idempotence: answering an already-answered question is a CONFLICT
 * (exit 6), never a second `question.answered` event for the same
 * `question_id`. A fast, unlocked check runs first (mirrors
 * `review.ts`'s `initialCheck` pattern) so an obviously-doomed call fails
 * quickly; the AUTHORITATIVE check re-reads the question's own ticket's
 * events under `backend.transact`'s exclusive write scope immediately
 * before appending, closing the race between two concurrent `answer`
 * calls on the SAME question (each individually passing the unlocked
 * check) that would otherwise both succeed.
 */
import type { Command } from "commander";
import type { Actor } from "../../core/index.js";
import { EXIT_CODES, shortTicketCode, ticketEventContext } from "../../core/index.js";
import { repoPaths, requireRepoRoot } from "../../repo/index.js";
import { openStorage, warnAboutEventReadProblems } from "../../storage/index.js";
import type { Question } from "../../tickets/questions.js";
import {
  ANSWER_TEXT_MAX_LENGTH,
  deriveQuestions,
  matchQuestionsByRef,
} from "../../tickets/questions.js";
import { loadConfig, resolveActor } from "../actor.js";
import { SlopError } from "../errors.js";
import { assertMaxLength } from "./shared.js";

interface AnswerCommandOptions {
  json?: boolean;
}

function ambiguousQuestionMessage(ref: string, candidates: readonly Question[]): string {
  const lines = candidates
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((q) => `hint:   ${q.id}  "${q.text}"`);
  return [`short ref "${ref}" is ambiguous`, "hint: the candidates are:", ...lines].join("\n");
}

function alreadyAnsweredMessage(question: Question): string {
  const answer = question.answer;
  if (!answer) return `question ${question.id} was already answered`; // unreachable in practice
  return (
    `question ${question.id} was already answered by ${answer.by.name} at ${answer.at}: ` +
    `"${answer.text}"`
  );
}

export async function runAnswer(
  questionRef: string,
  answerText: string,
  opts: AnswerCommandOptions,
): Promise<void> {
  const trimmed = answerText.trim();
  if (trimmed.length === 0) {
    throw new SlopError("<answer> must not be empty", EXIT_CODES.USAGE_ERROR);
  }
  assertMaxLength("<answer>", answerText, ANSWER_TEXT_MAX_LENGTH);

  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor: Actor = resolveActor({ config, cwd: root });
  const backend = await openStorage(paths);

  // Unlocked, whole-db scan to resolve <question-id> — same rationale as
  // `review.ts`'s "fast pre-check" doc: fails fast on NOT_FOUND/
  // AMBIGUOUS_REF/an already-answered question without ever touching the
  // write lock, while the authoritative recheck below (scoped to just
  // this question's own ticket) is what actually guards the double
  // -answer race.
  const { events: allEvents, problems: eventProblems } = await backend.listEventsTolerant();
  if (eventProblems.length > 0) {
    warnAboutEventReadProblems(eventProblems);
    throw new SlopError(
      "cannot answer safely while event files are unreadable; repair them and run `slop reindex`",
      EXIT_CODES.GENERIC_ERROR,
    );
  }
  const allQuestions = deriveQuestions(allEvents);
  const candidates = matchQuestionsByRef(allQuestions, questionRef);
  if (candidates.length === 0) {
    throw new SlopError(`no question found for ref "${questionRef}"`, EXIT_CODES.NOT_FOUND);
  }
  if (candidates.length > 1) {
    throw new SlopError(
      ambiguousQuestionMessage(questionRef, candidates),
      EXIT_CODES.AMBIGUOUS_REF,
    );
  }
  const initial = candidates[0];
  if (!initial)
    throw new SlopError(`no question found for ref "${questionRef}"`, EXIT_CODES.NOT_FOUND); // unreachable
  if (initial.answer !== null) {
    throw new SlopError(alreadyAnsweredMessage(initial), EXIT_CODES.CONFLICT);
  }

  const { event, ticket } = await backend.transact(async () => {
    const ticketEvents = await backend.queryEvents({ ticket: initial.ticketId });
    const fresh = deriveQuestions(ticketEvents).find((q) => q.id === initial.id);
    if (!fresh) {
      // Unreachable in practice: events are immutable/append-only, so a
      // question.asked event visible to the outer scan can't disappear —
      // guarded anyway rather than asserting, per this codebase's
      // "defensive, never silently wrong" convention.
      throw new SlopError(`question ${initial.id} no longer exists`, EXIT_CODES.NOT_FOUND);
    }
    if (fresh.answer !== null) {
      throw new SlopError(alreadyAnsweredMessage(fresh), EXIT_CODES.CONFLICT);
    }
    // The question can outlive the session that asked it. Attribute the
    // answer to the ticket's current session at answer time, read fresh
    // inside the same transaction as the duplicate-answer check.
    const ticket = await backend.readTicket(initial.ticketId);
    const event = await backend.appendEvent(
      ticketEventContext(actor, ticket),
      { kind: "ticket", id: initial.ticketId },
      { verb: "question.answered", payload: { question_id: initial.id, text: trimmed } },
    );
    return { event, ticket };
  });

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          question_id: initial.id,
          ticket: {
            id: ticket.id,
            slug: ticket.slug,
            handle: shortTicketCode(ticket.id),
            name: ticket.name,
            state: ticket.state,
          },
          answer: {
            id: event.id,
            text: trimmed,
            by: event.actor,
            answered_at: event.at,
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(
    `answered ${initial.id}  on ${ticket.id} (${ticket.slug})\n` +
      `  question: "${initial.text}"\n` +
      `  answer:   "${trimmed}"\n`,
  );
}

/** `slop answer` — G4 (t-jggg9): closes a question `slop ask` opened. */
export function registerAnswerCommand(program: Command): void {
  program
    .command("answer")
    .description(
      "Answer a question opened by `slop ask` (question.answered event). Answering an " +
        "already-answered question is a CONFLICT (exit 6).",
    )
    .argument("<question-id>", "full question.asked event id, or a unique short prefix")
    .argument("<answer>", "the answer text")
    .option("--json", "machine-readable result (question_id, ticket, answer)")
    .action(runAnswer);
}
