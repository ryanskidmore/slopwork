import type { Command } from "commander";
import type { Clock } from "../../core/clock.js";
import { systemClock } from "../../core/clock.js";
import type { Actor, Session, Ticket } from "../../core/index.js";
import {
  END_SUMMARY_MAX_LENGTH,
  EXIT_CODES,
  nowIso,
  RESOLUTION_MAX_LENGTH,
  ticketSchema,
} from "../../core/index.js";
import { repoPaths, requireRepoRoot } from "../../repo/index.js";
import { formatIndexProblems } from "../../storage/backend.js";
import type { StorageBackend } from "../../storage/index.js";
import { openStorage } from "../../storage/index.js";
import { buildFinalizedSession } from "../../sessions/finalize.js";
import { diffSessionPatch, SESSION_END_FIELDS } from "../../sessions/patch.js";
import type { CascadeOnCloseResult } from "../../tickets/cascade.js";
import { cascadeOnClose } from "../../tickets/cascade.js";
import { diffTicketPatch, TICKET_FIELDS } from "../../tickets/patch.js";
import { checkDoneEntry } from "../../tickets/state.js";
import { formatZodIssuesForUsage } from "../../tickets/validate.js";
import { loadConfig, resolveActor } from "../actor.js";
import { SlopError } from "../errors.js";
import {
  assertMaxLength,
  type BulkOutcome,
  printWarning,
  readStdin,
  resolveBulkRefs,
  runSingleOrBulk,
  sessionOwnershipWarning,
  ticketJson,
} from "./shared.js";

interface DoneCommandOptions {
  note?: string;
  outcome?: string;
  json?: boolean;
}

/**
 * Build (never persist) the ticket as `done` should leave it: `review ->
 * done` OR `in_progress -> done` (D15, revised — review is optional;
 * `checkDoneEntry` decides legality, the nag decision lives in `runDone`
 * below, both before this is ever called), `review` cleared (already
 * absent on the `in_progress` path; the schema requires it absent outside
 * `state === "review"`), `active_session` cleared, `latest_note` updated
 * from `--note` when given (same convention `stop`'s `buildStoppedTicket`
 * uses for its handoff note), and `resolution` updated from `--outcome`
 * when given — same "given wins, else leave whatever was already there"
 * convention as `latest_note`, so a `resolution` never regresses to
 * absent just because a later `done` call omitted `--outcome`.
 */
export function buildDoneTicket(
  current: Ticket,
  note: string | undefined,
  resolution: string | undefined,
  clock: Clock = systemClock,
): Ticket {
  const now = nowIso(clock);
  const candidate = {
    ...current,
    state: "done" as const,
    review: undefined,
    active_session: null,
    latest_note: note ?? current.latest_note,
    resolution: resolution ?? current.resolution,
    last_activity_at: now,
    updated_at: now,
  };
  const parsed = ticketSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SlopError(
      formatZodIssuesForUsage("invalid ticket", parsed.error),
      EXIT_CODES.GENERIC_ERROR,
    );
  }
  return parsed.data;
}

/** One ref's `done` outcome — what {@link doneOneRef} returns, shared by
 * both the single-ref and bulk (t-mmngo) rendering paths below. */
interface DoneOneResult {
  ticket: Ticket;
  session: Session;
  cascade: CascadeOnCloseResult;
  skippedReview: boolean;
  ownershipWarning: string | null;
}

