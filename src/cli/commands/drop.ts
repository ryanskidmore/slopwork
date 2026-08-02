import type { Command } from "commander";
import type { Clock } from "../../core/clock.js";
import { systemClock } from "../../core/clock.js";
import type { Actor, Session, Ticket } from "../../core/index.js";
import { END_SUMMARY_MAX_LENGTH, EXIT_CODES, nowIso, ticketSchema } from "../../core/index.js";
import { formatIndexProblems } from "../../core/db-index.js";
import type { StorageBackend } from "../../core/storage-contract.js";
import { repoPaths, requireRepoRoot } from "../../repo/index.js";
import { openStorage } from "../../storage/index.js";
import { buildFinalizedSession } from "../../sessions/finalize.js";
import { diffSessionPatch, SESSION_END_FIELDS } from "../../sessions/patch.js";
import type { CascadeOnCloseResult } from "../../tickets/cascade.js";
import { cascadeOnClose } from "../../tickets/cascade.js";
import { diffTicketPatch, TICKET_FIELDS } from "../../tickets/patch.js";
import { checkDropEntry } from "../../tickets/state.js";
import { formatZodIssuesForUsage } from "../../tickets/validate.js";
import { loadConfig, resolveActor } from "../actor.js";
import { SlopError } from "../errors.js";
import {
  assertMaxLength,
  type BulkOutcome,
  printWarning,
  resolveBulkRefs,
  runSingleOrBulk,
  sessionOwnershipWarning,
  ticketJson,
} from "./shared.js";

interface DropCommandOptions {
  reason: string;
  json?: boolean;
}

/**
 * Build (never persist) the ticket as `drop` should leave it: `-> dropped`
 * (§2: "dropped (wontdo) from anywhere" — the CLI layer below enforces
 * legality via `checkDropEntry` before this is ever called), `review`
 * cleared (schema requires it absent outside `state === "review"`),
 * `active_session` cleared unconditionally (harmless no-op if already
 * `null`, e.g. dropping an `open`/`draft` ticket with nothing active),
 * `latest_note` set from `--reason` (always given — the flag is required).
 */
