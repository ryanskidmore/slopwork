/**
 * Orphaned active-session detection + repair (ticket_01KYAPKRJ9RJRJRAV42WCTJET4)
 * — `slop reindex`'s (D3/A3) companion for a crash window `start.ts`'s own
 * write-order fix (see that file's inline comment) cannot fully close: the
 * ticket write that references a brand-new session needs that session's
 * freshly-minted id, so creating the session file MUST happen before the
 * ticket write can — there is no ordering that avoids a window where the
 * session exists on disk (`ended_at: null`) but nothing yet references it.
 * A crash in that exact window leaves the session "active forever":
 * invisible to `ready`/`show` (nothing points `active_session` at it) and
 * un-endable by any dedicated command (`stop`/`done`/`drop`/`start
 * --takeover` all resolve a ticket's OWN `active_session`, never scan for
 * orphans).
 *
 * Detection, not prevention, is what closes this residual gap: an orphan
 * is simply a session with `ended_at: null` that no ticket's
 * `active_session` references — a pure diff, no guessing. `src/cli/
 * commands/reindex.ts` (`slop reindex`, always; `--heal` to repair) owns
 * locking, actor resolution, and the actual `updateSession` write; this
 * module only decides what to look for ({@link findOrphanedActiveSessions})
 * and what a repaired session should look like ({@link buildHealedSession}).
 */
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import { EXIT_CODES, nowIso, type Session, type SessionId, sessionSchema } from "../core/index.js";
import { SlopError } from "../cli/errors.js";
import { type SessionReadProblem, listSessionsTolerant } from "../repo/sessions.js";
import type { RepoPaths } from "../repo/paths.js";
import { formatZodIssuesForUsage } from "../tickets/validate.js";

export interface OrphanedSessionScan {
  /** `ended_at: null` sessions no ticket's `active_session` references —
   * ascending by id (= chronological, `listSessionsTolerant`'s own order). */
  orphans: Session[];
  /** Session files that could not be read at all — reported, never
   * silently dropped (same fault-tolerance policy as ticket reads). */
  problems: SessionReadProblem[];
}

/**
 * Diff every on-disk session against `referencedActiveSessionIds` — every
 * ticket's own `active_session`, non-null (the caller already has this
 * from a fresh index rebuild, e.g. `db-index.ts`'s `IndexTicketRow.active_session`
 * across every row; this function never re-reads tickets itself, so it
 * can't drift out of sync with whatever ticket state the caller already
 * computed). An orphan is a session with `ended_at: null` whose id is NOT
 * in that set — a genuinely live session (referenced by some ticket) is
 * never flagged, and an already-ended session is never "stranded"
 * regardless of whether anything still references it.
 *
 * Deliberately does NOT re-read tickets to double-check: doing so here
 * would race against whatever snapshot the caller's own index rebuild
 * already took, and — worse — a ticket file that's corrupt/unreadable at
 * scan time would silently make this function UNDER-count referenced
 * sessions (a real orphan misreported as one that's still live is safe;
 * the reverse — a live session misreported as orphaned — is not). The
 * caller (`reindex.ts`) is responsible for only trusting this scan's
 * output when its own ticket read was clean (no `IndexTicketRow` skipped).
 */
export async function findOrphanedActiveSessions(
  paths: RepoPaths,
  referencedActiveSessionIds: ReadonlySet<SessionId>,
): Promise<OrphanedSessionScan> {
  const { sessions, problems } = await listSessionsTolerant(paths);
  const orphans = sessions.filter(
    (session) => session.ended_at === null && !referencedActiveSessionIds.has(session.id),
  );
  return { orphans, problems };
}

/**
 * Build (never persist) an orphan as a repair should leave it: ended, with
 * a SYNTHESIZED `end_summary` explaining why (never a human-authored
 * handoff note — nobody wrote one; that absence is the whole reason this
 * session needed healing in the first place) — same build-then-let-the
 * -caller-persist split as `sessions/stop.ts`'s `buildStoppedSession` /
 * `sessions/finalize.ts`'s `buildFinalizedSession`.
 */
export function buildHealedSession(session: Session, clock: Clock = systemClock): Session {
  const now = nowIso(clock);
  const candidate = {
    ...session,
    ended_at: now,
    end_summary:
      "auto-healed by `slop reindex --heal`: this session was never referenced by any ticket's " +
      "active_session, most likely because of a crash between session creation and the ticket " +
      "write that would have pointed to it (ticket_01KYAPKRJ9RJRJRAV42WCTJET4) — no real handoff " +
      "note exists for this session.",
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
