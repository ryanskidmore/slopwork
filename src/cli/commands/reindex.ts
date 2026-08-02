import type { Command } from "commander";
import { EXIT_CODES, nowIso, systemClock, ticketSchema } from "../../core/index.js";
import type { SessionId } from "../../core/index.js";
import { repoPaths, requireRepoRoot } from "../../repo/index.js";
import {
  formatDuplicateSlugProblems,
  formatEventReadProblems,
  formatIndexProblems,
} from "../../storage/backend.js";
import { openStorage } from "../../storage/index.js";
import { diffSessionPatch } from "../../sessions/patch.js";
import { buildHealedSession, findOrphanedActiveSessions } from "../../sessions/repair.js";
import { planSlugHeal } from "../../tickets/slug-heal.js";
import { formatZodIssuesForUsage } from "../../tickets/validate.js";
import { loadConfig, resolveActor } from "../actor.js";
import { SlopError } from "../errors.js";
import { printWarning } from "./shared.js";

interface ReindexOptions {
  strict?: boolean;
  heal?: boolean;
  shardEvents?: boolean;
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
 *
 * G2 (shard-event-storage): `--shard-events` explicitly migrates any
 * flat-layout `events/event_*.jsonc` files into `events/YYYY-MM/` shards
 * (`StorageBackend.migrateEventShards`, month from each event's own ULID
 * timestamp). This NEVER runs implicitly — event files are git-tracked, so
 * the rename should land as a visible, deliberate commit, not something a
 * routine `reindex` does on every repo's behalf. Idempotent: a repeat run
 * (or a repo that's already fully sharded) reports zero files moved.
 *
 * t-trqk9: also reports any DUPLICATE slugs the rebuild detected
 * (`index.slug_problems` — a cross-clone merge that produced two tickets
 * sharing one slug). Detection always runs and is reported loudly on
 * stderr even without `--heal` (never silent — see db-index.ts's own
 * doc); `--heal` additionally repairs it, deterministically: the OLDEST
 * ticket in each duplicated group (by id) keeps the slug, every newer
 * duplicate is re-suffixed via the same `-2`/`-3`/... collision rule
 * `slop new` already uses (`src/tickets/slug-heal.ts`'s `planSlugHeal`),
 * each rename persisted as its own `ticket.updated` event under the write
 * transaction. The index is rebuilt a second time after healing so the
 * final report (and every subsequent read) reflects the repaired slugs.
 */
export async function runReindex(options: ReindexOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const backend = await openStorage(paths);

  if (options.strict) {
    // Fail fast, exactly like any other direct-by-id read: the first
    // unreadable ticket file throws its full, actionable error and
    // nothing else runs — index.jsonc is left untouched. `buildIndex`
    // itself is always fault-tolerant now; --strict is implemented as
    // this up-front gate specifically so `reindex` alone can opt back
    // into the old all-or-nothing behavior.
    await backend.listTickets();
    await backend.listEvents();
  }

  let shardNote = "";
  if (options.shardEvents) {
    const migration = await backend.migrateEventShards();
    shardNote =
      migration.moved > 0
        ? `; migrated ${migration.moved} event(s) into ${migration.shards.length} shard(s) ` +
          `(${migration.shards.join(", ")})`
        : "; no flat-layout events to shard (already fully sharded)";
  }

  let index = await backend.rebuildIndex();

  const swept = await backend.sweepTempFiles();
  const sweptNote = swept.length > 0 ? `; swept ${swept.length} stale temp file(s)` : "";

  if (index.problems.length > 0 || index.event_problems.length > 0) {
    if (index.problems.length > 0) process.stderr.write(`${formatIndexProblems(index.problems)}\n`);
    if (index.event_problems.length > 0) {
      process.stderr.write(`${formatEventReadProblems(index.event_problems)}\n`);
    }
    const skipped = index.problems.length + index.event_problems.length;
    process.stdout.write(
      `reindexed: ${index.tickets.length} ticket(s) rebuilt, ${skipped} skipped due to errors ` +
        `(${index.problems.length} ticket file(s), ${index.event_problems.length} event problem(s)), ` +
        `${Object.keys(index.slugs).length} slug(s)${sweptNote}${shardNote}\n`,
    );
    // sessions/repair.ts's own doc: an unreadable ticket's own
    // active_session is invisible to the referenced-ids set below, which
    // would misreport a genuinely live session as orphaned — a corrupt
    // ticket read makes the scan itself unsound, not just unavailable.
    if (index.problems.length > 0) {
      printWarning(
        "skipped the orphaned-active-session scan: the ticket read above had unreadable file(s), " +
          "so the scan could misreport a genuinely live session as orphaned. Fix the ticket " +
          "problem(s) above and re-run `slop reindex` (with --heal, if repair is needed) once clean.",
      );
    }
    throw new SlopError(
      `reindex finished with ${index.problems.length} unreadable ticket file(s) and ` +
        `${index.event_problems.length} event file problem(s) (see the errors above); ` +
        "fix them and re-run `slop reindex` — everything else was rebuilt and saved successfully",
      EXIT_CODES.GENERIC_ERROR,
    );
  }

  // t-trqk9: duplicate slugs are reported loudly regardless of --heal (same
  // "never silent" posture as the ticket-problems block above); --heal
  // additionally repairs them, deterministically re-suffixing every
  // duplicate but each group's oldest (by id) ticket.
  let slugHealNote = "";
  if (index.slug_problems.length > 0) {
    process.stderr.write(`${formatDuplicateSlugProblems(index.slug_problems)}\n`);
    if (options.heal) {
      const config = await loadConfig(paths);
      const actor = resolveActor({ config, cwd: root });
      const plans = planSlugHeal(index.slug_problems, new Set(Object.keys(index.slugs)));
      await backend.transact(async () => {
        // Fencing contract (lock.ts): re-checked between each write once
        // more than one write is happening under this acquisition, same
        // discipline as the orphaned-session heal loop below.
        for (const plan of plans) {
          const current = await backend.readTicket(plan.id);
          const now = nowIso(systemClock);
          const candidate = { ...current, slug: plan.to, updated_at: now };
          const parsed = ticketSchema.safeParse(candidate);
          if (!parsed.success) {
            throw new SlopError(
              formatZodIssuesForUsage(
                `slug heal produced an invalid ticket for ${plan.id}`,
                parsed.error,
              ),
              EXIT_CODES.GENERIC_ERROR,
            );
          }
          await backend.updateTicket(
            plan.id,
            [
              { path: ["slug"], value: parsed.data.slug },
              { path: ["updated_at"], value: parsed.data.updated_at },
            ],
            parsed.data,
            { actor, session: null },
            {
              verb: "ticket.updated",
              payload: { method: "slug_heal", from: plan.from, to: plan.to },
            },
          );
        }
      });
      // Rebuild so the final report — and every subsequent read — reflects
      // the repaired slugs rather than the pre-heal duplicate-carrying
      // snapshot (slug_problems should now be empty).
      index = await backend.rebuildIndex();
      slugHealNote = `; healed ${plans.length} duplicate slug(s)`;
    } else {
      slugHealNote =
        `; ${index.slug_problems.length} duplicate slug(s) found ` +
        "(run `slop reindex --heal` to re-suffix them)";
    }
  }

  const slugCount = Object.keys(index.slugs).length;

  const referencedActiveSessionIds = new Set<SessionId>(
    index.tickets.flatMap((row) => (row.active_session !== null ? [row.active_session] : [])),
  );
  const sessionScan = await findOrphanedActiveSessions(backend, referencedActiveSessionIds);

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
    await backend.transact(async () => {
      // Every write inside a multi-write transaction re-checks the lock is
      // still held between writes (lock.ts's own doc) — this loop can
      // write one session per orphan, mirroring cascade.ts's identical
      // pattern.
      for (const session of sessionScan.orphans) {
        const healed = buildHealedSession(session);
        await backend.updateSession(
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
    `reindexed: ${index.tickets.length} ticket(s), ${slugCount} slug(s)${sweptNote}${orphanNote}${shardNote}${slugHealNote}\n`,
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
      "also close out any orphaned active sessions found during the scan (sets ended_at + a " +
        "synthesized end_summary, one session.ended event per orphan), AND re-suffix any " +
        "duplicate slugs found (oldest ticket keeps the slug, newer duplicates get -2/-3/...)",
    )
    .option(
      "--shard-events",
      "migrate flat-layout events/event_*.jsonc files into events/YYYY-MM/ shards (idempotent; " +
        "never runs implicitly — see docs/concepts.md)",
    )
    .action(runReindex);
}
