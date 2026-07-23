/**
 * `slop stop` (C1) — pure domain orchestration, same split as
 * `src/sessions/start.ts`: this module decides *what* the resulting
 * {@link Session}/{@link Ticket} objects should be; `src/cli/commands/
 * stop.ts` owns resolving `<ref>`, locking, writing, and printing.
 *
 * design.md §2: "`stop` hands off (transcript also captured — a dead
 * session's transcript is often the most valuable one)." Transcript
 * capture is explicitly C4's job (see this module's `end_summary`/
 * `transcript_ref` handling below) — this module never touches
 * `transcript_ref`, leaving it at whatever `createSession` (start.ts)
 * already wrote (`null`), which is the correct, honest seam: `stop` ends
 * the session; C4 decides what (if anything) fills in the transcript
 * afterward.
 */
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { Session, Ticket } from "../core/index.js";
import { EXIT_CODES, nowIso, sessionSchema, ticketSchema } from "../core/index.js";
import { SlopError } from "../cli/errors.js";
import { formatZodIssuesForUsage } from "../tickets/validate.js";

/** `stop` only makes sense on a ticket with an active session — this is
 * the single source of truth for "is there anything to stop", deliberately
 * keyed off `active_session` rather than `state === "in_progress"`: the two
 * are kept in lockstep by `start`/`stop` themselves (C1's own scope), so
 * checking the field `stop` itself clears is the more direct assertion. */
export function assertStoppable(ticket: Ticket): void {
  if (ticket.active_session === null) {
    throw new SlopError(
      `ticket "${ticket.name}" (${ticket.slug}) has no active session to stop (state: ${ticket.state})`,
      EXIT_CODES.CONFLICT,
    );
  }
}

/** Build (never persist) the session as `stop` should leave it: ended, with
 * `note` (if given) as the handoff `end_summary`. `transcript_ref` is left
 * untouched (C4's seam — see module doc). */
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
