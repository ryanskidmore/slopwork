/**
 * `slop questions` (G4, t-jggg9) — the elicitations inbox: every question
 * a `slop ask` opened, default unanswered-only, oldest first, grouped by
 * ticket (the ticket whose oldest open question has waited longest sorts
 * first — same longest-waiting-first convention `tickets/status.ts`'s
 * awaiting-review section already uses). `--all` includes answered
 * questions too; `--ticket <ref>` scopes to one ticket (a bounded
 * `queryEvents({ticket})` read instead of a whole-db scan).
 *
 * `--budget` elides whole QUESTIONS (not whole groups) from the tail of
 * the flattened, already-ordered list, then re-groups whatever survives —
 * same "flatten in elision-priority order, re-render a kept prefix" shape
 * `tickets/ready.ts`'s `buildReadyEntries`/`renderReadyWithBudget` use.
 */
import type { Command } from "commander";
import type { Actor, Ticket, TicketId } from "../../core/index.js";
import { renderEntriesWithBudget, shortTicketCode } from "../../core/index.js";
import type { RenderFormat } from "../../core/index.js";
import { repoPaths, requireRepoRoot } from "../../repo/index.js";
import { CONTEXT_PACK_BUDGET_UNIT } from "../../sessions/context-budget.js";
import type { StorageBackend } from "../../storage/index.js";
import { openStorage } from "../../storage/index.js";
import type { Question } from "../../tickets/questions.js";
import {
  deriveQuestions,
  groupQuestionsByTicket,
  unansweredQuestions,
} from "../../tickets/questions.js";
import { parseBudgetOption } from "./shared.js";

interface QuestionsCommandOptions {
  all?: boolean;
  ticket?: string;
  json?: boolean;
  budget?: number;
}

interface TicketRefLite {
  id: TicketId;
  slug: string;
  handle: string;
  name: string;
  state: string;
}

function ticketRefLite(ticket: Ticket): TicketRefLite {
  return {
    id: ticket.id,
    slug: ticket.slug,
    handle: shortTicketCode(ticket.id),
    name: ticket.name,
    state: ticket.state,
  };
}

/** Gather the questions to consider (unanswered-only, or `--all`), scoped
 * to `--ticket` when given — a bounded per-ticket read instead of the
 * whole event log. */
async function gatherQuestions(
  backend: StorageBackend,
  opts: QuestionsCommandOptions,
): Promise<Question[]> {
  const events =
    opts.ticket !== undefined
      ? await backend.queryEvents({ ticket: (await backend.resolveTicketRef(opts.ticket)).id })
      : await backend.listEventsTolerant();
  const all = deriveQuestions(events);
  return opts.all ? all : unansweredQuestions(all);
}

/** Every ticket a group of `questions` names, fault-tolerantly — a
 * ticket file that can't be read degrades that group's `ticket` to
 * `null` (rendered as a dangling reference) rather than crashing the
 * whole listing. */
