import type { Command } from "commander";
import { END_SUMMARY_MAX_LENGTH } from "../../core/index.js";
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
import { diffTicketPatch, TICKET_FIELDS } from "../../tickets/patch.js";
import { loadConfig, resolveActor } from "../actor.js";
import { assertMaxLength, printWarning, sessionOwnershipWarning, ticketJson } from "./shared.js";

interface StopCommandOptions {
  note?: string;
  json?: boolean;
}

export async function runStop(ref: string, opts: StopCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });

  // D1's installed skill makes a handoff note mandatory practice (§5: a
  // note is what makes the *next* session fast to resume without having
  // to reconstruct context from scratch). Nudge, don't block: an agent forced to
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
  // authoritatively enforces, run a second time, early, so a `stop` that's
  // clearly going to fail (e.g. the ticket is already in `review`) exits
  // before doing any further work. The AUTHORITATIVE check inside
  // `withLock` below is unchanged and is what actually guards correctness
  // — a ticket that changes state in the (narrow) window between this
  // line and the lock is still caught there.
  assertStoppable(initialTicket);

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

    const finalSession = buildStoppedSession(session, opts.note);

    await updateSession(
      paths,
      session.id,
      diffSessionPatch(session, finalSession, SESSION_END_FIELDS),
      finalSession,
      { actor, session: session.id },
      {
        verb: "session.stopped",
        payload: opts.note !== undefined ? { note: opts.note } : {},
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

  // Printed AFTER the transaction commits, deliberately: a session-
  // ownership mismatch is a warning, never a reason the state change
  // itself could fail (sessionOwnershipWarning's own doc).
  if (result.ownershipWarning !== null) printWarning(result.ownershipWarning);

  if (opts.json) {
    // closing-loop-commands-lack-json: field names mirror `start --json`'s
    // own `session`/`ticket` split (id/slug/name/state on the ticket;
    // session gets its own `id`), plus `note` naming the data this
    // command's own text output already surfaces.
    process.stdout.write(
      `${JSON.stringify(
        {
          ticket: ticketJson(result.ticket),
          session: {
            id: result.session.id,
            note: result.session.end_summary,
          },
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
      `  handoff note: ${result.session.end_summary ?? "(none)"}\n`,
  );
}

/** `slop stop` — design.md §2, §4.3; work item C1 (state transition). */
export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description(
      "End the current session on <ref> without completing it: hands the ticket back to open " +
        "and records a handoff note.",
    )
    .argument("<ref>", "ticket to stop")
    .option("--note <text>", "handoff note for the next session")
    .option("--json", "machine-readable result (id, slug, handle, name, state, session_id, note)")
    .action(runStop);
}
