/**
 * `slop ask <ticket-ref> "<question>"` (G4, t-jggg9) — the structured
 * replacement for the old `slop update <ref> --progress "QUESTION: …"`
 * string convention: records a `question.asked` event, ticket-scoped,
 * actor-attributed, carrying the question text and (optionally) a set of
 * multiple-choice `--option`s. This is what makes a ticket `awaiting_input`
 * (`src/tickets/overlay.ts`'s `computeAwaitingInputOverlay`) and what shows
 * up in `slop questions`'/`/api/questions`'s inbox.
 *
 * Lock-free, like a pure `update --progress` note (`src/cli/commands/
 * update.ts`'s `pureProgressNote` path): appending an event needs no
 * read-modify-write of the ticket file itself, so N agents can `ask` the
 * same ticket at the same instant with zero write contention — each mints
 * its own ULID event file (`entity-file.ts`'s `createEntityFileCanonical`
 * doc). The event uses the resolved ticket snapshot's active session, the
 * same snapshot convention as `update`'s lock-free progress path.
 */
import type { Command } from "commander";
import type { Actor } from "../../core/index.js";
import { EXIT_CODES, shortTicketCode } from "../../core/index.js";
import { repoPaths, requireRepoRoot, ticketEventContext } from "../../repo/index.js";
import { openStorage } from "../../storage/index.js";
import { QUESTION_OPTION_MAX_LENGTH, QUESTION_TEXT_MAX_LENGTH } from "../../tickets/questions.js";
import { loadConfig, resolveActor } from "../actor.js";
import { SlopError } from "../errors.js";
import { assertMaxLength, collect } from "./shared.js";

interface AskCommandOptions {
  option: string[];
  json?: boolean;
}

export async function runAsk(
  ref: string,
  questionText: string,
  opts: AskCommandOptions,
): Promise<void> {
  const trimmed = questionText.trim();
  if (trimmed.length === 0) {
    throw new SlopError("<question> must not be empty", EXIT_CODES.USAGE_ERROR);
  }
  assertMaxLength("<question>", questionText, QUESTION_TEXT_MAX_LENGTH);
  for (const option of opts.option) {
    assertMaxLength("--option", option, QUESTION_OPTION_MAX_LENGTH);
  }
  // Blank/whitespace-only options are dropped, not rejected — a stray
  // `--option ""` is a harmless no-op rather than a usage error, matching
  // `update --label`'s tolerance for a fully-redundant flag.
  const options = opts.option.map((o) => o.trim()).filter((o) => o.length > 0);

  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor: Actor = resolveActor({ config, cwd: root });
  const backend = await openStorage(paths);

  const ticket = await backend.resolveTicketRef(ref);

  const event = await backend.appendEvent(
    ticketEventContext(actor, ticket),
    { kind: "ticket", id: ticket.id },
    { verb: "question.asked", payload: { text: trimmed, options } },
  );

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          question: {
            id: event.id,
            ticket: {
              id: ticket.id,
              slug: ticket.slug,
              handle: shortTicketCode(ticket.id),
              name: ticket.name,
              state: ticket.state,
            },
            text: trimmed,
            options,
            asked_by: event.actor,
            asked_at: event.at,
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(
    `asked ${event.id}  on ${ticket.id} (${ticket.slug})\n` +
      `  "${trimmed}"\n` +
      (options.length > 0 ? `  options: ${options.join(", ")}\n` : "") +
      `  ${ticket.name} is now awaiting input — answer with \`slop answer ${event.id} "<answer>"\`\n`,
  );
}

/** `slop ask` — G4 (t-jggg9): structured elicitation, replacing the old
 * `update --progress "QUESTION: …"` string convention. */
export function registerAskCommand(program: Command): void {
  program
    .command("ask")
    .description(
      "Record a structured question on a ticket (question.asked event) — makes the ticket " +
        "awaiting_input until answered (`slop answer`). Replaces the old " +
        '`update --progress "QUESTION: …"` convention.',
    )
    .argument("<ticket-ref>", "the ticket this question is about")
    .argument("<question>", "the question text")
    .option(
      "--option <text>",
      "a multiple-choice option (repeatable) — shown alongside the question in the inbox/web",
      collect,
      [] as string[],
    )
    .option("--json", "machine-readable result (question id, ticket, text, options, asked_by/at)")
    .action(runAsk);
}
