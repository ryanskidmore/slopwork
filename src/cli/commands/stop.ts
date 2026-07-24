import type { Command } from "commander";
import { END_SUMMARY_MAX_LENGTH, sessionSchema, shortTicketCode } from "../../core/index.js";
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
import { diffSessionPatch, SESSION_END_FIELDS } from "../../sessions/patch.js";
import { assertStoppable, buildStoppedSession, buildStoppedTicket } from "../../sessions/stop.js";
import {
  resolveTranscriptCapture,
  speculativeTranscriptCapture,
} from "../../sessions/transcript.js";
import { diffTicketPatch, TICKET_FIELDS } from "../../tickets/patch.js";
import { loadConfig, resolveActor } from "../actor.js";
import { assertMaxLength, printWarning, sessionOwnershipWarning } from "./shared.js";

interface StopCommandOptions {
  note?: string;
  transcript?: string;
  json?: boolean;
}

/**
 * Every field this command ever patches into an existing session,
 * `stop`'s own end-of-session fields (`ended_at`/`end_summary`, C1) PLUS
 * `transcript_ref` (C4) — folded into the SAME `updateSession` write
 * rather than a second one, since there's no generic "session updated"
 * verb in `EVENT_VERBS` (see `src/sessions/transcript.ts`'s module doc,
 * "Exactly how C3 must call this" — `done`/`review`/`drop` should mirror
 * this exact pattern).
 */
const STOP_SESSION_FIELDS = [...SESSION_END_FIELDS, "transcript_ref"] as const;

