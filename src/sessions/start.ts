/**
 * `slop start` (C1) — pure domain orchestration, mirroring
 * `src/tickets/new.ts`'s split: this module decides *what* the resulting
 * {@link Session}/{@link Ticket} objects should be and whether the
 * operation is even legal; `src/cli/commands/start.ts` owns resolving
 * `<ref>`, acquiring the db lock, actually writing (via `createSession`/
 * `updateTicket`/`updateSession`), and all stdout/stderr formatting.
 *
 * design.md §2 ("Working a ticket"): "`start` creates a session (harness
 * kind + harness session id + branch/commit captured), sets `in_progress`,
 * prints the context pack. ... Takeover of an active ticket: warn +
 * `--takeover`, logged."
 */
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type {
  Actor,
  Harness,
  Session,
  SessionGit,
  SessionId,
  Ticket,
  TicketId,
} from "../core/index.js";
import { EXIT_CODES, newSessionId, nowIso, sessionSchema, ticketSchema } from "../core/index.js";
import { SlopError } from "../cli/errors.js";
import { formatZodIssuesForUsage } from "../tickets/validate.js";

/**
 * D13 ("drafts are never workable") plus "refuse states where starting is
 * meaningless" (C1 brief). `open`, `in_progress` (the takeover path — see
 * start.ts's CLI layer), and `review` (D15's "changes requested" re-entry:
 * `review -> in_progress` via a plain re-`start`) are all legal starting
 * points; only `draft` and the two terminal states are not.
 */
export function assertStartable(ticket: Ticket): void {
  if (ticket.state === "draft") {
    throw new SlopError(
      `cannot start "${ticket.name}" (${ticket.slug}) — it is a draft (D13: drafts are never ` +
        `workable); run \`slop undraft ${ticket.slug}\` first`,
      EXIT_CODES.CONFLICT,
    );
  }
  if (ticket.state === "done" || ticket.state === "dropped") {
    throw new SlopError(
      `cannot start "${ticket.name}" (${ticket.slug}) — it is already "${ticket.state}", a terminal state`,
      EXIT_CODES.CONFLICT,
    );
  }
}

/** Human-readable "what's currently active" line for both the refusal
 * message and `start`'s own takeover confirmation line. */
export function describeActiveSession(session: Session): string {
  return (
    `actor=${session.actor.name} (${session.actor.kind}) harness=${session.harness.kind} ` +
    `since=${session.started_at}`
  );
}

/**
 * The refusal `start` throws when a ticket already has an active session
 * and `--takeover` wasn't passed (C1 brief: "warn and refuse by default,
 * telling the user what's active ... and that `--takeover` will seize
 * it"). The D1-installed skill tells agents not to take over unless
 * explicitly instructed — this message says so explicitly, not just "pass
 * --takeover", so the refusal path is actionable without being an
 * invitation to reflexively retry with it.
 */
export function activeSessionConflictError(ticket: Ticket, session: Session): SlopError {
  return new SlopError(
    `ticket "${ticket.name}" (${ticket.slug}) already has an active session: ` +
      `${describeActiveSession(session)}.\n` +
      "Pass --takeover to seize it — only do this when a human explicitly instructed you to; " +
      "unprompted takeovers of another session's active work are discouraged (see .slop/AGENTS.md).",
    EXIT_CODES.CONFLICT,
  );
}

export interface NewSessionInput {
  ticket: TicketId;
  actor: Actor;
  harness: Harness;
  git: SessionGit;
}

/** Build (never persist) a brand-new {@link Session} for `start`. */
export function buildNewSession(input: NewSessionInput, clock: Clock = systemClock): Session {
  const now = nowIso(clock);
  const candidate = {
    id: newSessionId(),
    ticket: input.ticket,
    actor: input.actor,
    harness: input.harness,
    git: input.git,
    started_at: now,
    ended_at: null,
    plan: [],
    end_summary: null,
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

export interface StartedTicketResult {
  ticket: Ticket;
  /** `true` iff `ticket.state` itself changes (false in the pure-takeover
   * case: the ticket is already `in_progress`, only `active_session` moves). */
  stateChanged: boolean;
  /** D15: `review -> in_progress` is the "changes requested" re-entry — the
   * event payload must carry `re_entry: true` when this is set. */
  reEntry: boolean;
}

/** Build (never persist) the ticket as `start` should leave it: `state`
 * moved to `in_progress` (a no-op if already there — the takeover case),
 * `active_session` pointed at the new session, `review` cleared iff this is
 * a D15 re-entry, activity timestamps bumped. */
export function buildStartedTicket(
  current: Ticket,
  sessionId: SessionId,
  clock: Clock = systemClock,
): StartedTicketResult {
  const now = nowIso(clock);
  const reEntry = current.state === "review";
  const stateChanged = current.state !== "in_progress";

  const candidate = {
    ...current,
    state: "in_progress" as const,
    review: reEntry ? undefined : current.review,
    active_session: sessionId,
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
  return { ticket: parsed.data, stateChanged, reEntry };
}

/** Build (never persist) the previous session as `--takeover` should leave
 * it: ended, with an `end_summary` naming who took over and when. */
export function buildSupersededSession(
  previous: Session,
  byActor: Actor,
  clock: Clock = systemClock,
): Session {
  const now = nowIso(clock);
  const candidate = {
    ...previous,
    ended_at: now,
    end_summary: `superseded by takeover: ${byActor.name} (${byActor.kind}) took over at ${now}`,
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
