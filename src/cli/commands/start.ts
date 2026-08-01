import type { Command } from "commander";
import type { Clock } from "../../core/clock.js";
import { systemClock } from "../../core/clock.js";
import type { EventVerb, HarnessKind, Session, SessionId } from "../../core/index.js";
import {
  EXIT_CODES,
  HARNESS_KINDS,
  harnessKindSchema,
  nowIso,
  sessionSchema,
} from "../../core/index.js";
import {
  createSession,
  readSession,
  readTicket,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
  sessionFilePath,
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
import { SlopError } from "../errors.js";
import { printWarning, ticketJson } from "./shared.js";

interface StartCommandOptions {
  as?: string;
  harness?: HarnessKind;
  takeover?: boolean;
  json?: boolean;
}

/** Validate `--harness` eagerly against the known enum (D17/S1) — a bad
 * value is a usage mistake, so it's rejected here with the full allowed
 * list rather than silently degrading to sniffing (that graceful fallback
 * is reserved for detection *failing*, not for a typo the user can fix).
 * Throws a {@link SlopError} (USAGE_ERROR, exit 2) — E1's exit-code audit
 * fix (see `shared.ts`'s `parseIntegerOption` doc for why a bare `Error`
 * here would silently exit 1 instead of the documented 2). */
function parseHarnessFlag(value: string): HarnessKind {
  const parsed = harnessKindSchema.safeParse(value);
  if (!parsed.success) {
    throw new SlopError(
      `--harness must be one of ${HARNESS_KINDS.join("|")}, got "${value}"`,
      EXIT_CODES.USAGE_ERROR,
    );
  }
  return parsed.data;
}

/**
 * C3's fix to C1's `start`: D15's "changes requested = `slop start` again"
 * re-entry (`review -> in_progress`) leaves the review round's session
 * still ACTIVE by design (`slop review` never ends it — DECISIONS.md's C3
 * entry), so a plain re-`start` finds `current.active_session` pointing
 * at a live (`ended_at: null`) session, exactly like a genuine takeover
 * conflict would. Below, `isReviewReentry` (`current.state === "review"`,
 * the same condition `sessions/start.ts`'s `buildStartedTicket` already
 * uses for its own `reEntry` flag) short-circuits that gate: no
 * `--takeover` is required, and the superseded session is closed out via
 * this function rather than `buildSupersededSession` — same shape (end
 * now, with a summary), but honest wording: nothing was "taken over",
 * the same working ticket just continues under a fresh session because
 * changes were requested. Kept local (not added to `sessions/start.ts`,
 * C1's file, out of this work item's edit scope) since it's a three-line,
 * self-contained builder.
 */
function buildReenteredSession(previous: Session, clock: Clock = systemClock): Session {
  const now = nowIso(clock);
  return sessionSchema.parse({
    ...previous,
    ended_at: now,
    end_summary: "review round ended: changes requested, re-entered via `slop start` (D15)",
  });
}

export async function runStart(ref: string, opts: StartCommandOptions): Promise<void> {
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

    // D15 changes-requested re-entry — see buildReenteredSession's doc
    // above for why this must NOT go through the ordinary --takeover gate.
    const isReviewReentry = current.state === "review";

    let previousSession: Session | null = null;
    // ticket_01KY93E3WYD13E71QM7GHWG1DE (Fix 2): a recorded active
    // session whose file can't be READ (corrupt/missing — as distinct
    // from `current.active_session === null`, i.e. no active session at
    // all) is tracked separately from `previousSession` below, since we
    // can never safely build/patch an "ended previous session" object we
    // never managed to read. Non-null here is what still gates/logs a
    // takeover in that case.
    let unreadableActiveSessionId: SessionId | null = null;
    if (current.active_session !== null) {
      let existing: Session | null = null;
      let readFailed = false;
      try {
        existing = await readSession(paths, current.active_session);
      } catch {
        readFailed = true;
      }

      if (readFailed) {
        // FAIL CLOSED (the actual fix — was
        // `readSession(...).catch(() => null)`, which made an unreadable
        // active-session file indistinguishable from "nothing active" and
        // let `start` silently proceed with no --takeover required and no
        // session.takeover event: exactly the audit-trail gap this ticket
        // closes). We can't know whether the broken file's session was
        // genuinely still active or already ended, so — same as a
        // confirmed-active session — this conservatively requires
        // --takeover to proceed at all. D15 review re-entry is exempted
        // for the same reason it always was (see buildReenteredSession's
        // doc above): it isn't a takeover of someone else's work.
        if (!isReviewReentry) {
          if (!opts.takeover) {
            throw new SlopError(
              `ticket "${current.name}" (${current.slug}) has an active session recorded ` +
                `(${current.active_session}) but that session's file could not be read ` +
                "(missing or corrupt) — refusing to start without --takeover, since another " +
                "session may genuinely still be active.\n" +
                "Pass --takeover to proceed anyway; only do this when a human explicitly " +
                "instructed you to (see .slop/AGENTS.md).",
              EXIT_CODES.CONFLICT,
            );
          }
          // --takeover was passed: proceed, but there is no readable
          // session object to end/patch here (attempting to would either
          // throw on a genuinely missing file — aborting this whole
          // `start` outright — or blindly overwrite an already-broken
          // one) — `previousSession` intentionally stays null; the
          // printWarning after the transaction commits (below, in
          // `runStart`) names the exact broken file so a human can go
          // look, and the `session.started` event below still records
          // this as a takeover via `unreadableActiveSessionId`.
          unreadableActiveSessionId = current.active_session;
        }
      } else if (existing !== null && existing.ended_at === null) {
        if (isReviewReentry) {
          previousSession = existing;
        } else if (!opts.takeover) {
          throw activeSessionConflictError(current, existing);
        } else {
          previousSession = existing;
        }
      }
    }

    const session = buildNewSession({ ticket: current.id, actor, harness, git });
    await createSession(
      paths,
      session,
      { actor, session: session.id },
      {
        verb: "session.started",
        payload: {
          harness: harness.kind,
          // `takeover` stays true ONLY for a genuine --takeover seizure —
          // a review re-entry is ordinary expected usage, not a takeover,
          // even though it mechanically also supersedes a live session.
          // An unreadable-but-recorded active session (Fix 2) still
          // counts: it's the only place that takeover gets logged at all,
          // since there's no readable previous session to end/patch.
          takeover:
            (previousSession !== null || unreadableActiveSessionId !== null) && !isReviewReentry,
          ...(isReviewReentry ? { re_entry: true } : {}),
          ...(unreadableActiveSessionId !== null
            ? { unreadable_previous_session: unreadableActiveSessionId }
            : {}),
        },
      },
    );
    await lock.assertHeld();

    // ticket_01KYAPKRJ9RJRJRAV42WCTJET4: end the SUPERSEDED previous
    // session (if any) BEFORE the ticket write below, not after. This used
    // to run AFTER `updateTicket` — meaning a crash between the ticket
    // write (which already points `active_session` at the brand-new
    // `session` above) and this write left `previousSession` stranded:
    // `ended_at: null` forever, no ticket referencing it any longer (the
    // ticket now points to the NEW session), invisible to every
    // session-aware invariant and never self-healing on retry. Closing it
    // out FIRST instead means the ticket write below is now the ONLY
    // write in this transaction that changes what an unlocked reader
    // (`ready`/`show`/a future `start`'s own conflict check) sees — the
    // "point of no return" — matching `stop.ts`'s already-safe ordering
    // (session write(s) first, ticket write last, see that file's own
    // comment). A crash between this write and the ticket write below
    // now self-heals: the ticket still shows the OLD (now cleanly ended)
    // session as active, so a retried `start` sees `existing.ended_at !==
    // null` and proceeds as an ordinary fresh start, no --takeover needed
    // — see `sessions/start.ts`'s conflict-detection branch.
    //
    // The brand-new `session` created above remains exposed to the SAME
    // kind of window regardless of ordering (a crash between `createSession`
    // and the ticket write leaves it "active forever", referenced by
    // nothing) — that one is structural (the ticket write needs this
    // session's freshly-minted id, so it can never come first) and is
    // instead handled by detection + repair, not write-ordering: see
    // `src/sessions/repair.ts` and `slop reindex --heal`.
    if (previousSession !== null) {
      if (isReviewReentry) {
        const endedPrevious = buildReenteredSession(previousSession);
        await updateSession(
          paths,
          previousSession.id,
          diffSessionPatch(previousSession, endedPrevious),
          endedPrevious,
          { actor, session: session.id },
          {
            // D15/§2's audit-trail requirement ("logged as re-entry") —
            // distinct from a genuine `session.takeover` (see
            // buildReenteredSession's doc for why this is NOT that verb).
            verb: "session.ended",
            payload: { reason: "review_reentry", re_entry: true, new_session: session.id },
          },
        );
      } else {
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
      await lock.assertHeld();
    }

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

    return {
      session,
      ticket: startedTicket,
      previousSession,
      isReviewReentry,
      unreadableActiveSessionId,
    };
  });

  // ticket_01KY93E3WYD13E71QM7GHWG1DE (Fix 2): surfaced AFTER the
  // transaction commits, same posture as `warnings` above — never a
  // reason for `start` itself to fail once --takeover already cleared
  // the gate, but naming the exact broken file so a human/agent can go
  // repair or delete it, per the ticket's "warn naming the unreadable
  // session file" requirement.
  if (result.unreadableActiveSessionId !== null) {
    printWarning(
      `ticket ${result.ticket.id} (${result.ticket.slug}) had an active session recorded ` +
        `(${result.unreadableActiveSessionId}) whose file could not be read (missing or ` +
        `corrupt): ${sessionFilePath(paths, result.unreadableActiveSessionId)}\n` +
        "  proceeded via --takeover, but that broken session could not be ended/logged as " +
        "superseded — only this new session's own session.started event records the takeover. " +
        "Inspect/repair or remove the file above manually.",
    );
  }

  for (const w of warnings) printWarning(w);

  const tookOver =
    (result.previousSession !== null || result.unreadableActiveSessionId !== null) &&
    !result.isReviewReentry;

  if (opts.json) {
    // E1: a small, stable `--json` result — the id/slug an agent's next
    // command needs — NOT the context pack (that's structured `slop
    // context --json`'s job; duplicating it here would just be a second,
    // divergence-prone copy of the same data).
    const body = {
      session: {
        id: result.session.id,
        actor: actor.name,
        harness: harness.kind,
        harness_session_id: harness.session_id,
        started_at: result.session.started_at,
      },
      ticket: ticketJson(result.ticket),
      git: { branch: git.branch, commit_at_start: git.commit_at_start },
      re_entry: result.previousSession !== null && result.isReviewReentry,
      takeover: tookOver,
      warnings,
    };
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `started ${result.session.id} on ${result.ticket.id} (${result.ticket.slug})\n` +
      `  ${result.ticket.name}\n` +
      `  actor: ${actor.name} (${actor.kind})\n` +
      `  harness: ${harness.kind}${harness.session_id ? `  session_id=${harness.session_id}` : ""}\n` +
      `  git: branch=${git.branch ?? "(none)"} commit=${git.commit_at_start ?? "(none)"}\n` +
      (result.previousSession !== null
        ? result.isReviewReentry
          ? `  re-entered from review (changes requested, D15); closed out ${describeActiveSession(result.previousSession)}\n`
          : `  took over from ${describeActiveSession(result.previousSession)}\n`
        : result.unreadableActiveSessionId !== null
          ? `  took over from an active session recorded on this ticket that could not be read ` +
            `(${result.unreadableActiveSessionId}) — see warning above\n`
          : ""),
  );

  // §5.2: "one command to full context" — start prints the pack every time.
  //
  // The session/ticket write above has already committed by this point.
  // ticket_01KY93E32PXJW76FA9CXYAA0B7: `buildContextPackData` now tolerates
  // corrupt/unreadable files elsewhere in the db on its own (see
  // context-pack.ts's doc), but this try/catch is a second, independent
  // guard — belt and suspenders — so that even an unanticipated failure
  // in gathering or rendering the pack can only ever produce a warning,
  // never overturn an already-successful `start` into a non-zero exit
  // (which would send a retrying agent straight into `activeSessionConflict`
  // on the session it just started).
  try {
    const data = await buildContextPackData(paths, result.ticket, config);
    process.stdout.write(`\n${renderContextPack(data)}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printWarning(
      `started ${result.session.id} on ${result.ticket.id}, but could not render the context pack: ${message}`,
    );
  }
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
    .option(
      "--json",
      "machine-readable result (session/ticket ids, git info) — omits the context pack; " +
        "follow up with `slop context <ref> --json` for a structured pack",
    )
    .action(runStart);
}