async function loadTicketsFor(
  backend: StorageBackend,
  ticketIds: readonly TicketId[],
): Promise<Map<TicketId, Ticket>> {
  const byId = new Map<TicketId, Ticket>();
  await Promise.all(
    ticketIds.map(async (id) => {
      try {
        byId.set(id, await backend.readTicket(id));
      } catch (err) {
        process.stderr.write(
          `warning: could not read ticket ${id} for the questions inbox: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }),
  );
  return byId;
}

interface QuestionJsonRow {
  id: string;
  text: string;
  options: string[];
  asked_by: Actor;
  asked_at: string;
  answer: { id: string; text: string; by: Actor; answered_at: string } | null;
}

function questionJsonRow(q: Question): QuestionJsonRow {
  return {
    id: q.id,
    text: q.text,
    options: q.options,
    asked_by: q.askedBy,
    asked_at: q.askedAt,
    answer: q.answer
      ? { id: q.answer.id, text: q.answer.text, by: q.answer.by, answered_at: q.answer.at }
      : null,
  };
}

function buildJson(
  questions: readonly Question[],
  ticketsById: ReadonlyMap<TicketId, Ticket>,
  showAll: boolean,
  elisions: readonly string[],
): string {
  const groups = groupQuestionsByTicket(questions).map((g) => {
    const ticket = ticketsById.get(g.ticketId);
    return {
      ticket: ticket ? ticketRefLite(ticket) : { id: g.ticketId },
      questions: g.questions.map(questionJsonRow),
    };
  });
  const body = {
    groups,
    total_questions: questions.length,
    total_tickets: groups.length,
    all: showAll,
    elided: elisions,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function buildText(
  questions: readonly Question[],
  ticketsById: ReadonlyMap<TicketId, Ticket>,
  showAll: boolean,
  elisions: readonly string[],
): string {
  const groups = groupQuestionsByTicket(questions);
  const openCount = questions.filter((q) => q.answer === null).length;
  const lines: string[] = [
    showAll
      ? `${questions.length} question(s) across ${groups.length} ticket(s) (${openCount} unanswered):`
      : `${questions.length} unanswered question(s) across ${groups.length} ticket(s):`,
  ];
  if (groups.length === 0) {
    lines.push("  (none)");
  }
  for (const group of groups) {
    const ticket = ticketsById.get(group.ticketId);
    const header = ticket
      ? `  ${ticket.id} (${ticket.slug})  "${ticket.name}"`
      : `  ${group.ticketId} (ticket no longer readable)`;
    lines.push("");
    lines.push(header);
    for (const q of group.questions) {
      lines.push(`    [${q.id}] asked by ${q.askedBy.name} (${q.askedBy.kind}), ${q.askedAt}:`);
      lines.push(`      "${q.text}"`);
      if (q.options.length > 0) lines.push(`      options: ${q.options.join(", ")}`);
      if (q.answer) {
        lines.push(`      answered by ${q.answer.by.name} at ${q.answer.at}: "${q.answer.text}"`);
      }
    }
  }
  if (elisions.length > 0) {
    lines.push("");
    lines.push(`(--budget, ${CONTEXT_PACK_BUDGET_UNIT}):`);
    for (const note of elisions) lines.push(`  - ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runQuestions(opts: QuestionsCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const backend = await openStorage(paths);

  const questions = await gatherQuestions(backend, opts);
  // groupQuestionsByTicket's own ordering (oldest-group-first, oldest
  // -question-first within a group) IS the elision-priority order this
  // command wants: flattening it preserves that order for --budget to
  // elide from the tail (least-important — the newest questions on the
  // most-recently-waiting tickets — last).
  const flattened = groupQuestionsByTicket(questions).flatMap((g) => g.questions);
  const ticketIds = [...new Set(flattened.map((q) => q.ticketId))];
  const ticketsById = await loadTicketsFor(backend, ticketIds);

  const format: RenderFormat = opts.json ? "json" : "text";
  const rendered = renderEntriesWithBudget(
    flattened,
    (kept, elisions) =>
      opts.json
        ? buildJson(kept, ticketsById, opts.all === true, elisions)
        : buildText(kept, ticketsById, opts.all === true, elisions),
    opts.budget,
    { format, noun: "question" },
  );
  process.stdout.write(rendered.text);
}

/** `slop questions` — G4 (t-jggg9): the elicitations inbox. */
export function registerQuestionsCommand(program: Command): void {
  program
    .command("questions")
    .description(
      "The elicitations inbox: questions from `slop ask`, default unanswered-only, oldest " +
        "first, grouped by ticket.",
    )
    .option("--all", "include already-answered questions too")
    .option("--ticket <ref>", "scope to one ticket")
    .option("--json", "machine-readable output")
    .option(
      "--budget <n>",
      `cap output size to N ${CONTEXT_PACK_BUDGET_UNIT} (elides the newest/least-urgent questions first)`,
      parseBudgetOption,
    )
    .action(runQuestions);
}
