import type { Command } from "commander";
import type { EventVerb, HarnessKind, Session } from "../../core/index.js";
import { HARNESS_KINDS, harnessKindSchema } from "../../core/index.js";
import {
  createSession,
  readSession,
  readTicket,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
  updateTicket,
  updateSession,
  withLock,
} from "../../repo/index.js";
import { buildContextPackData } from "../../sessions/context-pack.js";
import { captureGit } from "../../sessions/git.js";
import { detectHarness } from "../../sessions/harness.js";
import { diffSessionPatch } from "../../sessions/patch.js";
import {
  activeSessionConflictError,
  assertStartable,
  buildNewSession,
  buildStartedTicket,
  buildSupersededSession,
  describeActiveSession,
} from "../../sessions/start.js";
import { renderContextPack } from "../../tickets/context.js";
import { TICKET_FIELDS, diffTicketPatch } from "../../tickets/patch.js";
import { loadConfig, resolveActor } from "../actor.js";
import { printWarning } from "./shared.js";

interface StartCommandOptions {
  as?: string;
  harness?: HarnessKind;
  takeover?: boolean;
}

/** Validate `--harness` eagerly against the known enum (D17/S1) — a bad
 * value is a usage mistake, so it's rejected here with the full allowed
 * list rather than silently degrading to sniffing (that graceful fallback
 * is reserved for detection *failing*, not for a typo the user can fix). */
function parseHarnessFlag(value: string): HarnessKind {
  const parsed = harnessKindSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`--harness must be one of ${HARNESS_KINDS.join("|")}, got "${value}"`);
  }
  return parsed.data;
}

async function runStart(ref: string, opts: StartCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ asFlag: opts.as, harnessFlag: opts.harness, config, cwd: root });

  const harness = detectHarness({ harnessFlag: opts.harness });
  const git = captureGit(root);

  // Degrade-gracefully warnings (C1 brief: "must warn at worst, never
  // block") — never thrown, just surfaced so the human/agent knows the
  // session's captured context is thinner than usual.
  const warnings: string[] = [];
  if (opts.harness === undefined && harness.kind === "other") {
    warnings.push(
      'could not detect a known harness (claude-code/opencode/codex); recording harness as "other". ' +
        "Pass --harness <kind> to override if you know which one this is.",
    );
  }
  if (git.branch === null && git.commit_at_start === null) {
    warnings.push(
      "no git information captured (not a git repository, or `git` is unavailable here)",
    );
  } else {
    if (git.branch === null)
      warnings.push("HEAD is detached: no branch name captured for this session");
    if (git.commit_at_start === null) {
      warnings.push("repository has no commits yet: commit_at_start not captured");
    }
  }

  // A read outside the lock is fine for surfacing NOT_FOUND/AMBIGUOUS_REF
  // quickly on a cold ref; the decisive re-read that the win/lose decision
  // depends on happens fresh, under the lock, below — this is what makes
  // two concurrent `start`s on the same ticket race-free (see C1's report).
  const initialTicket = await resolveTicketRef(paths, ref);

  const result = await withLock(paths.lockFile, async (lock) => {
    const current = await readTicket(paths, initialTicket.id);
    assertStartable(current);

    let previousSession: Session | null = null;
    if (current.active_session !== null) {
      const existing = await readSession(paths, current.active_session).catch(() => null);
      if (existing !== null && existing.ended_at === null) {
        if (!opts.takeover) {
          throw activeSessionConflictError(current, existing);
        }
        previousSession = existing;
      }
    }

    const session = buildNewSession({ ticket: current.id, actor, harness, git });
    await createSession(
      paths,
      session,
      { actor, session: session.id },
      {
        verb: "session.started",
        payload: { harness: harness.kind, takeover: previousSession !== null },
      },
    );
    await lock.assertHeld();

    const {
      ticket: startedTicket,
      stateChanged,
      reEntry,
    } = buildStartedTicket(current, session.id);
    const ticketVerb: EventVerb = stateChanged ? "ticket.state_changed" : "ticket.updated";
    const ticketPayload: Record<string, unknown> = {};
    if (stateChanged) {
      ticketPayload.from = current.state;
      ticketPayload.to = startedTicket.state;
      if (reEntry) ticketPayload.re_entry = true;
    }
    await updateTicket(
      paths,
      current.id,
      diffTicketPatch(current, startedTicket, TICKET_FIELDS),
      startedTicket,
      { actor, session: session.id },
      { verb: ticketVerb, payload: ticketPayload },
    );

    if (previousSession !== null) {
      await lock.assertHeld();
      const endedPrevious = buildSupersededSession(previousSession, actor);
      await updateSession(
        paths,
        previousSession.id,
        diffSessionPatch(previousSession, endedPrevious),
        endedPrevious,
        { actor, session: session.id },
        {
          verb: "session.takeover",
          payload: { previous_actor: previousSession.actor, new_session: session.id },
        },
      );
    }

    return { session, ticket: startedTicket, previousSession };
  });

  for (const w of warnings) printWarning(w);

  process.stdout.write(
    `started ${result.session.id} on ${result.ticket.id} (${result.ticket.slug})\n` +
      `  ${result.ticket.name}\n` +
      `  actor: ${actor.name} (${actor.kind})\n` +
      `  harness: ${harness.kind}${harness.session_id ? `  session_id=${harness.session_id}` : ""}\n` +
      `  git: branch=${git.branch ?? "(none)"} commit=${git.commit_at_start ?? "(none)"}\n` +
      (result.previousSession !== null
        ? `  took over from ${describeActiveSession(result.previousSession)}\n`
        : ""),
  );

  // §5.2: "one command to full context" — start prints the pack every time.
  const data = await buildContextPackData(paths, result.ticket, config);
  process.stdout.write(`\n${renderContextPack(data)}\n`);
}

/** `slop start` — design.md §2, §4.2, §4.3, D9, D17; work item C1. */
export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description(
      "Start a session on <ref>: creates a session (harness+git capture), moves the " +
        "ticket to in_progress, and prints the context pack.",
    )
    .argument("<ref>", "ticket to start")
    .option("--as <name>", "override actor identity for this session (see D17)")
    .option(
      "--harness <kind>",
      "override harness auto-detection (claude-code|opencode|codex|other)",
      parseHarnessFlag,
    )
    .option("--takeover", "take over a ticket with another active session (logged)")
    .action(runStart);
}
