/**
 * The compaction routine itself (t-7eq5s) — folds a ticket's currently
 * -loose events into its per-ticket archive (`event-archive-format.ts`)
 * and removes the now-redundant loose files. Separated from that module
 * so the archive FORMAT/read primitives stay dependency-free (no import
 * of events.ts), while this module — which genuinely needs both "read
 * every loose event" (events.ts) and "read/write this ticket's archive"
 * (event-archive-format.ts) — sits one layer above both, avoiding a cycle
 * (tests/acceptance/G2.test.ts's recursive import-boundary scan).
 *
 * Callers: `done.ts`/`drop.ts`, right after durably writing a ticket's
 * terminal state, inside the SAME write transaction — and `slop reindex
 * --compact`, retroactively, for every already-closed ticket. Both go
 * through `StorageBackend.compactTicketEvents` (src/storage/flatfile.ts),
 * never this module directly.
 */
import { rmdir } from "node:fs/promises";
import type { Event, TicketId } from "../core/index.js";
import {
  eventArchiveFilePath,
  EVENT_ARCHIVE_VERSION,
  type EventArchive,
  readTicketArchive,
} from "./event-archive-format.js";
import { createEntityFileCanonical } from "./entity-file.js";
import { durableRemoveFile } from "./atomic-write.js";
import { isEnoent, isEnotempty, readDirSafe } from "./fs-utils.js";
import type { RepoPaths } from "./paths.js";
import {
  eventShardMonth,
  listEvents,
  resolveLooseEventPath,
  shardedEventDirFor,
} from "./events.js";
import { listSessions } from "./sessions.js";

export interface TicketEventCompactionResult {
  ticket: TicketId;
  /** Loose events newly folded into the archive by THIS call — `0` when
   * there was nothing left to compact (already fully compacted, or a
   * ticket with no events at all). */
  archived: number;
  /** The archive's total event count after this call (previously archived
   * plus newly archived). */
  archiveTotal: number;
  /** `events/YYYY-MM` shard directories removed because compacting this
   * ticket left them with zero remaining loose files — see
   * event-archive-format.ts's module doc, the cross-clone merge story, and
   * this ticket's PR body for what removing these buys. */
  shardsRemoved: string[];
}

/**
 * Every event currently sitting LOOSE (flat or sharded — never already
 * archived) that belongs to `ticketId`: `entity.kind === "ticket" && id
 * === ticketId`, PLUS `entity.kind === "session"` for any session ever
 * tied to this ticket (`session.ticket === ticketId`) — the SAME widening
 * `cli/commands/events.ts`'s `ticketEventPredicate` applies for `events
 * --ticket`, reproduced here so a compacted ticket's archive holds the
 * identical event SET `slop events --ticket <ref>` would have shown before
 * compaction (full audit-spine fidelity, byte-for-byte).
 */
async function looseEventsForTicket(paths: RepoPaths, ticketId: TicketId): Promise<Event[]> {
  const sessions = await listSessions(paths);
  const sessionIds = new Set<string>(
    sessions.filter((s) => s.ticket === ticketId).map((s) => s.id),
  );
  const all = await listEvents(paths); // loose-only (flat + shards) — never reads archives.
  return all.filter(
    (event) =>
      (event.entity.kind === "ticket" && event.entity.id === ticketId) ||
      (event.entity.kind === "session" && sessionIds.has(event.entity.id)),
  );
}

