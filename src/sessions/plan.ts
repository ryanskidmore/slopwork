/**
 * `slop plan` (C2) — pure domain orchestration for building the {@link
 * Session} objects `plan set/revise` and `--check`/`--uncheck` should
 * produce; same split as `src/sessions/start.ts`/`stop.ts`: this module
 * decides *what* the resulting session should be and whether the operation
 * is legal, `src/cli/commands/plan.ts` owns resolving `<ref>`, locking,
 * writing via `updateSession`, and stdout formatting.
 *
 * design.md §2: "`plan` registers/revises the session's step checklist" —
 * the plan belongs to the ticket's ACTIVE SESSION, not the ticket itself
 * (`Session.plan` is an ordered array of {@link PlanVersion}s — see
 * core/entities/session.ts's doc: "so plan v2 is diffable from v1").
 */
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { PlanStep, PlanVersion, Session, Ticket } from "../core/index.js";
import { EXIT_CODES, nowIso, planVersionSchema, sessionSchema } from "../core/index.js";
import { SlopError } from "../core/errors.js";
import { formatZodIssuesForUsage } from "../tickets/validate.js";

/**
 * `plan` only makes sense against a ticket's active session — "you can't
 * plan work you haven't started" (C2 brief). Deliberately keyed off
 * `ticket.active_session` rather than `ticket.state`, same rationale
 * `stop.ts`'s `assertStoppable` documents: `start`/`stop` are what keep
 * that field in lockstep with real session liveness, so checking it
 * directly is the single source of truth. CONFLICT (6), not NOT_FOUND —
 * the ticket resolved fine; what's missing is a live session on it, a
 * state precondition failure, same class of error `assertStoppable` uses
 * for the mirror-image case.
 */
export function assertHasActiveSession(ticket: Ticket): void {
  if (ticket.active_session === null) {
    throw new SlopError(
      `ticket "${ticket.name}" (${ticket.slug}) has no active session — cannot plan work that ` +
        `hasn't been started. Run \`slop start ${ticket.slug}\` first.`,
      EXIT_CODES.CONFLICT,
    );
  }
}

/**
 * Build the {@link PlanStep}s for a NEW version from raw step text,
 * carrying forward checked state from `previous` (the session's current
 * latest version, or `undefined` on the very first `plan` call).
 *
 * **Documented carry-forward rule:** a step keeps its checked state iff its
 * text is character-for-character identical to a step in `previous`;
 * otherwise it starts unchecked. No fuzzy/similarity matching. Duplicate
 * step text in `previous` is matched in order (first not-yet-claimed
 * occurrence) — the exact same greedy rule `plan-diff.ts`'s
 * `diffPlanVersions` uses, so what this function carries forward and what
 * that function reports as "kept, unchanged" always agree.
 */
export function buildPlanSteps(stepTexts: readonly string[], previous?: PlanVersion): PlanStep[] {
  const claimed = Array.from({ length: previous?.steps.length ?? 0 }, () => false);
  return stepTexts.map((text) => {
    if (previous === undefined) return { text, checked: false };
    const idx = previous.steps.findIndex((s, i) => !claimed[i] && s.text === text);
    if (idx === -1) return { text, checked: false };
    claimed[idx] = true;
    return { text, checked: previous.steps[idx]?.checked ?? false };
  });
}

export interface PlanSetResult {
  session: Session;
  /** `true` for the very first `plan` call on this session (emit
   * `plan.set`); `false` for a revision (emit `plan.revised`). */
  isFirstVersion: boolean;
  /** The newly-appended version. */
  version: PlanVersion;
}

