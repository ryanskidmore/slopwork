/**
 * Per-ticket event archive format + read primitives (t-7eq5s: auto-compact
 * events into a per-ticket archive on terminal transitions).
 *
 * ## The design decision: one archive file PER TICKET, not embedded on the
 * ticket entity itself
 *
 * One-file-per-event stays for LIVE tickets — it's load-bearing (conflict
 * -free parallel appends across clones, lock-free `--progress` — see
 * events.ts's module doc and docs/concurrency-and-merging.md). Once a
 * ticket reaches a terminal state (`done`/`dropped`), that per-file
 * granularity is pure overhead: nothing ever appends a NEW event for a
 * closed ticket again (barring the cross-clone residual race documented
 * below), so every one of its historical event files just sits there,
 * forever contributing to `readdir`/parse cost on every read of the
 * `events/` tree it happens to share a shard with.
 *
 * Two places this consolidation could live: embedded as a field on the
 * ticket entity itself, or a separate `events/archive/<ticket_id>.jsonc`
 * file. This module picks the separate file, for one decisive reason —
 * ticket reads are the single HOTTEST path in this codebase (every `list`/
 * `status`/`ready`/`loadIndex()` call reads every ticket file, on every
 * single `slop` invocation), while a ticket's full historical event count
 * only ever matters to a handful of commands (`show`, `events`, the web
 * audit spine). Embedding would mean every bulk ticket read pays to parse
 * a growing blob of history it doesn't need; a separate file means that
 * cost is paid only by the commands that actually want it, and a ticket
 * file's own size stays bounded by its METADATA, not its full lifetime of
 * activity.
 *
 * ## Cross-clone merge story (the other half of "pick the one with the
 * better merge story")
 *
 * Two failure modes to reason about honestly, both already precedented by
 * docs/concurrency-and-merging.md's existing "same-ticket edits are small,
 * ordinary JSONC diffs" story:
 *
 *   - **The NORMAL case: close (clone A) racing an unrelated append (clone
 *     B).** Clone A closes ticket T, compacts T's events into
 *     `archive/T.jsonc`, and deletes the now-archived loose files. Clone B,
 *     unaware T closed yet, appends a genuinely NEW loose event for T (e.g.
 *     a lock-free `update --progress`, or a `question.answered` for a
 *     question T's history already contains). Neither clone's git tree
 *     touches the file the OTHER one touched — A only edits `archive/
 *     T.jsonc` (new file) and deletes pre-existing loose files B never
 *     wrote; B only adds a brand-new loose file (fresh ULID name) A never
 *     saw. Git merges this with ZERO conflicts. The result is a T with its
 *     compacted history in the archive PLUS one residual loose event
 *     sitting in a shard directory — this is NOT corruption, it's the
 *     expected post-merge shape this whole module's read side (and
 *     events.ts, which merges it in transparently) is built to tolerate,
 *     and `slop reindex --compact` (idempotently) folds the residual back
 *     in on the next explicit run.
 *
 *   - **The RARE case: a genuine cross-clone double-close.** The state
 *     machine (tickets/state.ts) makes double-closing a ticket illegal
 *     WITHIN one db — but two clones that haven't seen each other's commits
 *     yet can each legally close the SAME ticket from their own, still-live
 *     local view. Both write DIFFERENT content to `archive/T.jsonc` (each
 *     compacting whatever it locally knew, likely differing by exactly the
 *     one new `ticket.done`/`ticket.dropped`/`session.ended` event each
 *     side minted for its own close) — a real ADD/ADD git conflict, exactly
 *     like the ticket file's own state/`updated_at` fields ALREADY conflict
 *     in this scenario (this is not a NEW class of conflict compaction
 *     introduces, just one more file sharing the same pre-existing "two
 *     clones raced the same entity" story). This is deliberately left as a
 *     normal, human-resolved small-file conflict — resolving it is SAFE
 *     BY CONSTRUCTION: the archive is just a sorted-by-id array of
 *     self-describing, immutable event records, so a human (or a future
 *     `merge=union` git attribute — a documented, not-yet-implemented
 *     follow-up) resolving the conflict by keeping BOTH sides' entries
 *     loses nothing; every read path here dedupes by event id (see
 *     `mergeEventReadResults` in events.ts), so even an accidental
 *     duplicate entry left behind by a clumsy manual resolution is
 *     harmless — it's silently deduped on read, never double-counted,
 *     never double-rendered.
 *
 * Deliberately has NO dependency on events.ts (the reverse is true:
 * events.ts imports this module for its archive-inclusive reads) — this
 * keeps the module graph acyclic (tests/acceptance/G2.test.ts enforces
 * "no production module cycles"). `src/repo/event-compaction.ts` is the
 * one place that needs BOTH this module and events.ts's loose-event
 * primitives together.
 */
import { join } from "node:path";
import { z } from "zod";
import {
  EXIT_CODES,
  type Event,
  eventSchema,
  isTicketId,
  type TicketId,
  ticketIdSchema,
} from "../core/index.js";
import { SlopError } from "../core/errors.js";
import type { EventReadProblem } from "../core/db-index.js";
import { listEntityIds, readEntityFile } from "./entity-file.js";
import type { RepoPaths } from "./paths.js";

/** Bumped only on a genuine shape change — same "fails schema validation,
 * self-heals via the caller's own tolerance" posture every other on-disk
 * schema in this codebase uses (db-index.ts's `INDEX_SCHEMA_VERSION` doc). */
export const EVENT_ARCHIVE_VERSION = 1 as const;