/**
 * Fold every currently-loose event belonging to `ticketId` into its
 * archive, then remove the now-redundant loose files — the core operation
 * both `done`/`drop` (one ticket, right after its terminal-state write,
 * inside the SAME transaction) and `slop reindex --compact` (every
 * already-closed ticket, retroactively) drive.
 *
 * Idempotent and safe to re-run: merges with whatever the archive ALREADY
 * holds (deduping by event id — a residual loose file that's already
 * archived, e.g. from a prior partial run that wrote the archive but
 * hadn't yet deleted every original, is simply skipped rather than
 * duplicated), and reports `archived: 0` with nothing touched when there
 * is genuinely nothing left loose for this ticket.
 *
 * Write ordering matters for crash-safety: the merged archive is written
 * FIRST (one atomic tmp+rename), and only once that succeeds are the
 * now-redundant loose originals removed (best-effort per file). A crash
 * between those two steps leaves some originals still on disk — which is
 * exactly the same, already-tolerated "residual loose event" shape the
 * read side (events.ts) unions transparently; nothing is lost, and the
 * next call (another close attempt, or `reindex --compact`) finishes the
 * job.
 *
 * Does NOT itself check `ticketId`'s state — the caller (done.ts/drop.ts,
 * which only calls this after durably writing the terminal state; reindex
 * --compact, which only calls this for tickets its own scan already
 * confirmed are done/dropped) owns that precondition. Compacting a LIVE
 * ticket's events would be actively wrong (it would rip its
 * still-accumulating history out of the conflict-free per-file layout
 * live tickets depend on), so callers must never invoke this for one.
 */
export async function compactTicketEvents(
  paths: RepoPaths,
  ticketId: TicketId,
): Promise<TicketEventCompactionResult> {
  const [looseCandidates, existingArchived] = await Promise.all([
    looseEventsForTicket(paths, ticketId),
    readTicketArchive(paths, ticketId),
  ]);

  const alreadyArchivedIds = new Set(existingArchived.map((e) => e.id));
  const newlyArchived = looseCandidates.filter((e) => !alreadyArchivedIds.has(e.id));

  if (newlyArchived.length > 0) {
    const merged = [...existingArchived, ...newlyArchived].sort((a, b) => a.id.localeCompare(b.id));
    const archive: EventArchive = {
      version: EVENT_ARCHIVE_VERSION,
      ticket: ticketId,
      events: merged,
    };
    await createEntityFileCanonical(eventArchiveFilePath(paths, ticketId), archive);
  }

  // Archive is durable (or already held everything this call would have
  // written — nothing new to write) — now remove EVERY loose candidate's
  // original, not just the newly-archived ones. This is deliberately not
  // scoped to `newlyArchived`: a crash between "archive written" and
  // "originals deleted" on a PRIOR attempt can leave an event that's
  // already archived still sitting loose too (an accepted, tolerated
  // residual shape — see event-archive-format.ts's module doc) — a
  // re-run must finish deleting THAT stray original as well, or it would
  // linger as a harmless-but-permanent duplicate forever. Best effort per
  // file: a missing original (already removed by an earlier attempt, or a
  // concurrent compaction that won the race) is not an error.
  const touchedShardMonths = new Set<string>();
  for (const event of looseCandidates) {
    const path = await resolveLooseEventPath(paths, event.id);
    if (path === null) continue; // already gone — another concurrent/prior compaction won the race.
    await durableRemoveFile(path, { missing: "ignore" });
    try {
      touchedShardMonths.add(eventShardMonth(event.id));
    } catch {
      // Not a decodable ULID timestamp — this id was never shardable, so
      // it lived flat; nothing to check for shard-directory emptiness.
    }
  }

  const shardsRemoved: string[] = [];
  for (const month of touchedShardMonths) {
    const dir = shardedEventDirFor(paths, month);
    const remaining = await readDirSafe(dir);
    if (remaining.length > 0) continue;
    try {
      await rmdir(dir);
      shardsRemoved.push(month);
    } catch (err) {
      // Benign race (a concurrent write landed a new file in this exact
      // month between the listing above and this rmdir, or the directory
      // was already removed) — never fatal to compaction itself.
      if (!isEnoent(err) && !isEnotempty(err)) throw err;
    }
  }
  shardsRemoved.sort();

  return {
    ticket: ticketId,
    archived: newlyArchived.length,
    // `existingArchived`/`newlyArchived` are disjoint by construction (the
    // latter is exactly `looseCandidates` filtered to ids NOT already in
    // the former), so this is the archive's true final count regardless
    // of whether a write actually happened above.
    archiveTotal: existingArchived.length + newlyArchived.length,
    shardsRemoved,
  };
}
