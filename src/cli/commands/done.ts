import type { Command } from "commander";
import type { Clock } from "../../core/clock.js";
import { systemClock } from "../../core/clock.js";
import type { Session, Ticket } from "../../core/index.js";
import { EXIT_CODES, nowIso, sessionSchema, ticketSchema } from "../../core/index.js";
import {
  formatIndexProblems,
  readSession,
  readTicket,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
  updateSession,
  updateTicket,
  withLock,
} from "../../repo/index.js";
import { buildFinalizedSession } from "../../sessions/finalize.js";
import { diffSessionPatch, SESSION_END_FIELDS } from "../../sessions/patch.js";
import {
  resolveTranscriptCapture,
  speculativeTranscriptCapture,
} from "../../sessions/transcript.js";
import { cascadeOnClose } from "../../tickets/cascade.js";
import { diffTicketPatch, TICKET_FIELDS } from "../../tickets/patch.js";
import { checkDoneEntry } from "../../tickets/state.js";
import { formatZodIssuesForUsage } from "../../tickets/validate.js";
import { loadConfig, resolveActor } from "../actor.js";
import { SlopError } from "../errors.js";
import { printWarning } from "./shared.js";

interface DoneCommandOptions {
  note?: string;
  transcript?: string;
}

/**
 * Every field this command patches into the active session: `done`'s own
 * end-of-session fields (`ended_at`/`end_summary`) PLUS `transcript_ref`
 * (C4) — one `updateSession` write, matching `stop.ts`'s `STOP_SESSION_FIELDS`
 * (see transcript.ts's module doc, "Exactly how C3 must call this").
 */
const DONE_SESSION_FIELDS = [
  ...SESSION_END_FIELDS,
  "transcript_ref",
] as const satisfies readonly (keyof Session)[];

/**
 * Build (never persist) the ticket as `done` should leave it: `review ->
 * done` (D15/`checkDoneEntry` — the CLI layer below enforces legality
 * before this is ever called), `review` cleared (the schema requires it
 * absent outside `state === "review"`), `active_session` cleared, and
 * `latest_note` updated from `--note` when given (same convention
 * `stop`'s `buildStoppedTicket` uses for its handoff note).
 */
export function buildDoneTicket(
  current: Ticket,
  note: string | undefined,
  clock: Clock = systemClock,
): Ticket {
  const now = nowIso(clock);
  const candidate = {
    ...current,
    state: "done" as const,
    review: undefined,
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

async function runDone(ref: string, opts: DoneCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });

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

    // D15/§2/§5: done is only reachable from review — see
    // DECISIONS.md's C3 entry for why this work item chose to require
    // review rather than allow a direct in_progress -> done shortcut.
    const check = checkDoneEntry(current.state);
    if (!check.ok) {
      throw new SlopError(check.reason ?? "illegal state transition", EXIT_CODES.CONFLICT);
    }

    const activeSessionId = current.active_session;
    if (activeSessionId === null) {
      // Unreachable in practice: a `review`-state ticket always still
      // carries its active session (DECISIONS.md's C3 entry — `slop
      // review` never clears `active_session`, only `slop
      // done`/`drop`/`stop` do, and `stop` refuses a review-state
      // ticket). Kept only for TypeScript narrowing / defense against a
      // hand-edited or otherwise inconsistent db.
      throw new SlopError(
        `ticket "${current.name}" (${current.slug}) is in review but has no active session — the db ` +
          "appears inconsistent (a review-state ticket should always carry one)",
        EXIT_CODES.GENERIC_ERROR,
      );
    }
    const session = await readSession(paths, activeSessionId);

    const finalizedSession = buildFinalizedSession(session, opts.note ?? null);

    // C4's seam (transcript.ts's module doc, "Exactly how C3 must call
    // this"): capture against the PRE-mutation session, fold the result
    // into the SAME session write as ended_at/end_summary. Never blocks —
    // captureTranscript itself never throws; a miss degrades to
    // transcript_ref: null plus a warning printed after the transaction
    // commits, below. Reuses `speculativeCapture` (captured OUTSIDE this
    // lock, above) when it's still keyed to this exact session.
    const capture = await resolveTranscriptCapture(speculativeCapture, {
      session,
      paths,
      cwd: root,
      transcriptsMode: config.transcripts,
      explicitTranscriptPath: opts.transcript,
    });
    const finalSession = sessionSchema.parse({
      ...finalizedSession,
      transcript_ref: capture.transcriptRef,
    });

    await updateSession(
      paths,
      session.id,
      diffSessionPatch(session, finalSession, DONE_SESSION_FIELDS),
      finalSession,
      { actor, session: session.id },
      {
        verb: "session.ended",
        payload: {
          reason: "done",
          ...(opts.note !== undefined ? { note: opts.note } : {}),
          ...(capture.transcriptRef !== null ? { transcript_ref: capture.transcriptRef } : {}),
        },
      },
    );
    await lock.assertHeld();

    const doneTicket = buildDoneTicket(current, opts.note);
    await updateTicket(
      paths,
      current.id,
      diffTicketPatch(current, doneTicket, TICKET_FIELDS),
      doneTicket,
      { actor, session: session.id },
      { verb: "ticket.done", payload: { from: current.state } },
    );
    await lock.assertHeld();

    // B4's done-cascade — called exactly once, right after the terminal
    // state write it depends on, inside this SAME lock acquisition (see
    // cascade.ts's module doc, "Locking contract"). This is what emits
    // `ticket.ready` for any dependent this ticket was blocking.
    const cascade = await cascadeOnClose(paths, current.id, { actor, session: session.id }, lock);

    return {
      session: finalSession,
      ticket: doneTicket,
      transcriptWarning: capture.warning,
      cascade,
    };
  });

  // Printed AFTER the transaction commits — a transcript miss or a
  // corrupt-elsewhere-in-the-db problem is a warning, never a reason
  // `done` itself could fail (same convention as `stop.ts`).
  if (result.transcriptWarning !== null) printWarning(result.transcriptWarning);
  if (result.cascade.problems.length > 0) {
    process.stderr.write(`${formatIndexProblems(result.cascade.problems)}\n`);
  }

  process.stdout.write(
    `done ${result.ticket.id} (${result.ticket.slug})\n` +
      `  ${result.ticket.name}\n` +
      `  state: ${result.ticket.state}\n` +
      `  note: ${result.session.end_summary ?? "(none)"}\n` +
      `  transcript: ${result.session.transcript_ref ?? "(none)"}\n` +
      (result.cascade.unblocked.length > 0
        ? `  unblocked: ${result.cascade.unblocked.join(", ")}\n`
        : ""),
  );
}

/** `slop done` — design.md §2, §4.3, D15, D16; work item C3.
 *
 * `review -> done` only (see `buildDoneTicket`'s doc / DECISIONS.md's C3
 * entry): finalizes the active session (end summary from `--note`,
 * transcript captured per C4), then runs B4's done-cascade exactly once.
 */
export function registerDoneCommand(program: Command): void {
  program
    .command("done")
    .description(
      "Complete <ref> (review -> done only): finalize the session (end summary + transcript per " +
        "D16), cascade unblocks (B4), and mark done.",
    )
    .argument("<ref>", "ticket to complete")
    .option("--note <text>", "completion note")
    .option(
      "--transcript <path>",
      "manual transcript path (works for any harness; overrides auto-detection when the file exists)",
    )
    .action(runDone);
}