/**
 * Build (never persist) the session as `slop plan <ref> "step 1" ...`
 * should leave it: a NEW {@link PlanVersion} appended to `session.plan` —
 * v1 on the first call, v(N+1) on every later call. Prior versions are
 * never mutated in place — appending, not replacing, is what makes "plan
 * v2 diffable from v1" true (session.ts's doc).
 *
 * Throws a USAGE_ERROR (2) `SlopError` naming the offending step (1-based,
 * matching `--check`/`--uncheck`'s own convention) if any `stepTexts`
 * entry is blank after trimming — checked explicitly, UP FRONT, rather
 * than left for `planVersionSchema`'s `text: z.string().trim().min(1)`
 * to catch: a bare `.parse()` there would throw a raw, uncaught `ZodError`
 * (naming the internal `steps.<N>.text` path, not the user's own `"step
 * N"` CLI argument) straight out of this function — `slop plan <ref> ""`
 * used to dump exactly that JSON array to stderr and exit 1. The trailing
 * `planVersionSchema.safeParse` below is a second, generic backstop for
 * any OTHER future constraint this explicit check doesn't anticipate —
 * same defensive layering `tickets/spec.ts`/`tickets/split.ts` use.
 */
export function buildPlanVersion(
  session: Session,
  stepTexts: readonly string[],
  clock: Clock = systemClock,
): PlanSetResult {
  stepTexts.forEach((text, index) => {
    if (text.trim().length === 0) {
      throw new SlopError(
        `step ${index + 1} is blank — every plan step needs non-empty text, e.g. ` +
          '`slop plan <ref> "step 1" "step 2"`',
        EXIT_CODES.USAGE_ERROR,
      );
    }
  });

  const previous = session.plan.at(-1);
  const steps = buildPlanSteps(stepTexts, previous);
  const parsedVersion = planVersionSchema.safeParse({
    version: (previous?.version ?? 0) + 1,
    steps,
    created_at: nowIso(clock),
  });
  if (!parsedVersion.success) {
    throw new SlopError(
      formatZodIssuesForUsage("invalid plan step(s)", parsedVersion.error),
      EXIT_CODES.USAGE_ERROR,
    );
  }
  const version = parsedVersion.data;

  const candidate = { ...session, plan: [...session.plan, version] };
  const parsed = sessionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SlopError(
      formatZodIssuesForUsage("invalid session", parsed.error),
      EXIT_CODES.GENERIC_ERROR,
    );
  }
  return { session: parsed.data, isFirstVersion: previous === undefined, version };
}

/**
 * Toggle step `stepNumber` (**1-based** — see plan.ts CLI module doc for
 * the rationale) on the CURRENT (latest) plan version, in place.
 * `--check`/`--uncheck` never create a new version (C2 brief: "only new
 * step *content* creates a version") — this replaces just the last element
 * of `session.plan`, leaving every earlier version byte-for-byte
 * untouched.
 *
 * Throws USAGE_ERROR (2): no plan exists yet, or `stepNumber` is out of
 * range for the latest version's step count.
 */
export function buildPlanStepToggle(
  session: Session,
  stepNumber: number,
  checked: boolean,
): Session {
  const latest = session.plan.at(-1);
  if (latest === undefined) {
    throw new SlopError(
      'no plan exists yet for this session — run `slop plan <ref> "step 1" "step 2" ...` first',
      EXIT_CODES.USAGE_ERROR,
    );
  }
  if (!Number.isInteger(stepNumber) || stepNumber < 1 || stepNumber > latest.steps.length) {
    const range = latest.steps.length > 0 ? `1-${latest.steps.length}` : "(no steps)";
    throw new SlopError(
      `step ${stepNumber} is out of range — plan v${latest.version} has ${latest.steps.length} ` +
        `step(s) (valid: ${range})`,
      EXIT_CODES.USAGE_ERROR,
    );
  }

  const steps = latest.steps.map((s, i) => (i === stepNumber - 1 ? { ...s, checked } : s));
  const updatedVersion = planVersionSchema.parse({ ...latest, steps });
  const plan = [...session.plan.slice(0, -1), updatedVersion];

  const candidate = { ...session, plan };
  const parsed = sessionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SlopError(
      formatZodIssuesForUsage("invalid session", parsed.error),
      EXIT_CODES.GENERIC_ERROR,
    );
  }
  return parsed.data;
}
