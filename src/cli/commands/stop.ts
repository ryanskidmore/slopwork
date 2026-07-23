import type { Command } from "commander";
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
import { assertStoppable, buildStoppedSession, buildStoppedTicket } from "../../sessions/stop.js";
import { TICKET_FIELDS, diffTicketPatch } from "../../tickets/patch.js";
import { loadConfig, resolveActor } from "../actor.js";
import { printWarning } from "./shared.js";

interface StopCommandOptions {
  note?: string;
}

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
    await updateSession(
      paths,
      session.id,
      diffSessionPatch(session, stoppedSession),
      stoppedSession,
      { actor, session: session.id },
      { verb: "session.stopped", payload: opts.note !== undefined ? { note: opts.note } : {} },
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

    return { session: stoppedSession, ticket: stoppedTicket };
  });

  process.stdout.write(
    `stopped ${result.session.id} on ${result.ticket.id} (${result.ticket.slug})\n` +
      `  ${result.ticket.name}\n` +
      `  state: ${result.ticket.state}\n` +
      `  handoff note: ${result.session.end_summary ?? "(none)"}\n`,
  );
}

/** `slop stop` — design.md §2, §4.3, D16; work item C1. */
export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description(
      "End the current session on <ref> without completing it: hands the ticket back to open " +
        "and records a handoff note (transcript capture per D16 lands with work item C4).",
    )
    .argument("<ref>", "ticket to stop")
    .option("--note <text>", "handoff note for the next session")
    .action(runStop);
}