export async function runStop(ref: string, opts: StopCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });

  // D1's installed skill makes a handoff note mandatory practice (§5/D16:
  // "a stopped session's transcript is often the most valuable one" — a
  // note is what makes the *next* session fast to resume without having
  // to read that whole transcript). Nudge, don't block: an agent forced to
  // supply *something* would just write a useless placeholder note. The
  // nag itself is deferred to AFTER the transaction commits, below — see
  // nags-print-before-validation-review's doc there — but the length
  // VALIDATION stays here, up front: it's a usage-error check (never
  // prints anything, so it can't misleadingly assert a stop that never
  // happened), and the earlier it runs the less work a doomed call wastes.
  if (opts.note !== undefined && opts.note.trim().length > 0) {
    assertMaxLength("--note", opts.note, END_SUMMARY_MAX_LENGTH);
  }

  const initialTicket = await resolveTicketRef(paths, ref);

  // ticket_01KYAPKRY7XZJ8D8E5V6X5M2QC: a fast, UNLOCKED pre-check against
  // this same `initialTicket` read — same `assertStoppable` the lock below
  // authoritatively enforces, run a second time, early, purely so a `stop`
  // that's clearly going to fail (e.g. the ticket is already in `review`)
  // never reaches the speculative capture below at all. Without this, the
  // speculative capture — which physically copies bytes into
  // `.slop/transcripts/<session.id>.jsonl` — ran unconditionally BEFORE
  // any validation, so a doomed `stop` on a review-state ticket still
  // mutated (or re-copied over) that file on disk and then exited CONFLICT
  // with no event ever describing the change: a real, committed-nowhere
  // side effect from a command that otherwise changed nothing. This catches
  // the common, non-racing case for free; the AUTHORITATIVE check inside
  // `withLock` below is unchanged and is what actually guards correctness
  // — a ticket that changes state in the (narrow) window between this
  // line and the lock is still caught there, same as before this fix,
  // just with the ordinary "speculative capture ran, in-lock check saved
  // us" behavior every other narrow race in this module already accepts
  // (see transcript.ts's Fix 1 doc).
  assertStoppable(initialTicket);

  // Fix 1 (ticket_01KY93E2ZK6Z3TFEBP86ATMW37): locate + copy the harness
  // transcript BEFORE acquiring the db lock — see transcript.ts's
  // top-of-file doc, "Fix 1", for the full rationale. `resolveTicketRef`
  // above already read `initialTicket` unlocked, so this needs no extra
  // ticket read of its own. Reconciled against the AUTHORITATIVE session
  // below via `resolveTranscriptCapture`.
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
    assertStoppable(current);
    const activeSessionId = current.active_session;
    if (activeSessionId === null) {
      // Unreachable: assertStoppable already guards this; kept only for
      // TypeScript's control-flow narrowing below.
      throw new Error("unreachable: assertStoppable should have thrown");
    }
    const session = await readSession(paths, activeSessionId);
    // ticket_01KYAPN9NXY6RPSV6WGR42CJHJ: session ownership is a warning,
    // not an enforced gate — see sessionOwnershipWarning's own doc.
    const ownershipWarning = sessionOwnershipWarning(session, actor);

    const stoppedSession = buildStoppedSession(session, opts.note);

    // C4: locate + copy the harness transcript for THIS session (never the
    // ticket/cwd's "most recent" one — see transcript.ts's module doc on
    // why that would be concurrency-unsound) and fold the result into the
    // SAME session write as ended_at/end_summary. `captureTranscript`
    // itself never throws (structural never-block guarantee, design.md
    // §4.3 / docs/spikes/findings.md §6) — a missing/unfindable transcript
    // degrades to `transcript_ref: null` + a warning printed below, and
    // this `stop` still succeeds. Reuses `speculativeCapture` (captured
    // OUTSIDE this lock, above) when it's still keyed to this exact
    // session; otherwise falls back to an in-lock capture.
    const capture = await resolveTranscriptCapture(speculativeCapture, {
      session,
      paths,
      cwd: root,
      transcriptsMode: config.transcripts,
      explicitTranscriptPath: opts.transcript,
    });
    const finalSession = sessionSchema.parse({
      ...stoppedSession,
      transcript_ref: capture.transcriptRef,
    });

    await updateSession(
      paths,
      session.id,
      diffSessionPatch(session, finalSession, STOP_SESSION_FIELDS),
      finalSession,
      { actor, session: session.id },
      {
        verb: "session.stopped",
        payload: {
          ...(opts.note !== undefined ? { note: opts.note } : {}),
          ...(capture.transcriptRef !== null ? { transcript_ref: capture.transcriptRef } : {}),
        },
      },
    );
    await lock.assertHeld();

    const stoppedTicket = buildStoppedTicket(current, opts.note);
    await updateTicket(
      paths,
      current.id,
      diffTicketPatch(current, stoppedTicket, TICKET_FIELDS),
      stoppedTicket,
      { actor, session: session.id },
      { verb: "ticket.state_changed", payload: { from: current.state, to: stoppedTicket.state } },
    );

    return {
      session: finalSession,
      ticket: stoppedTicket,
      transcriptWarning: capture.warning,
      ownershipWarning,
    };
  });

  // nags-print-before-validation-review: the no-`--note` nag now prints
  // HERE — after the transaction above has already committed — rather
  // than up front before `ref` was even resolved/validated. It used to
  // print unconditionally as soon as `opts.note` was known to be absent,
  // so `slop stop no-such-ticket` (no --note) printed "the next session
  // will have to reconstruct context from scratch" and THEN failed
  // NOT_FOUND — a nag asserting a stop that never happened, same class of
  // bug `review.ts`'s no-`--mr` nag had. Matches `done.ts`'s
  // `skippedReview` nag's position/convention exactly.
  if (opts.note === undefined || opts.note.trim().length === 0) {
    printWarning(
      "no --note handoff given — the next session (or your future self) will have to reconstruct " +
        `context from scratch. Consider \`slop stop ${ref} --note "..."\`.`,
    );
  }

  // Printed AFTER the transaction commits, deliberately: a transcript
  // problem is a warning, never a reason the state change itself could
  // fail (this is the C4 acceptance criterion's second half, made
  // structural — see captureTranscript's own doc). Same convention for
  // the session-ownership warning (sessionOwnershipWarning's own doc).
  if (result.transcriptWarning !== null) printWarning(result.transcriptWarning);
  if (result.ownershipWarning !== null) printWarning(result.ownershipWarning);

  if (opts.json) {
    // closing-loop-commands-lack-json: field names mirror `start --json`'s
    // own `session`/`ticket` split (id/slug/name/state on the ticket;
    // session gets its own `id`), plus `note`/`transcript` naming the two
    // pieces of data this command's own text output already surfaces.
    process.stdout.write(
      `${JSON.stringify(
        {
          id: result.ticket.id,
          slug: result.ticket.slug,
          handle: shortTicketCode(result.ticket.id),
          name: result.ticket.name,
          state: result.ticket.state,
          session_id: result.session.id,
          note: result.session.end_summary,
          transcript: result.session.transcript_ref,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(
    `stopped ${result.session.id} on ${result.ticket.id} (${result.ticket.slug})\n` +
      `  ${result.ticket.name}\n` +
      `  state: ${result.ticket.state}\n` +
      `  handoff note: ${result.session.end_summary ?? "(none)"}\n` +
      `  transcript: ${result.session.transcript_ref ?? "(none)"}\n`,
  );
}

/** `slop stop` — design.md §2, §4.3, D16; work items C1 (state transition)
 * + C4 (transcript capture). */
export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description(
      "End the current session on <ref> without completing it: hands the ticket back to open, " +
        "records a handoff note, and captures the harness transcript into .slop/transcripts/ " +
        "(D16) — never blocks if the transcript can't be found.",
    )
    .argument("<ref>", "ticket to stop")
    .option("--note <text>", "handoff note for the next session")
    .option(
      "--transcript <path>",
      "manual transcript path (works for any harness; overrides auto-detection when the file exists)",
    )
    .option(
      "--json",
      "machine-readable result (id, slug, handle, name, state, session_id, note, transcript)",
    )
    .action(runStop);
}