export const eventArchiveSchema = z.object({
  version: z.literal(EVENT_ARCHIVE_VERSION),
  /** Defensive — matches the filename; lets a misplaced/hand-copied
   * archive file be detected rather than silently misattributed. */
  ticket: ticketIdSchema,
  /** Full-fidelity event records, ascending by id (cursor order) — never
   * summaries. Nothing about `slop show`/`slop events`'s rendering may
   * ever depend on whether a given event currently lives here or loose. */
  events: z.array(eventSchema),
});
export type EventArchive = z.infer<typeof eventArchiveSchema>;

export function eventArchiveFilePath(paths: RepoPaths, ticketId: TicketId): string {
  return join(paths.eventArchiveDir, `${ticketId}.jsonc`);
}

/** Every ticket id with an existing archive file — cheap, filename-only. */
export async function listArchivedTicketIds(paths: RepoPaths): Promise<TicketId[]> {
  return listEntityIds(paths.eventArchiveDir, isTicketId);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `ticketId`'s archive, strict: throws (via `readEntityFile`'s own
 * detailed, path-naming `SlopError`) on a corrupt/invalid archive file.
 * `[]` when no archive exists yet (never archived, or a fully-live
 * ticket) — NOT_FOUND is the ordinary, expected absence case here, unlike
 * every OTHER `readEntityFile` caller in this codebase, where a missing
 * file is a genuine caller error.
 */
export async function readTicketArchive(paths: RepoPaths, ticketId: TicketId): Promise<Event[]> {
  try {
    const archive = await readEntityFile(eventArchiveFilePath(paths, ticketId), eventArchiveSchema);
    return archive.events;
  } catch (err) {
    if (err instanceof SlopError && err.exitCode === EXIT_CODES.NOT_FOUND) return [];
    throw err;
  }
}

/** One archive file's contribution to a merged read — same shape as
 * events.ts's `EventDirectoryResult`, with `dir` deliberately set to the
 * archive's own FILE path (not a real directory): the only consumer of
 * `dir` is events.ts's `mergeEventReadResults`, whose duplicate-id
 * diagnostic path synthesis (`join(dir, "<id>.jsonc")`) still
 * unambiguously names the offending archive in that rare diagnostic, even
 * though the synthesized string isn't a path that exists on disk. */
export interface ArchiveEventBatch {
  dir: string;
  events: Event[];
  problems: EventReadProblem[];
}

/**
 * `ticketId`'s archive, tolerant: never throws. A corrupt/invalid archive
 * file is reported as one `read_error` problem (the archive is skipped
 * entirely — same fault-tolerance policy as a corrupt loose event file).
 * An event INSIDE an otherwise-valid archive whose own `entity` doesn't
 * name this archive's ticket is reported as `wrong_shard` (closest
 * existing problem kind to "filed in the wrong place" — reusing it here
 * rather than adding a new enum member avoids an `INDEX_SCHEMA_VERSION`
 * bump, since `index.jsonc`'s own `event_problems` never actually carries
 * archive-sourced problems — db-index.ts's `buildIndex` deliberately never
 * reads archives at all, see events.ts's module doc) and excluded.
 */
export async function readTicketArchiveTolerant(
  paths: RepoPaths,
  ticketId: TicketId,
): Promise<ArchiveEventBatch> {
  const path = eventArchiveFilePath(paths, ticketId);
  let archive: EventArchive;
  try {
    archive = await readEntityFile(path, eventArchiveSchema);
  } catch (err) {
    if (err instanceof SlopError && err.exitCode === EXIT_CODES.NOT_FOUND) {
      return { dir: path, events: [], problems: [] };
    }
    return {
      dir: path,
      events: [],
      problems: [{ kind: "read_error", id: null, path, message: errorMessage(err) }],
    };
  }

  const events: Event[] = [];
  const problems: EventReadProblem[] = [];
  for (const event of archive.events) {
    if (event.entity.kind === "ticket" && event.entity.id !== ticketId) {
      problems.push({
        kind: "wrong_shard",
        id: event.id,
        path,
        message: `${path}: event ${event.id} belongs to ticket ${event.entity.id}, not this archive's own ticket ${ticketId}`,
      });
      continue;
    }
    events.push(event);
  }
  return {
    dir: path,
    events: events.sort((a, b) => a.id.localeCompare(b.id)),
    problems,
  };
}

/** Every archive file's contribution, tolerant, one batch per ticket —
 * the whole-db "every closed ticket's history" superset events.ts's
 * archive-inclusive reads merge in alongside loose events. Cost scales
 * with the number of CLOSED, archived tickets, never with total
 * historical event count — the point of this feature. */
export async function listAllArchivedEventBatches(paths: RepoPaths): Promise<ArchiveEventBatch[]> {
  const ticketIds = await listArchivedTicketIds(paths);
  return Promise.all(ticketIds.map((id) => readTicketArchiveTolerant(paths, id)));
}

/**
 * Find `id` by scanning every archive file's contents — the fallback
 * events.ts's `readEvent` uses when `id` isn't found loose (flat or
 * sharded). O(archived tickets), not O(1): archive filenames are keyed by
 * TICKET id, not event id, so there is no way to compute which archive
 * (if any) holds an arbitrary event id without opening some of them. Only
 * ever reached for a genuinely archived-only id — rare in practice (a
 * `--since` cursor pointing at an old, now-compacted event; a direct
 * `readEvent` on an id whose ticket has since closed) — every hot,
 * frequently-called path in this codebase either already has the event in
 * hand from a bulk archive-inclusive read, or (cascade.ts) never touches
 * archived ids at all by construction (see events.ts's module doc).
 */
export async function findEventInArchives(paths: RepoPaths, id: string): Promise<Event | null> {
  const ticketIds = await listArchivedTicketIds(paths);
  for (const ticketId of ticketIds) {
    const events = await readTicketArchive(paths, ticketId);
    const found = events.find((e) => e.id === id);
    if (found) return found;
  }
  return null;
}