async function doneOneRef(
  backend: StorageBackend,
  actor: Actor,
  note: string | undefined,
  outcomeRaw: string | undefined,
  ref: string,
): Promise<DoneOneResult> {
  const initialTicket = await backend.resolveTicketRef(ref);

  return backend.transact(async (tx) => {
    const current = await backend.readTicket(initialTicket.id);

    // D15/§2, revised (ticket_01KY9RWFDR9QEWQ5B1ZACQJ338): review is now
    // OPTIONAL — legal from `review` OR directly from `in_progress`. See
    // state.ts's module doc ("review made optional") for the full
    // rationale; DECISIONS.md's older C3 entry documents the prior,
    // review-required decision this ticket supersedes.
    const check = checkDoneEntry(current.state);
    if (!check.ok) {
      throw new SlopError(check.reason ?? "illegal state transition", EXIT_CODES.CONFLICT);
    }

    // The nag (§8.1 item 3's required-with-warning philosophy, applied one
    // level up from `review --mr`'s own optional-MR nag): completing
    // directly from `in_progress` — i.e. this ticket never went through
    // `review` — is legal per `checkDoneEntry` above, but a non-`adhoc`
    // ticket still gets a soft warning, printed on stderr AFTER the
    // transaction commits (below). `adhoc` tickets (D13: exempt from the usual planning
    // ceremony) never nag, and neither does the unchanged `review -> done`
    // path.
    const skippedReview = current.state === "in_progress" && current.adhoc !== true;

    const activeSessionId = current.active_session;
    if (activeSessionId === null) {
      // Unreachable in practice for either legal entry state: a
      // `review`-state ticket always still carries its active session
      // (DECISIONS.md's C3 entry — `slop review` never clears
      // `active_session`, only `slop done`/`drop`/`stop` do, and `stop`
      // refuses a review-state ticket), and an `in_progress`-state ticket
      // always carries one too (C1's invariant — `start` sets it, only
      // `stop`/`done`/`drop` clear it, none of which can have run while
      // still `in_progress`). Kept only for TypeScript narrowing / defense
      // against a hand-edited or otherwise inconsistent db.
      throw new SlopError(
        `ticket "${current.name}" (${current.slug}) is "${current.state}" but has no active session — ` +
          `the db appears inconsistent (a "${current.state}"-state ticket should always carry one)`,
        EXIT_CODES.GENERIC_ERROR,
      );
    }
    const session = await backend.readSession(activeSessionId);
    // ticket_01KYAPN9NXY6RPSV6WGR42CJHJ: session ownership is a warning,
    // not an enforced gate — see sessionOwnershipWarning's own doc.
    const ownershipWarning = sessionOwnershipWarning(session, actor);

    const finalSession = buildFinalizedSession(session, note ?? null);

    await backend.updateSession(
      session.id,
      diffSessionPatch(session, finalSession, SESSION_END_FIELDS),
      finalSession,
      { actor, session: session.id },
      {
        verb: "session.ended",
        payload: {
          reason: "done",
          ...(note !== undefined ? { note } : {}),
        },
      },
    );

    const doneTicket = buildDoneTicket(current, note, outcomeRaw);
    await backend.updateTicket(
      current.id,
      diffTicketPatch(current, doneTicket, TICKET_FIELDS),
      doneTicket,
      { actor, session: session.id },
      { verb: "ticket.done", payload: { from: current.state } },
    );

    // B4's done-cascade — called exactly once, right after the terminal
    // state write it depends on, inside this SAME lock acquisition (see
    // cascade.ts's module doc, "Locking contract"). This is what emits
    // `ticket.ready` for any dependent this ticket was blocking.
    const cascade = await cascadeOnClose(backend, tx, current.id, { actor, session: session.id });

    return {
      session: finalSession,
      ticket: doneTicket,
      cascade,
      skippedReview,
      ownershipWarning,
    };
  });
}

/** `--json` body for one `done` outcome — same shape whether printed alone
 * (single ref) or nested under a bulk row's `result` (t-mmngo). */
function doneJsonBody(result: DoneOneResult): {
  ticket: ReturnType<typeof ticketJson>;
  session: { id: string; note: string | null };
  resolution_set: boolean;
  unblocked: string[];
  problems: { id: string; message: string }[];
  skipped_review: boolean;
} {
  return {
    ticket: ticketJson(result.ticket),
    session: { id: result.session.id, note: result.session.end_summary },
    resolution_set: result.ticket.resolution !== undefined,
    unblocked: result.cascade.unblocked,
    problems: result.cascade.problems.map((p) => ({ id: p.id, message: p.message })),
    skipped_review: result.skippedReview,
  };
}

