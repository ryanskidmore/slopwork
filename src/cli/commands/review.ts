import type { Command } from "commander";
import type { Clock } from "../../core/clock.js";
import { systemClock } from "../../core/clock.js";
import type { Actor, Session, Ticket } from "../../core/index.js";
import { EXIT_CODES, mrUrlSchema, nowIso, sessionSchema, ticketSchema } from "../../core/index.js";
import {
  readSession,
  readTicket,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
  updateSession,
  updateTicket,
  withLock,
} from "../../repo/index.js";
import { diffSessionPatch } from "../../sessions/patch.js";
import {
  resolveTranscriptCapture,
  speculativeTranscriptCapture,
} from "../../sessions/transcript.js";
import { diffTicketPatch, TICKET_FIELDS } from "../../tickets/patch.js";
import { checkReviewEntry } from "../../tickets/state.js";
import { formatZodIssuesForUsage } from "../../tickets/validate.js";
import { loadConfig, resolveActor } from "../actor.js";
import { SlopError } from "../errors.js";
import { printWarning, ticketJson } from "./shared.js";

interface ReviewCommandOptions {
  mr?: string;
  transcript?: string;
  json?: boolean;
}

/**
 * `review` only ever patches `transcript_ref` on the active session — it
 * deliberately never ends the session (DECISIONS.md's C3 entry: the
 * session model chosen here keeps a session active across a review
 * round-trip; `done`/`drop`/`stop` are the only three edges that ever set
 * `ended_at`/`end_summary`). See transcript.ts's module doc, "Exactly how
 * C3 must call this", for why this is a narrower field list than
 * `done.ts`/`drop.ts`'s.
 */
const REVIEW_SESSION_FIELDS = ["transcript_ref"] as const satisfies readonly (keyof Session)[];

/**
 * Build (never persist) the ticket as `review --mr` should leave it:
 * `in_progress -> review` (D15/`checkReviewEntry` — the CLI layer below
 * enforces legality before this is ever called), `review` set to
 * `{mr, requested_at, by}` with `mr` present iff `--mr` was given
 * (§8.1 item 3: required-with-warning, never required-with-block).
 *
 * Also used, unchanged, for the `review -> review` MR attach/replace call
 * (review-no-mr-nag-advises, `checkReviewEntry`'s `hasMr` branch): `state`
 * is set to `"review"` regardless of whether `current.state` was already
 * `"review"`, and `review`/`requested_at`/`by` are simply overwritten with
 * the fresh values — an idempotent "this is the MR now" write, not a new
 * review round (no session change, no `re_entry`).
 */
