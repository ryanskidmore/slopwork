import type { Command } from "commander";
import { EXIT_CODES } from "../../core/exit-codes.js";
import type { SessionId } from "../../core/index.js";
import {
  formatIndexProblems,
  listTickets,
  rebuildIndex,
  repoPaths,
  requireRepoRoot,
  sweepStaleTempFiles,
  updateSession,
  withLock,
} from "../../repo/index.js";
import { diffSessionPatch } from "../../sessions/patch.js";
import { buildHealedSession, findOrphanedActiveSessions } from "../../sessions/repair.js";
import { loadConfig, resolveActor } from "../actor.js";
import { SlopError } from "../errors.js";
import { printWarning } from "./shared.js";

interface ReindexOptions {
  strict?: boolean;
  heal?: boolean;
}

/**
 * `slop reindex` — design.md §3, D3, D14; work item A3.
 *
 * The recovery path for a corrupt db (D3, D14). Fault-tolerant by default
 * (adversarial-review Finding 3): a single unreadable ticket file no
 * longer aborts the whole run — every good ticket is rebuilt and
 * persisted, every bad one is reported in one pass with its full
 * actionable error (db-index.ts's `formatIndexProblems`, same message
 * quality `readTicket` itself would throw), and the command exits
 * non-zero (`GENERIC_ERROR`, 1) only if any problem remains, so scripts
 * can still branch on success. `--strict` restores the pre-fault
 * -tolerance all-or-nothing behavior for anyone who explicitly wants a
 * hard fail on the first bad file instead.
 *
 * ticket_01KYAPKRJ9RJRJRAV42WCTJET4: also scans for ORPHANED active
 * sessions on every run — sessions with `ended_at: null` that no ticket's
 * `active_session` references, the residual crash-window `start.ts`'s own
 * write-order fix can't fully close (see `sessions/repair.ts`'s module
 * doc for the full rationale and why detection, not prevention, is the
 * right fix here). Detection always runs and is reported in the summary;
 * `--heal` additionally closes each one out (`ended_at`/a synthesized
 * `end_summary`, one `session.ended` event per orphan, same audit trail
 * every other session-ending command leaves). The scan is only trustworthy
 * against a CLEAN ticket read — see below.
 */
export async function runReindex(options: ReindexOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);

  if (options.strict) {
    // Fail fast, exactly like any other direct-by-id read: the first
    // unreadable ticket file throws its full, actionable error and
    // nothing else runs — index.jsonc is left untouched. `buildIndex`
    // itself is always fault-tolerant now; --strict is implemented as
    // this up-front gate specifically so `reindex` alone can opt back
    // into the old all-or-nothing behavior.
    await listTickets(paths);
  }

  const index = await rebuildIndex(paths);

  const swept = await sweepStaleTempFiles([
    paths.dbDir,
    paths.ticketsDir,
    paths.sessionsDir,
    paths.eventsDir,
  ]);

  const slugCount = Object.keys(index.slugs).length;
  const sweptNote = swept.length > 0 ? `; swept ${swept.length} stale temp file(s)` : "";

  if (index.problems.length > 0) {
    process.stderr.write(`${formatIndexProblems(index.problems)}\n`);
    process.stdout.write(
      `reindexed: ${index.tickets.length} ticket(s) rebuilt, ${index.problems.length} skipped due to errors, ${slugCount} slug(s)${sweptNote}\n`,
    );
    // sessions/repair.ts's own doc: an unreadable ticket's own
    // active_session is invisible to the referenced-ids set below, which
    // would misreport a genuinely live session as orphaned — a corrupt
    // ticket read makes the scan itself unsound, not just unavailable.
    printWarning(
      "skipped the orphaned-active-session scan: the ticket read above had unreadable file(s), " +
        "so the scan could misreport a genuinely live session as orphaned. Fix the ticket " +
        "problem(s) above and re-run `slop reindex` (with --heal, if repair is needed) once clean.",
    );
    throw new SlopError(
      `reindex finished with ${index.problems.length} unreadable ticket file(s) (see the errors above); ` +
        "fix them and re-run `slop reindex` — everything else was rebuilt and saved successfully",
      EXIT_CODES.GENERIC_ERROR,
    );
  }

  const referencedActiveSessionIds = new Set<SessionId>(
    index.tickets.flatMap((row) => (row.active_session !== null ? [row.active_session] : [])),
  );
  const sessionScan = await findOrphanedActiveSessions(paths, referencedActiveSessionIds);

  if (sessionScan.problems.length > 0) {
    printWarning(
      `${sessionScan.problems.length} session file(s) could not be read while scanning for ` +
        `orphaned active sessions (skipped, never reported as orphans): ` +
        sessionScan.problems.map((p) => p.path).join(", "),
    );
  }

  let healedCount = 0;
  if (options.heal && sessionScan.orphans.length > 0) {
    const config = await loadConfig(paths);
    const actor = resolveActor({ config, cwd: root });
    await withLock(paths.lockFile, async (lock) => {
      // A3's fencing contract (lock.ts's own doc): "every call site that
      // performs more than one write inside a single withLock block MUST
      // call the handle's assertHeld() between writes" — this loop can
      // write one session per orphan, so every iteration checks back in
      // FIRST, mirroring cascade.ts's identical pattern.
      for (const session of sessionScan.orphans) {
        await lock.assertHeld();
        const healed = buildHealedSession(session);
        await updateSession(
          paths,
          session.id,
          diffSessionPatch(session, healed),
          healed,
          { actor, session: session.id },
          // No dedicated "orphan repaired" verb exists in event.ts's closed
          // EVENT_VERBS — `session.ended` (already used with a `reason` by
          // done.ts/drop.ts) is the natural fit; `reason: "orphan_repair"`
          // distinguishes this from an ordinary done/drop/stop ending.
          { verb: "session.ended", payload: { reason: "orphan_repair" } },
        );
        healedCount++;
      }
    });
  }

  let orphanNote = "";
  if (sessionScan.orphans.length > 0) {
    orphanNote = options.heal
      ? `; healed ${healedCount} orphaned active session(s)`
      : `; ${sessionScan.orphans.length} orphaned active session(s) found (run \`slop reindex --heal\` to close them out)`;
  }

  process.stdout.write(
    `reindexed: ${index.tickets.length} ticket(s), ${slugCount} slug(s)${sweptNote}${orphanNote}\n`,
  );
}

export function registerReindexCommand(program: Command): void {
  program
    .command("reindex")
    .description(
      "Rebuild the derived, gitignored .slop/db/index.jsonc from the tickets, " +
        "sessions, and events on disk, and scan for orphaned active sessions " +
        "(ended_at: null, referenced by no ticket).",
    )
    .option(
      "--strict",
      "fail fast on the first unreadable ticket file instead of skipping it and rebuilding the rest (pre-fault-tolerance behavior)",
    )
    .option(
      "--heal",
      "also close out any orphaned active sessions found during the scan (sets ended_at + a synthesized end_summary, one session.ended event per orphan)",
    )
    .action(runReindex);
}