/** Printed AFTER the transaction commits — a skipped review, a
 * session-ownership mismatch, or a corrupt-elsewhere-in-the-db problem is
 * a warning, never a reason `done` itself could fail (same convention as
 * `stop.ts`; see `sessionOwnershipWarning`'s own doc). Shared by both the
 * single-ref and bulk (t-mmngo) rendering paths. */
function printDoneWarnings(result: DoneOneResult): void {
  if (result.skippedReview) {
    printWarning(
      `${result.ticket.id} (${result.ticket.slug}) done without a review/MR — if this had a code ` +
        "change, open an MR and run `slop review --mr <url>` first next time (D15: review is " +
        "optional, not required)",
    );
  }
  if (result.ownershipWarning !== null) printWarning(result.ownershipWarning);
  if (result.cascade.problems.length > 0) {
    process.stderr.write(`${formatIndexProblems(result.cascade.problems)}\n`);
  }
}

function printDoneSingle(result: DoneOneResult, json: boolean | undefined): void {
  printDoneWarnings(result);

  if (json) {
    // closing-loop-commands-lack-json: `unblocked` is the field this
    // ticket's own brief calls out by name ("done's unblocked-cascade list
    // is prose only") — a `TicketId[]`, matching `cascade.ts`'s own
    // `CascadeOnCloseResult.unblocked` field name/shape exactly, not a
    // joined string. `problems` mirrors `status --json`'s own
    // `{id, message}` shape (db-index.ts's `TicketReadProblem` minus
    // `path`, which is an internal file-layout detail status/done's
    // agent-facing JSON has never surfaced). `resolution_set` (not
    // `resolution`) deliberately avoids a field that would sometimes hold
    // a string and sometimes a boolean depending on `--outcome` — the
    // full resolution text is `show --json`'s job.
    process.stdout.write(`${JSON.stringify(doneJsonBody(result), null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `done ${result.ticket.id} (${result.ticket.slug})\n` +
      `  ${result.ticket.name}\n` +
      `  state: ${result.ticket.state}\n` +
      `  note: ${result.session.end_summary ?? "(none)"}\n` +
      `  resolution: ${result.ticket.resolution !== undefined ? "(set)" : "(none)"}\n` +
      (result.cascade.unblocked.length > 0
        ? `  unblocked: ${result.cascade.unblocked.join(", ")}\n`
        : ""),
  );
}

/**
 * t-mmngo: bulk (`refs.length > 1`) rendering — one line of text per ref,
 * or a `results[]` envelope for `--json`. A failing ref's text line goes
 * to STDERR (never stdout — see `update.ts`'s `renderBulkUpdate` doc for
 * why); its `--json` entry still lives in the ONE `results[]` array on
 * stdout.
 */
function renderBulkDone(
  outcomes: readonly BulkOutcome<DoneOneResult>[],
  json: boolean | undefined,
): void {
  for (const outcome of outcomes) {
    if (outcome.ok && outcome.data) printDoneWarnings(outcome.data);
  }

  if (json) {
    const results = outcomes.map((outcome) =>
      outcome.ok && outcome.data
        ? {
            ref: outcome.ref,
            ok: true,
            exit_code: outcome.exitCode,
            result: doneJsonBody(outcome.data),
          }
        : { ref: outcome.ref, ok: false, exit_code: outcome.exitCode, error: outcome.error },
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          results,
          ok: outcomes.every((o) => o.ok),
          succeeded: outcomes.filter((o) => o.ok).length,
          failed: outcomes.filter((o) => !o.ok).length,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  for (const outcome of outcomes) {
    if (outcome.ok && outcome.data) {
      const { ticket, cascade } = outcome.data;
      process.stdout.write(
        `${outcome.ref} -> done ${ticket.id} (${ticket.slug})  state: ${ticket.state}` +
          (cascade.unblocked.length > 0 ? `  unblocked: ${cascade.unblocked.join(", ")}` : "") +
          "\n",
      );
    } else {
      process.stderr.write(`error: ${outcome.ref}: ${outcome.error} (exit ${outcome.exitCode})\n`);
    }
  }
}

export async function runDone(refs: string[], opts: DoneCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });
  const backend = await openStorage(paths);

  if (opts.note !== undefined) {
    assertMaxLength("--note", opts.note, END_SUMMARY_MAX_LENGTH);
  }

  // t-mmngo: refs from stdin ("-") and "--outcome -" both want the SAME
  // stdin — reject the ambiguous combination up front.
  if (refs.length === 1 && refs[0] === "-" && opts.outcome === "-") {
    throw new SlopError(
      'cannot combine "-" (read refs from stdin) with --outcome - (which also reads stdin) — ' +
        "give refs literally, or pass --outcome a real value",
      EXIT_CODES.USAGE_ERROR,
    );
  }

  // `--outcome -` reads stdin, mirroring `--spec -` (new/update — see
  // shared.ts's `readStdin` doc). Read OUTSIDE the lock, and ONCE for the
  // whole bulk call (t-mmngo: `--outcome` is a shared flag applying to
  // every ref) — never part of a per-ref loop, which would starve every
  // ref after the first.
  const outcomeRaw =
    opts.outcome === undefined
      ? undefined
      : opts.outcome === "-"
        ? await readStdin()
        : opts.outcome;
  // housekeeping-gitignore-lock-stale: `--outcome -` can read an arbitrary
  // amount of stdin (readStdin has no size cap) — checked here, right
  // after the read completes, rather than only much later when it fails
  // `resolutionSchema`'s own max deep inside `buildDoneTicket`. Trimmed
  // first, matching `resolutionSchema`'s own `.trim()` before its `.max()`
  // (see that schema's doc comment) — so this can never reject (or
  // accept) a length the schema itself would disagree with.
  if (outcomeRaw !== undefined) {
    assertMaxLength("--outcome", outcomeRaw.trim(), RESOLUTION_MAX_LENGTH);
  }

  const resolvedRefs = await resolveBulkRefs(refs);

  await runSingleOrBulk(
    resolvedRefs,
    (ref) => doneOneRef(backend, actor, opts.note, outcomeRaw, ref),
    (result) => printDoneSingle(result, opts.json),
    (outcomes) => renderBulkDone(outcomes, opts.json),
  );
}

/** `slop done` — design.md §2, §4.3, D15; work item C3.
 *
 * `review -> done` OR `in_progress -> done` (see `buildDoneTicket`'s doc —
 * D15 revised, review is optional; ticket_01KY9RWFDR9QEWQ5B1ZACQJ338):
 * finalizes the active session (end summary from `--note`), then runs B4's
 * done-cascade exactly once. Completing a non-`adhoc` ticket directly from
 * `in_progress` (skipping review) nags on stderr but still succeeds;
 * `adhoc` tickets and the `review -> done` path never nag.
 *
 * t-mmngo: accepts multiple `<refs...>` (or `-` to read refs from stdin,
 * one per line) — `--note`/`--outcome` apply to every ref, applied per-ref
 * (never all-or-nothing); see `runSingleOrBulk`'s doc (shared.ts) for the
 * exact single-vs-bulk output contract.
 */
export function registerDoneCommand(program: Command): void {
  program
    .command("done")
    .description(
      "Complete one or more tickets (from review, or directly from in_progress — review is " +
        "optional, but non-adhoc tickets nag on stderr if they skip it): finalize each session " +
        "(end summary), cascade unblocks (B4), and mark done. Applied per-ref.",
    )
    .argument("<refs...>", 'one or more tickets to complete (or "-" to read refs from stdin)')
    .option("--note <text>", "completion note (applies to every ref)")
    .option(
      "--outcome <text>",
      'long-form resolution/outcome writeup, stored on every ref; pass "-" to read from stdin',
    )
    .option(
      "--json",
      "machine-readable result (id, slug, handle, name, state, note, resolution_set, " +
        "unblocked, problems, skipped_review) for a single ref; {results[], ok, succeeded, " +
        "failed} for multiple",
    )
    .action(runDone);
}