export function buildReviewedTicket(
  current: Ticket,
  mr: string | undefined,
  actor: Actor,
  clock: Clock = systemClock,
): Ticket {
  const now = nowIso(clock);
  const candidate = {
    ...current,
    state: "review" as const,
    review: { mr, requested_at: now, by: actor },
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

export async function runReview(ref: string, opts: ReviewCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });

  // Normalised once, reused for the nag printed AFTER the transaction
  // commits (below — see nags-print-before-validation-review's doc there
  // for why it moved), the ticket build, and the event payload — an
  // empty/whitespace-only --mr is treated the same as an omitted one
  // throughout, rather than failing schema validation later on
  // `reviewSchema`'s `z.url()`.
  const mr = opts.mr !== undefined && opts.mr.trim().length > 0 ? opts.mr.trim() : undefined;

  // Fix 3 (adversarial review): validate --mr's URL shape UP FRONT — before
  // the lock, before resolving <ref>, before any read or write — so a
  // malformed (but non-empty) --mr fails as a plain USAGE_ERROR (exit 2)
  // with zero side effects. Previously this validation only happened
  // inside `buildReviewedTicket`'s `ticketSchema.safeParse` call, which
  // runs AFTER the transaction below already folds `transcript_ref` into
  // the active session (an `updateSession` write + a `review.requested`
  // session event) — an invalid --mr left that write behind (an orphaned
  // session-side event, a wasted transcript capture) for an operation that
  // then failed anyway. `mrUrlSchema` (core/entities/ticket.ts) is the
  // exact same schema `reviewSchema.mr` uses, so this can never be
  // stricter or looser than what would eventually be persisted.
  if (mr !== undefined) {
    const parsedMr = mrUrlSchema.safeParse(mr);
    if (!parsedMr.success) {
      throw new SlopError(
        `--mr "${mr}" is not a valid URL — pass a real merge/pull request link, e.g. ` +
          "https://github.com/org/repo/pull/123",
        EXIT_CODES.USAGE_ERROR,
      );
    }
  }

  const initialTicket = await resolveTicketRef(paths, ref);

  // ticket_01KYAPKRY7XZJ8D8E5V6X5M2QC: a fast, UNLOCKED pre-check against
  // this same `initialTicket` read — same `checkReviewEntry` the lock
  // below authoritatively enforces, run a second time, early, purely so a
  // `review` that's clearly going to fail (e.g. the ticket is ALREADY in
  // review AND no --mr was given — `checkReviewEntry` rejects a bare
  // `review -> review`, though `--mr` given DOES succeed there per
  // review-no-mr-nag-advises, see that function's doc) never reaches the
  // speculative capture below at all. See stop.ts's identical pre-check
  // for the full rationale (the speculative capture physically mutates
  // `.slop/transcripts/<session.id>.jsonl` on disk, so running it
  // unconditionally before any validation left a doomed `review` mutating
  // that file with no event ever describing the change). The
  // AUTHORITATIVE check inside `withLock` below is unchanged and is what
  // actually guards correctness against the narrow race this pre-check
  // can't close on its own.
  const initialCheck = checkReviewEntry(initialTicket.state, mr !== undefined);
  if (!initialCheck.ok) {
    throw new SlopError(initialCheck.reason ?? "illegal state transition", EXIT_CODES.CONFLICT);
  }

  // Fix 1 (ticket_01KY93E2ZK6Z3TFEBP86ATMW37): locate + copy the harness
  // transcript BEFORE acquiring the db lock — see transcript.ts's
  // top-of-file doc, "Fix 1", and stop.ts's identical comment for the
  // full rationale. Reconciled against the AUTHORITATIVE session below
  // via `resolveTranscriptCapture`.
  const speculativeCapture = await speculativeTranscriptCapture(
    paths,
    initialTicket.active_session,
    {
      paths,
      cwd: root,
      transcriptsMode: config.transcripts,
      explicitTranscriptPath: opts.transcript,
    },
  );

  const result = await withLock(paths.lockFile, async (lock) => {
    const current = await readTicket(paths, initialTicket.id);

    const check = checkReviewEntry(current.state, mr !== undefined);
    if (!check.ok) {
      throw new SlopError(check.reason ?? "illegal state transition", EXIT_CODES.CONFLICT);
    }

    const activeSessionId = current.active_session;
    if (activeSessionId === null) {
      // Unreachable in practice: `in_progress` always carries an active
      // session (C1's invariant — `start` sets it, only `stop`/`done`/
      // `drop` clear it, none of which can have run while still
      // `in_progress`). Kept only for TS narrowing / defense against an
      // inconsistent db.
      throw new SlopError(
        `ticket "${current.name}" (${current.slug}) is in_progress but has no active session — the db ` +
          "appears inconsistent",
        EXIT_CODES.GENERIC_ERROR,
      );
    }
    const session = await readSession(paths, activeSessionId);

    // C4's seam (transcript.ts's module doc, "Exactly how C3 must call
    // this"): §4.3 lists `review` as a capture point too, even though it
    // doesn't end the session — capture against the PRE-mutation session,
    // fold transcript_ref into the SAME session write, WITHOUT touching
    // ended_at/end_summary. Reuses `speculativeCapture` (captured OUTSIDE
    // this lock, above) when it's still keyed to this exact session.
    const capture = await resolveTranscriptCapture(speculativeCapture, {
      session,
      paths,
      cwd: root,
      transcriptsMode: config.transcripts,
      explicitTranscriptPath: opts.transcript,
    });
    const finalSession = sessionSchema.parse({
      ...session,
      transcript_ref: capture.transcriptRef,
    });

    await updateSession(
      paths,
      session.id,
      diffSessionPatch(session, finalSession, REVIEW_SESSION_FIELDS),
      finalSession,
      { actor, session: session.id },
      {
        // No dedicated "session updated" verb exists (event.ts's closed
        // EVENT_VERBS) — reuse review.requested for this write too, per
        // transcript.ts's module doc.
        verb: "review.requested",
        payload: capture.transcriptRef !== null ? { transcript_ref: capture.transcriptRef } : {},
      },
    );
    await lock.assertHeld();

    const reviewedTicket = buildReviewedTicket(current, mr, actor);
    await updateTicket(
      paths,
      current.id,
      diffTicketPatch(current, reviewedTicket, TICKET_FIELDS),
      reviewedTicket,
      { actor, session: session.id },
      { verb: "review.requested", payload: { mr: mr ?? null } },
    );

    return { session: finalSession, ticket: reviewedTicket, transcriptWarning: capture.warning };
  });

  // nags-print-before-validation-review: the no-`--mr` nag now prints HERE
  // — after the transaction above has already committed — rather than up
  // front before `ref` was even resolved. It used to print unconditionally
  // as soon as `mr` was known to be absent, so `slop review no-such-ticket`
  // (no --mr) printed "entering review with no merge/pull request link
  // attached" and THEN failed NOT_FOUND: a nag asserting a state change
  // that never happened. D15/§8.1 item 3's required-with-warning
  // philosophy only calls for a nag when the transition genuinely went
  // through with no MR attached — exactly what "printed after `withLock`
  // returns" now guarantees, matching `done.ts`'s `skippedReview` nag
  // (same convention) and `stop.ts`'s identically-relocated `--note` nag.
  if (mr === undefined) {
    printWarning(
      `no --mr given — "${ref}" is entering review with no merge/pull request link attached. This ` +
        "still works (D15), but a human reviewer has nothing to open. Pass --mr <url> when you have " +
        "one, e.g. `slop review " +
        ref +
        " --mr <url>` — that also works to attach/replace the link later, even once " +
        `"${ref}" is already in review.`,
    );
  }

  // Printed after the transaction commits — never a reason review itself
  // could fail (same convention as stop.ts/done.ts).
  if (result.transcriptWarning !== null) printWarning(result.transcriptWarning);

  // review-no-mr-nag-advises: "moved to review" is only accurate for the
  // in_progress -> review edge — the MR attach/replace call (`review
  // -> review`, `checkReviewEntry`'s `hasMr` branch) leaves state
  // unchanged, so its own headline says so instead of implying a
  // transition that didn't happen. `initialTicket` (read before the lock,
  // above) still reflects the PRE-write state here.
  const alreadyInReview = initialTicket.state === "review";

  if (opts.json) {
    // closing-loop-commands-lack-json: field names mirror `show --json`'s
    // ticket sub-shape (`review: {mr, requested_at, by}`, `null` when
    // absent — same "absent optional field -> null" convention `new
    // --json`'s own `parent` uses) rather than flattening `mr`/
    // `requested_at` the way the human-readable text above does.
    process.stdout.write(
      `${JSON.stringify(
        {
          ticket: ticketJson(result.ticket),
          session: {
            id: result.session.id,
            transcript: result.session.transcript_ref,
          },
          review: result.ticket.review
            ? {
                mr: result.ticket.review.mr ?? null,
                requested_at: result.ticket.review.requested_at,
                by: result.ticket.review.by,
              }
            : null,
          already_in_review: alreadyInReview,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const headline = alreadyInReview
    ? `${result.ticket.id} (${result.ticket.slug}) MR link updated (already in review)`
    : `${result.ticket.id} (${result.ticket.slug}) moved to review`;

  process.stdout.write(
    `${headline}\n` +
      `  ${result.ticket.name}\n` +
      `  mr: ${result.ticket.review?.mr ?? "(none)"}\n` +
      `  requested_at: ${result.ticket.review?.requested_at ?? "(unknown)"}\n` +
      `  transcript: ${result.session.transcript_ref ?? "(none)"}\n`,
  );
}

/** `slop review` — design.md §2, D15; work item C3.
 *
 * Moves `in_progress -> review` (see `buildReviewedTicket`'s doc). `--mr`
 * is required-with-warning (D15/§8.1 item 3): omitting it nags on stderr
 * but still lets the transition through, with `review.mr` left absent.
 *
 * Also legal — and the ONLY other legal call — from `review` itself, but
 * only when `--mr` is given: an idempotent attach/replace of the MR link
 * (review-no-mr-nag-advises), not a new review round.
 */
export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description(
      "Move <ref> from in_progress to review, recording the MR link (--mr is recommended, not " +
        "required). Also works on a ticket already in review, given --mr, to attach/replace its MR link.",
    )
    .argument("<ref>", "ticket to move into review")
    .option("--mr <url>", "merge/pull request URL (strongly recommended, see D15)")
    .option(
      "--transcript <path>",
      "manual transcript path (works for any harness; overrides auto-detection when the file exists)",
    )
    .option("--json", "machine-readable result (id, slug, handle, name, state, review, transcript)")
    .action(runReview);
}
