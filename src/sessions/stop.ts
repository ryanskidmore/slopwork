/**
 * `slop stop` (C1) — pure domain orchestration, same split as
 * `src/sessions/start.ts`: this module decides *what* the resulting
 * {@link Session}/{@link Ticket} objects should be; `src/cli/commands/
 * stop.ts` owns resolving `<ref>`, locking, writing, and printing.
 */
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { Session, Ticket } from "../core/index.js";
import { EXIT_CODES, nowIso, sessionSchema, ticketSchema } from "../core/index.js";
import { SlopError } from "../core/errors.js";
import { formatZodIssuesForUsage } from "../tickets/validate.js";

/** `stop` only makes sense on a ticket with an active session — this is
 * the single source of truth for "is there anything to stop", deliberately
 * keyed off `active_session` rather than `state === "in_progress"`: the two
 * are kept in lockstep by `start`/`stop` themselves (C1's own scope), so
 * checking the field `stop` itself clears is the more direct assertion.
 *
 * C3 addendum: a `review`-state ticket ALSO carries a non-null
 * `active_session` (D15's session model, DECISIONS.md's C3 entry — `slop
 * review` deliberately never ends the session), which the
 * `active_session !== null` check alone can't tell apart from a genuine
 * `in_progress` ticket. §2's diagram draws no `review -> open` edge at
 * all — `stop` only ever hands an `in_progress` ticket back to `open` —
 * so this now rejects a `review`-state ticket explicitly, pointing at the
 * two edges §2 actually allows out of `review` (`slop done`, or `slop
 * start` for a changes-requested re-entry). Without this, `stop` would
 * silently perform an illegal `review -> open` transition, bypassing the
 * state machine `tests/acceptance/C3.test.ts`'s property test checks.
 */
export function assertStoppable(ticket: Ticket): void {
  if (ticket.active_session === null) {
    throw new SlopError(
      `ticket "${ticket.name}" (${ticket.slug}) has no active session to stop (state: ${ticket.state})`,
      EXIT_CODES.CONFLICT,
    );
  }
  if (ticket.state === "review") {
    throw new SlopError(
      `ticket "${ticket.name}" (${ticket.slug}) is in review, not in_progress — \`stop\` only hands an ` +
        'in_progress ticket back to open (design.md §2 has no "review -> open" edge). Either `slop ' +
        "done` it, or `slop start` it again to re-enter as a changes-requested round (D15).",
      EXIT_CODES.CONFLICT,
    );
  }
}

/** Build (never persist) the session as `stop` should leave it: ended, with
 * `note` (if given) as the handoff `end_summary`. */
export function buildStoppedSession(
  session: Session,
  note: string | undefined,
  clock: Clock = systemClock,
): Session {
  const now = nowIso(clock);
  const candidate = {
    ...session,
    ended_at: now,
    end_summary: note ?? null,
  };
  const parsed = sessionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SlopError(
      formatZodIssuesForUsage("invalid session", parsed.error),
      EXIT_CODES.GENERIC_ERROR,
    );
  }
  return parsed.data;
}

/** Build (never persist) the ticket as `stop` should leave it: back to
 * `open`, `active_session` cleared, `latest_note` updated when a handoff
 * note was given (same "note flows onto the ticket's pulse" convention
 * `update --progress` already uses). */
export function buildStoppedTicket(
  current: Ticket,
  note: string | undefined,
  clock: Clock = systemClock,
): Ticket {
  const now = nowIso(clock);
  const candidate = {
    ...current,
    state: "open" as const,
    active_session: null,
    latest_note: note ?? current.latest_note,
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
