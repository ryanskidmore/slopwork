import type { Command } from "commander";
import { sessionSchema } from "../../core/index.js";
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
import { printWarning } from "./shared.js";

interface StopCommandOptions {
  note?: string;
  transcript?: string;
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

async function runStop(ref: string, opts: StopCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });

  // D1's installed skill makes a handoff note mandatory practice (§5/D16:
  // "a stopped session's transcript is often the most valuable one" — a
  // note is what makes the *next* session fast to resume without having
  // to read that whole transcript). Nudge, don't block: an agent forced to
  // supply *something* would just write a useless placeholder note.
  if (opts.note === undefined || opts.note.trim().length === 0) {
    printWarning(
      "no --note handoff given — the next session (or your future self) will have to reconstruct " +
        `context from scratch. Consider \`slop stop ${ref} --note "..."\`.`,
    );
  }

  const initialTicket = await resolveTicketRef(paths, ref);

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

    const stoppedSession = buildStoppedSession(session, opts.note);

    // C4: locate + copy the harness transcript for THIS session (never the
    // ticket/cwd's "most recent" one — see transcript.ts's module doc on
    // why that would be concurrency-unsound) and fold the result into the
    // SAME session write as ended_at/end_summary. `captureTranscript`
    // itself never throws (structural never-block guarantee, design.md
    // §4.3 / spikes/findings.md §6) — a missing/unfindable transcript
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

    return { session: finalSession, ticket: stoppedTicket, transcriptWarning: capture.warning };
  });

  // Printed AFTER the transaction commits, deliberately: a transcript
  // problem is a warning, never a reason the state change itself could
  // fail (this is the C4 acceptance criterion's second half, made
  // structural — see captureTranscript's own doc).
  if (result.transcriptWarning !== null) printWarning(result.transcriptWarning);

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
    .action(runStop);
}
