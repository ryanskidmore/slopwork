import type { Command } from "commander";
import type { Clock } from "../../core/clock.js";
import { systemClock } from "../../core/clock.js";
import type { Session, Ticket } from "../../core/index.js";
import { END_SUMMARY_MAX_LENGTH, EXIT_CODES, nowIso, ticketSchema } from "../../core/index.js";
import {
  formatIndexProblems,
  readSession,
  readTicket,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
  updateSession,
  updateTicket,
  withLock,
} from "../../repo/index.js";
import { buildFinalizedSession } from "../../sessions/finalize.js";
import { diffSessionPatch, SESSION_END_FIELDS } from "../../sessions/patch.js";
import { cascadeOnClose } from "../../tickets/cascade.js";
import { diffTicketPatch, TICKET_FIELDS } from "../../tickets/patch.js";
import { checkDropEntry } from "../../tickets/state.js";
import { formatZodIssuesForUsage } from "../../tickets/validate.js";
import { loadConfig, resolveActor } from "../actor.js";
import { SlopError } from "../errors.js";
import { assertMaxLength, printWarning, sessionOwnershipWarning, ticketJson } from "./shared.js";

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

export async function runDrop(ref: string, opts: DropCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });

  if (opts.reason === undefined || opts.reason.trim().length === 0) {
    // Commander's `.requiredOption` already refuses a wholly-missing
    // --reason (usage error, exit 2) before this ever runs — this guards
    // the remaining gap: `--reason ""` / `--reason "   "`, which Commander
    // alone would let through as "present but empty".
    throw new SlopError(
      "--reason must not be empty — say why this ticket is being dropped",
      EXIT_CODES.USAGE_ERROR,
    );
  }
  assertMaxLength("--reason", opts.reason, END_SUMMARY_MAX_LENGTH);

  const initialTicket = await resolveTicketRef(paths, ref);

  const result = await withLock(paths.lockFile, async () => {
    const current = await readTicket(paths, initialTicket.id);

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
      const session = await readSession(paths, current.active_session);
      // ticket_01KYAPN9NXY6RPSV6WGR42CJHJ: session ownership is a
      // warning, not an enforced gate — see sessionOwnershipWarning's own
      // doc. `null` (never warned) when there's no session to compare
      // against at all.
      ownershipWarning = sessionOwnershipWarning(session, actor);
      finalSession = buildFinalizedSession(session, opts.reason);

      await updateSession(
        paths,
        session.id,
        diffSessionPatch(session, finalSession, SESSION_END_FIELDS),
        finalSession,
        { actor, session: session.id },
        {
          verb: "session.ended",
          payload: {
            reason: "dropped",
            note: opts.reason,
          },
        },
      );
    }

    const droppedTicket = buildDroppedTicket(current, opts.reason);
    await updateTicket(
      paths,
      current.id,
      diffTicketPatch(current, droppedTicket, TICKET_FIELDS),
      droppedTicket,
      { actor, session: finalSession?.id ?? null },
      { verb: "ticket.dropped", payload: { from: current.state, reason: opts.reason } },
    );

    // B4's done-cascade, once — a dropped ticket also stops blocking
    // (cascade.ts treats done/dropped identically as "no longer a live
    // blocker", see its own module doc / db-index.ts's
    // `isLiveBlockerState`).
    const cascade = await cascadeOnClose(paths, current.id, {
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

  if (result.ownershipWarning !== null) printWarning(result.ownershipWarning);
  if (result.cascade.problems.length > 0) {
    process.stderr.write(`${formatIndexProblems(result.cascade.problems)}\n`);
  }

  if (opts.json) {
    // closing-loop-commands-lack-json: same `unblocked`/`problems` shape
    // as `done --json` (both run the identical B4 done-cascade) — see that
    // command's doc for the field-naming rationale.
    process.stdout.write(
      `${JSON.stringify(
        {
          ticket: ticketJson(result.ticket),
          // `null` when the dropped ticket had no active session at all (an
          // open/draft ticket) — there was no session to report on.
          session: result.session === null ? null : { id: result.session.id },
          reason: opts.reason,
          unblocked: result.cascade.unblocked,
          problems: result.cascade.problems.map((p) => ({ id: p.id, message: p.message })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(
    `dropped ${result.ticket.id} (${result.ticket.slug})\n` +
      `  ${result.ticket.name}\n` +
      `  state: ${result.ticket.state}\n` +
      `  reason: ${opts.reason}\n` +
      (result.cascade.unblocked.length > 0
        ? `  unblocked: ${result.cascade.unblocked.join(", ")}\n`
        : ""),
  );
}

/** `slop drop` — design.md §2, §4.3; work item C3.
 *
 * `-> dropped` from any non-terminal state. If there's an active session,
 * finalizes it (end summary from `--reason`); either way, runs B4's
 * done-cascade exactly once — a dropped ticket also stops blocking its
 * dependents.
 */
export function registerDropCommand(program: Command): void {
  program
    .command("drop")
    .description("Mark <ref> dropped (wontdo) from any non-terminal state.")
    .argument("<ref>", "ticket to drop")
    .requiredOption("--reason <text>", "why this ticket is being dropped")
    .option(
      "--json",
      "machine-readable result (id, slug, handle, name, state, reason, unblocked, problems)",
    )
    .action(runDrop);
}
