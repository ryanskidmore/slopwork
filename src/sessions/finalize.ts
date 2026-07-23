/**
 * Shared "finalize this session" builder for `done`/`drop` (C3) — the
 * same shape as `sessions/stop.ts`'s `buildStoppedSession` (C1: set
 * `ended_at` + `end_summary` from a note, leave `transcript_ref` for the
 * caller to fold in separately per C4's seam — see transcript.ts's module
 * doc, "Exactly how C3 must call this"), factored out here rather than
 * imported from `stop.ts` so `done`/`drop` don't reach into C1's file for
 * a few-line pure builder (this work item's ground rules keep `stop.ts`
 * out of scope; this module is the sanctioned "new src/sessions/ finalize
 * helper" the brief invites).
 *
 * `done`/`drop` are the only two of C3's three commands that finalize a
 * session at all — `slop review` deliberately does NOT (D15's session
 * model, DECISIONS.md's C3 entry): the session stays active across a
 * review round-trip, so `review` only ever folds `transcript_ref` into an
 * otherwise-untouched session, never calling this.
 */
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { Session } from "../core/index.js";
import { EXIT_CODES, nowIso, sessionSchema } from "../core/index.js";
import { SlopError } from "../cli/errors.js";
import { formatZodIssuesForUsage } from "../tickets/validate.js";

/**
 * Build (never persist) `session` ended now, with `summary` (or `null`)
 * as its `end_summary` — `done`'s `--note`, `drop`'s `--reason`.
 * `transcript_ref` is left untouched here on purpose: the caller folds
 * C4's `captureTranscript` result into the SAME candidate object before
 * ever calling `updateSession`, exactly as `stop.ts`/`transcript.ts`'s
 * module doc describe.
 */
export function buildFinalizedSession(
  session: Session,
  summary: string | null,
  clock: Clock = systemClock,
): Session {
  const now = nowIso(clock);
  const candidate = { ...session, ended_at: now, end_summary: summary };
  const parsed = sessionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SlopError(
      formatZodIssuesForUsage("invalid session", parsed.error),
      EXIT_CODES.GENERIC_ERROR,
    );
  }
  return parsed.data;
}