export function buildDroppedTicket(
  current: Ticket,
  reason: string,
  clock: Clock = systemClock,
): Ticket {
  const now = nowIso(clock);
  const candidate = {
    ...current,
    state: "dropped" as const,
    review: undefined,
    active_session: null,
    latest_note: reason,
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

/** One ref's `drop` outcome — what {@link dropOneRef} returns, shared by
 * both the single-ref and bulk (t-mmngo) rendering paths below. */
interface DropOneResult {
  ticket: Ticket;
  session: Session | null;
  ownershipWarning: string | null;
  cascade: CascadeOnCloseResult;
}

async function dropOneRef(
  backend: StorageBackend,
  actor: Actor,
  reason: string,
  ref: string,
): Promise<DropOneResult> {
  const initialTicket = await backend.resolveTicketRef(ref);

  return backend.transact(async (tx) => {
    const current = await backend.readTicket(initialTicket.id);

    const check = checkDropEntry(current.state);
    if (!check.ok) {
      throw new SlopError(check.reason ?? "illegal state transition", EXIT_CODES.CONFLICT);
    }

    let finalSession: Session | null = null;
    let ownershipWarning: string | null = null;

    // §2: "dropped (wontdo) from anywhere" — an open/draft ticket has no
    // active session at all, so there is nothing to finalize; only
    // in_progress/review tickets carry one.
    if (current.active_session !== null) {
      const session = await backend.readSession(current.active_session);
      // ticket_01KYAPN9NXY6RPSV6WGR42CJHJ: session ownership is a
      // warning, not an enforced gate — see sessionOwnershipWarning's own
      // doc. `null` (never warned) when there's no session to compare
      // against at all.
      ownershipWarning = sessionOwnershipWarning(session, actor);
      finalSession = buildFinalizedSession(session, reason);

      await backend.updateSession(
        session.id,
        diffSessionPatch(session, finalSession, SESSION_END_FIELDS),
        finalSession,
        { actor, session: session.id },
        {
          verb: "session.ended",
          payload: {
            reason: "dropped",
            note: reason,
          },
        },
      );
    }

    const droppedTicket = buildDroppedTicket(current, reason);
    await backend.updateTicket(
      current.id,
      diffTicketPatch(current, droppedTicket, TICKET_FIELDS),
      droppedTicket,
      { actor, session: finalSession?.id ?? null },
      { verb: "ticket.dropped", payload: { from: current.state, reason } },
    );

    // B4's done-cascade, once — a dropped ticket also stops blocking
    // (cascade.ts treats done/dropped identically as "no longer a live
    // blocker", see its own module doc / db-index.ts's
    // `isLiveBlockerState`).
    const cascade = await cascadeOnClose(backend, tx, current.id, {
      actor,
      session: finalSession?.id ?? null,
    });

    return {
      session: finalSession,
      ticket: droppedTicket,
      ownershipWarning,
      cascade,
    };
  });
}

/** `--json` body for one `drop` outcome — same shape whether printed alone
 * (single ref) or nested under a bulk row's `result` (t-mmngo). Same
 * `unblocked`/`problems` shape as `done --json` (both run the identical
 * cascade); `session` is `null` when the dropped ticket had no active
 * session to finalize. */
function dropJsonBody(
  result: DropOneResult,
  reason: string,
): {
  ticket: ReturnType<typeof ticketJson>;
  session: { id: string } | null;
  reason: string;
  unblocked: string[];
  problems: { id: string; message: string }[];
} {
  return {
    ticket: ticketJson(result.ticket),
    session: result.session === null ? null : { id: result.session.id },
    reason,
    unblocked: result.cascade.unblocked,
    problems: result.cascade.problems.map((p) => ({ id: p.id, message: p.message })),
  };
}

/** Shared by both rendering paths — printed AFTER the transaction commits. */
function printDropWarnings(result: DropOneResult): void {
  if (result.ownershipWarning !== null) printWarning(result.ownershipWarning);
  if (result.cascade.problems.length > 0) {
    process.stderr.write(`${formatIndexProblems(result.cascade.problems)}\n`);
  }
}

function printDropSingle(result: DropOneResult, reason: string, json: boolean | undefined): void {
  printDropWarnings(result);

  if (json) {
    // closing-loop-commands-lack-json: same `unblocked`/`problems` shape
    // as `done --json` (both run the identical B4 done-cascade) — see that
    // command's doc for the field-naming rationale.
    process.stdout.write(`${JSON.stringify(dropJsonBody(result, reason), null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `dropped ${result.ticket.id} (${result.ticket.slug})\n` +
      `  ${result.ticket.name}\n` +
      `  state: ${result.ticket.state}\n` +
      `  reason: ${reason}\n` +
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
function renderBulkDrop(
  outcomes: readonly BulkOutcome<DropOneResult>[],
  reason: string,
  json: boolean | undefined,
): void {
  for (const outcome of outcomes) {
    if (outcome.ok && outcome.data) printDropWarnings(outcome.data);
  }

  if (json) {
    const results = outcomes.map((outcome) =>
      outcome.ok && outcome.data
        ? {
            ref: outcome.ref,
            ok: true,
            exit_code: outcome.exitCode,
            result: dropJsonBody(outcome.data, reason),
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
        `${outcome.ref} -> dropped ${ticket.id} (${ticket.slug})  state: ${ticket.state}` +
          (cascade.unblocked.length > 0 ? `  unblocked: ${cascade.unblocked.join(", ")}` : "") +
          "\n",
      );
    } else {
      process.stderr.write(`error: ${outcome.ref}: ${outcome.error} (exit ${outcome.exitCode})\n`);
    }
  }
}

export async function runDrop(refs: string[], opts: DropCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });
  const backend = await openStorage(paths);

  if (opts.reason === undefined || opts.reason.trim().length === 0) {
    // Commander's `.requiredOption` already refuses a wholly-missing
    // --reason (usage error, exit 2) before this ever runs — this guards
    // the remaining gap: `--reason ""` / `--reason "   "`, which Commander
    // alone would let through as "present but empty".
    throw new SlopError(
      "--reason must not be empty — say why these ticket(s) are being dropped",
      EXIT_CODES.USAGE_ERROR,
    );
  }
  assertMaxLength("--reason", opts.reason, END_SUMMARY_MAX_LENGTH);

  const resolvedRefs = await resolveBulkRefs(refs);

  await runSingleOrBulk(
    resolvedRefs,
    (ref) => dropOneRef(backend, actor, opts.reason, ref),
    (result) => printDropSingle(result, opts.reason, opts.json),
    (outcomes) => renderBulkDrop(outcomes, opts.reason, opts.json),
  );
}

/** `slop drop` — design.md §2, §4.3; work item C3.
 *
 * `-> dropped` from any non-terminal state. If there's an active session,
 * finalizes it (end summary from `--reason`); either way, runs B4's
 * done-cascade exactly once — a dropped ticket also stops blocking its
 * dependents.
 *
 * t-mmngo: accepts multiple `<refs...>` (or `-` to read refs from stdin,
 * one per line) — `--reason` applies to every ref, applied per-ref (never
 * all-or-nothing); see `runSingleOrBulk`'s doc (shared.ts) for the exact
 * single-vs-bulk output contract.
 */
export function registerDropCommand(program: Command): void {
  program
    .command("drop")
    .description("Mark one or more tickets dropped (wontdo) from any non-terminal state.")
    .argument("<refs...>", 'one or more tickets to drop (or "-" to read refs from stdin)')
    .requiredOption(
      "--reason <text>",
      "why these ticket(s) are being dropped (applies to every ref)",
    )
    .option(
      "--json",
      "machine-readable result (id, slug, handle, name, state, reason, unblocked, problems) " +
        "for a single ref; {results[], ok, succeeded, failed} for multiple",
    )
    .action(runDrop);
}
