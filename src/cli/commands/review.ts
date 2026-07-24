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
import { printWarning } from "./shared.js";

interface ReviewCommandOptions {
  mr?: string;
  transcript?: string;
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

  // Normalised once, reused for the nag check below, the ticket build,
  // and the event payload — an empty/whitespace-only --mr is treated the
  // same as an omitted one throughout, rather than failing schema
  // validation later on `reviewSchema`'s `z.url()`.
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

  // D15/§8.1 item 3: --mr is required-WITH-WARNING, not required-with
  // -block — nag on stderr, but still let the transition through (below).
  // Printed early, unconditionally, mirroring stop.ts's --note nag — see
  // that command for the identical rationale.
  if (mr === undefined) {
    printWarning(
      `no --mr given — "${ref}" is entering review with no merge/pull request link attached. This ` +
        "still works (D15), but a human reviewer has nothing to open. Pass --mr <url> when you have " +
        "one, e.g. `slop review " +
        ref +
        " --mr <url>` (or re-run once the MR exists).",
    );
  }

  const initialTicket = await resolveTicketRef(paths, ref);

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

    const check = checkReviewEntry(current.state);
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

  // Printed after the transaction commits — never a reason review itself
  // could fail (same convention as stop.ts/done.ts).
  if (result.transcriptWarning !== null) printWarning(result.transcriptWarning);

  process.stdout.write(
    `${result.ticket.id} (${result.ticket.slug}) moved to review\n` +
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
 */
export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description(
      "Move <ref> from in_progress to review, recording the MR link (--mr is recommended, not required).",
    )
    .argument("<ref>", "ticket to move into review")
    .option("--mr <url>", "merge/pull request URL (strongly recommended, see D15)")
    .option(
      "--transcript <path>",
      "manual transcript path (works for any harness; overrides auto-detection when the file exists)",
    )
    .action(runReview);
}
