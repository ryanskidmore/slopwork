/**
 * Event entity CRUD over `<root>/.slop/db/events/event_<ulid>.jsonc`
 * (design.md §3). Events are immutable (design.md §4.1 item 4): there is
 * no `updateEvent`, and — as of A4 — no `deleteEvent` either. A3 originally
 * shipped a `deleteEvent` as a plain CRUD-completeness primitive
 * ("test cleanup" per its own doc comment); A4 removes it outright. This
 * work item's brief is explicit: "there should be no supported path to
 * modify or delete an event." Keeping a delete function around at all,
 * even documented as test-only, is exactly the kind of supported path
 * that invites a future caller to reach for it — every other repo-layer
 * test file already cleans up via `rm(scratch, { recursive: true, force:
 * true })` on its whole scratch directory (see e.g. tickets.test.ts), so
 * nothing legitimate is lost by removing it.
 *
 * A4 also lands here:
 *   - {@link EventContext} / {@link MutationEventSpec} / {@link
 *     withMutationEvent} — the emit-on-mutation hook. tickets.ts's
 *     `createTicket`/`updateTicket` and sessions.ts's `createSession`/
 *     `updateSession` are ALL implemented in terms of this function, which
 *     is what makes "every repo mutation produces exactly one event" a
 *     property of calling the repo layer rather than a convention a future
 *     command has to remember to uphold — see those two modules, and
 *     tests/acceptance/A4.test.ts for the property test.
 *   - {@link EventQuery} / {@link queryEvents} — the ULID-cursor
 *     pagination primitive D3's `slop events --since` builds directly on.
 *
 * G2 (shard-event-storage, t-6tqw9) lands here too: a *new* event is now
 * written to `events/YYYY-MM/event_<ulid>.jsonc` — the UTC month of the
 * event's OWN id, per {@link eventShardMonth} — rather than flat in
 * `events/`. This is purely a physical-layout change for one reason: a
 * single flat directory of every event ever written, forever, does not
 * scale the way `tickets/`/`sessions/` do (those stay bounded by the
 * number of *live* entities; events only ever accumulate). Sharding by
 * month keeps any one directory's `readdir` cost bounded by a repo's
 * recent activity, not its entire history.
 *
 * Nothing about the LOGICAL model changes: an event's id is still its
 * only identity, ids still sort chronologically as plain strings, and
 * every read primitive below (`readEvent`, `listEventIds`, `listEvents`,
 * `listEventsTolerant`, `queryEvents`) transparently merges whatever sits
 * flat in `events/` (old events, never migrated — there is no automatic
 * migration, see {@link migrateFlatEventsToShards}) together with every
 * `events/YYYY-MM/` shard, as one seamless collection. No caller of any
 * read primitive needs to know or care which layout a given id's file
 * actually lives in. {@link eventFilePath} is the one deliberate
 * exception: it keeps meaning exactly what it always has (the FLAT path),
 * because tests rely on it to plant/verify flat-layout files directly —
 * see that function's own doc comment.
 *
 * {@link listEventShardDirs} (which shard subdirectories currently exist)
 * and {@link migrateFlatEventsToShards} (an explicit, idempotent,
 * caller-triggered move of every flat event into its shard) are also
 * consumed directly by the flatfile storage driver
 * (src/storage/flatfile.ts) — for its temp-file sweep and its `slop
 * reindex --shard-events`-style migration entry point, respectively. This
 * module does not call either of them automatically from anywhere: no
 * read path and no write path ever migrates a flat file on its own.
 */
import { mkdir, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { decodeTime } from "ulid";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import {
  type Event,
  type EventEntity,
  type EventId,
  eventSchema,
  isEventId,
  newEventId,
  parsePrefixedId,
} from "../core/index.js";
import type {
  EventContext,
  EventQuery,
  ListEventsTolerantResult,
  MutationEventSpec,
} from "../core/storage-contract.js";
export type {
  EventContext,
  EventQuery,
  ListEventsTolerantResult,
  MutationEventSpec,
} from "../core/storage-contract.js";
import type { EventReadProblem } from "../core/db-index.js";
export type { EventReadProblem } from "../core/db-index.js";
import { createEntityFileCanonical, listEntityIds, readEntityFile } from "./entity-file.js";
import {
  findEventInArchives,
  listAllArchivedEventBatches,
  listArchivedTicketIds,
  readTicketArchive,
} from "./event-archive-format.js";
import { isEnoent, readDirSafe } from "./fs-utils.js";
import type { RepoPaths } from "./paths.js";
import {
  type MutationEntity,
  type MutationPreparation,
  commitMutationWithEvent,
  recoverMutationJournals,
} from "./mutation-journal.js";

export type {
  MutationDescriptor,
  MutationEntity,
  MutationPreparation,
} from "./mutation-journal.js";

/**
 * The FLAT path for `id` — `events/<id>.jsonc`, ignoring sharding
 * entirely. Kept meaning exactly this, unconditionally, even though a
 * *new* event is never written here (see {@link createEvent}): several
 * tests deliberately plant a corrupt/poisoned event file at this exact
 * path to verify tolerant reads still skip it gracefully, which is
 * effectively a test of "an old, never-migrated flat event still reads
 * correctly" — a real backward-compatibility property, not an
 * implementation detail. Callers that want wherever `id` ACTUALLY lives
 * (flat or sharded) should go through {@link readEvent}, not this.
 */
export function eventFilePath(paths: RepoPaths, id: EventId): string {
  return join(paths.eventsDir, `${id}.jsonc`);
}

/**
 * The `YYYY-MM` (UTC) month `id` belongs to, per its own embedded ULID
 * timestamp (`ulid`'s `decodeTime`, applied to the raw ULID body after
 * stripping the `event_` prefix — core/ids.ts's `parsePrefixedId`). This
 * is the single source of truth both {@link createEvent} (which month to
 * write a brand-new event into) and every shard-aware read below (which
 * month a given id's file WOULD be in, if it's sharded at all) derive
 * their answer from — never a separately-passed clock reading. The id IS
 * the event's canonical timestamp: an event's `at` field is a
 * human-readable echo of the same moment recorded at mint time
 * (`appendEvent` below), not a second, independently-adjustable source of
 * truth, so re-deriving the shard from the id alone is what lets a
 * caller locate any event's file without needing to already know (or
 * track) which month it landed in.
 */
export function eventShardMonth(id: EventId): string {
  const parsed = parsePrefixedId(id);
  // Unreachable for any real `EventId`: the branded type is only ever
  // produced via `eventIdSchema`'s regex, which `parsePrefixedId` also
  // matches against. Guarded anyway rather than asserting, so a
  // hand-rolled bad cast fails loudly instead of producing a nonsense
  // path silently.
  if (parsed === null) throw new Error(`not a valid event id: ${id}`);
  const at = new Date(decodeTime(parsed.ulid));
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** The sharded DIRECTORY for a given `YYYY-MM` month — `events/<month>/`
 * — regardless of whether it exists yet. Exported for
 * `event-compaction.ts`'s post-compaction emptiness check (t-7eq5s: does
 * this month shard have any loose files left, now that this ticket's were
 * just folded into its archive?) — the one caller outside this module
 * that needs a shard's directory path without already holding a specific
 * event id to derive it from. */
export function shardedEventDirFor(paths: RepoPaths, month: string): string {
  return join(paths.eventsDir, month);
}

/** The sharded path `id` WOULD live at — `events/<eventShardMonth(id)>/<id>.jsonc`
 * — regardless of whether a file actually exists there yet. Private: every
 * external caller wants either the always-flat {@link eventFilePath} or
 * the "wherever it actually is" resolution {@link readEvent}/{@link
 * createEvent} already do internally; nothing outside this module needs
 * to compute a shard path it hasn't verified exists. */
function shardedEventFilePath(paths: RepoPaths, id: EventId): string {
  return join(shardedEventDirFor(paths, eventShardMonth(id)), `${id}.jsonc`);
}

/** Whether a file exists at `path` — `stat`, ENOENT mapped to `false`,
 * anything else rethrown. The existence CHECK this module's shard/flat
 * resolution is built on: deciding where to read by asking "does a file
 * exist here" first, rather than by "try the shard, catch, retry flat",
 * is deliberate — the latter would risk masking a real JSONC-parse or
 * schema-validation error at the correct (existing) path behind a
 * spurious fallback attempt at the other, non-existent one. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

/**
 * Where `id` currently lives LOOSE (flat or sharded), or `null` if it
 * doesn't — never checks archives (t-7eq5s's {@link findEventInArchives}
 * is the archive-side counterpart). The one place `event-compaction.ts`'s
 * `compactTicketEvents` gets a real filesystem path to remove once an
 * event has been safely folded into its ticket's archive; `null` means
 * "already gone" (a benign race with a concurrent/prior compaction
 * attempt), which that caller treats as a no-op, not an error. Same
 * shard-then-flat precedence and same-ULID-decode-failure tolerance as
 * {@link readEvent} — see that function's doc for why.
 */
export async function resolveLooseEventPath(paths: RepoPaths, id: EventId): Promise<string | null> {
  try {
    const shardPath = shardedEventFilePath(paths, id);
    if (await fileExists(shardPath)) return shardPath;
  } catch {
    // Not a valid ULID timestamp — can't have been sharded; fall through
    // to the flat check below.
  }
  const flatPath = eventFilePath(paths, id);
  if (await fileExists(flatPath)) return flatPath;
  return null;
}

/**
 * Read one event by id, transparently across the flat/sharded layout
 * split (module doc above): checks whether `id`'s computed shard path
 * ({@link shardedEventFilePath}) exists first, and reads from there if
 * so; otherwise falls back to the flat path ({@link eventFilePath}) —
 * which is also what gets read (and named in the resulting error) when
 * `id` exists at NEITHER location, preserving `readEntityFile`'s exact
 * "no such file: <path>" NOT_FOUND message and exit code verbatim. The
 * existence check happens up front, via {@link fileExists}, specifically
 * so a genuine parse/validation error at whichever path actually holds
 * `id` propagates as-is rather than risking a masked/retried outcome.
 *
 * `id` here is caller-supplied and not yet confirmed to name a real
 * event (e.g. `slop events --since <cursor>` with a hand-typed or
 * malicious cursor) — unlike {@link createEvent}'s freshly-minted-by-
 * `newEventId` ids, it can be well-formed per {@link isEventId}'s regex
 * (so `eventShardMonth`'s own `parsePrefixedId` call succeeds) yet still
 * fail to actually DECODE as a ULID timestamp: the `ulid` package's
 * `decodeTime` throws for a syntactically valid id whose leading
 * characters encode a timestamp past the ULID spec's valid range (e.g.
 * an id built from all `Z`s). Computing the shard path is therefore
 * wrapped in its own try/catch: a decode failure just means "this id can
 * never have been sharded," so the flat-path fallback below is used
 * instead — which correctly reports NOT_FOUND for a well-formed-but-
 * never-issued id exactly like any other, rather than letting a raw,
 * uncaught `ULIDError` escape this function (and surface as a GENERIC_ERROR,
 * not the NOT_FOUND every other unresolvable id gets).
 *
 * t-7eq5s: when `id` isn't loose ANYWHERE (flat or sharded), one more
 * fallback runs before giving up — {@link findEventInArchives} scans every
 * per-ticket archive for it, since a closed, compacted ticket's events no
 * longer sit at either loose location at all. This is an O(archived
 * tickets) scan, only ever reached for a genuinely archived-only id (see
 * that function's own doc) — every hot, frequently-called read path in
 * this codebase either already has the event in hand from a bulk
 * archive-inclusive read ({@link queryEvents}, {@link listAllEvents}) or
 * never touches archived ids at all by construction (cascade.ts).
 */
export async function readEvent(paths: RepoPaths, id: EventId): Promise<Event> {
  const flatPath = eventFilePath(paths, id);
  let path = flatPath;
  let foundLoose = false;
  try {
    const shardPath = shardedEventFilePath(paths, id);
    if (await fileExists(shardPath)) {
      path = shardPath;
      foundLoose = true;
    }
  } catch {
    // Not a valid ULID timestamp — can't have been sharded; fall through
    // to the flat path, which reports this id's absence normally.
  }
  if (!foundLoose && !(await fileExists(flatPath))) {
    const archived = await findEventInArchives(paths, id);
    if (archived !== null) return archived;
  }
  return readEntityFile(path, eventSchema);
}

/**
 * New event file. Always canonical (machine-only, write-once — jsonc.ts's
 * module doc). Low-level primitive: most callers want {@link
 * withMutationEvent} instead — this function alone just writes whatever
 * `Event` it's handed, with no guarantee it's paired with the mutation it
 * describes.
 *
 * G2 (shard-event-storage): always writes into `event.id`'s shard —
 * `events/<eventShardMonth(event.id)>/event_<ulid>.jsonc` — never flat.
 * No directory-creation step is needed here: `createEntityFileCanonical`
 * (via `atomicWriteFile`, atomic-write.ts) already `mkdir(dir, {recursive:
 * true})`s the target's containing directory before writing, so a
 * brand-new `events/YYYY-MM/` shard springs into existence for free on
 * its first write.
 */
export async function createEvent(paths: RepoPaths, event: Event): Promise<void> {
  await createEntityFileCanonical(shardedEventFilePath(paths, event.id), event);
}

/** A shard subdirectory's name is exactly 4 digits, a hyphen, then 2
 * digits (`YYYY-MM`) — deliberately an exact-shape match, not a loose
 * sniff, so a stray unrelated directory someone drops under `events/`
 * (or a typo'd name) is treated as "not a shard" and skipped rather than
 * scanned as one. */
const SHARD_DIR_NAME_PATTERN = /^\d{4}-\d{2}$/;

/**
 * Every `events/YYYY-MM/` shard subdirectory CURRENTLY on disk, directly
 * under `paths.eventsDir`, as absolute paths sorted ascending (shard
 * names are `YYYY-MM`, so lexical order is also chronological order).
 * Consumed directly by the flatfile storage driver
 * (src/storage/flatfile.ts) to extend its temp-file sweep into every
 * shard, not just the flat `events/` directory itself.
 *
 * Uses {@link readDirSafe} (ENOENT → `[]`) for the top-level listing of
 * `paths.eventsDir` — deliberately preserving an existing, tested
 * property this must NOT regress: if `paths.eventsDir` exists but is a
 * plain FILE rather than a directory, `readdir` throws `ENOTDIR`, which
 * `readDirSafe` does NOT swallow (only `ENOENT` is), so that error still
 * surfaces here too (src/cli/commands/web.test.ts's
 * "web-one-malformed-db-file-500s-every-page-and-leaks-filesystem" test
 * relies on exactly this for `events/` itself). A name matching
 * {@link SHARD_DIR_NAME_PATTERN} is then confirmed to actually BE a
 * directory via `stat` before being counted — a stray FILE that happens
 * to be named e.g. `2026-08` must not be mistaken for a shard.
 */
export async function listEventShardDirs(paths: RepoPaths): Promise<string[]> {
  const names = await readDirSafe(paths.eventsDir);
  const candidates = names.filter((name) => SHARD_DIR_NAME_PATTERN.test(name));
  const dirs: string[] = [];
  await Promise.all(
    candidates.map(async (name) => {
      const full = join(paths.eventsDir, name);
      try {
        const info = await stat(full);
        if (info.isDirectory()) dirs.push(full);
      } catch (err) {
        // Deleted between readdir and stat — a benign race with a
        // concurrent migration/sweep, not an error; just excluded below,
        // same tolerance {@link fingerprintEntityDir} already applies to
        // an analogous readdir-then-stat race.
        if (!isEnoent(err)) throw err;
      }
    }),
  );
  return dirs.sort();
}

/**
 * Event ids present on disk, ascending — this *is* the event-ordering
 * cursor design.md §3 refers to ("event ordering cursors on the event
 * ULID itself"), since ULIDs sort chronologically as plain strings, and
 * core/ids.ts's shared monotonic factory keeps that total and strictly
 * increasing even for ids minted within the same millisecond.
 *
 * G2 (shard-event-storage): the union of ids sitting flat in `events/`
 * (old events, never migrated — {@link listEntityIds} already ignores
 * subdirectories, since it only matches `.jsonc`-suffixed regular
 * filenames from a non-recursive `readdir`) and ids in every
 * `events/YYYY-MM/` shard ({@link listEventShardDirs}), merged and
 * re-sorted. Every caller downstream of this (`listEvents`,
 * `listEventsTolerant`, `queryEvents`) inherits the flat+sharded merge
 * for free, without needing to know which layout any given id is in.
 */
export async function listEventIds(paths: RepoPaths): Promise<EventId[]> {
  const shardDirs = await listEventShardDirs(paths);
  const idLists = await Promise.all([
    listEntityIds(paths.eventsDir, isEventId),
    ...shardDirs.map((dir) => listEntityIds(dir, isEventId)),
  ]);
  return idLists.flat().sort();
}

/** Every event on disk, read and validated, in cursor order. */
export async function listEvents(paths: RepoPaths): Promise<Event[]> {
  const ids = await listEventIds(paths);
  return Promise.all(ids.map((id) => readEvent(paths, id)));
}

/**
 * Like {@link listEvents}, but never throws on a corrupt/unreadable event
 * file: it's silently excluded rather than taking the whole read down —
 * same fault-tolerance policy `tickets.ts`'s `listTicketsTolerant` applies
 * to ticket files (db-index.ts's "Fault tolerance"), applied here so one
 * damaged event file can't stop `buildIndex` from deriving effective
 * `latest_note`/`last_activity_at` (ticket_01KY9RWFM80BKNE2CDX85QMKGS)
 * from every OTHER, perfectly good event. Still in cursor (ascending id /
 * chronological) order — the filtering only ever removes entries, never
 * reorders survivors.
 */
export interface EventDirectoryResult extends ListEventsTolerantResult {
  dir: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Merge directory-local reads into one cursor-ordered result and reject
 * duplicate ids deterministically. Callers put shards before the legacy
 * flat directory, matching {@link readEvent}'s shard-first precedence. */
export function mergeEventReadResults(
  batches: readonly EventDirectoryResult[],
): ListEventsTolerantResult {
  const events: Event[] = [];
  const problems = batches.flatMap((batch) => batch.problems);
  const firstPathById = new Map<string, string>();

  for (const batch of batches) {
    for (const event of batch.events) {
      const path = join(batch.dir, `${event.id}.jsonc`);
      const firstPath = firstPathById.get(event.id);
      if (firstPath !== undefined) {
        problems.push({
          kind: "duplicate_id",
          id: event.id,
          path,
          message: `${path}: duplicate event id ${event.id}; first readable copy is ${firstPath}`,
        });
        continue;
      }
      firstPathById.set(event.id, path);
      events.push(event);
    }
  }

  events.sort((a, b) => a.id.localeCompare(b.id));
  problems.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  return { events, problems };
}

export async function listEventsTolerant(paths: RepoPaths): Promise<ListEventsTolerantResult> {
  const shardDirs = await listEventShardDirs(paths);
  const batches = await Promise.all([
    ...shardDirs.map((dir) => listEventsInDirTolerant(dir, basename(dir))),
    listEventsInDirTolerant(paths.eventsDir),
  ]);
  return mergeEventReadResults(batches);
}

// --- t-7eq5s: archive-inclusive whole-db reads -----------------------------

/**
 * Like {@link listEventsTolerant}, but ALSO merges in every per-ticket
 * archive (event-archive-format.ts) — full historical fidelity regardless
 * of whether a given event currently sits loose or has already been
 * compacted. This is what `StorageBackend.listEventsTolerant()` is wired
 * to (search.ts's note-history scan, `slop questions`'s whole-db
 * elicitations inbox, the web explorer's bulk overlay reads): every
 * caller that wants "the complete event log," not just "today's
 * still-live events."
 *
 * Deliberately a SEPARATE function from {@link listEventsTolerant}, which
 * stays loose-only and UNCHANGED, for the two callers that must never pay
 * archive-scanning cost on their hot paths: db-index.ts's `buildIndex`
 * (see that module's own doc, and this feature's PR body, for why a
 * closed/archived ticket's derived overlay never needs its archived
 * events — anything already archived is provably superseded by the
 * ticket's own close-time baseline; only a RESIDUAL, still-loose event can
 * ever move it, and residual events are — by definition — still covered by
 * the loose-only scan), and `StorageBackend.listLooseEvents()`
 * (cascade.ts's done-cascade dedup check, whose candidates are always
 * currently-open — hence never archived — tickets).
 *
 * Precedence on a duplicate id (the residual-race transitional window, or
 * a resolved cross-clone double-close conflict — see event-archive-format.ts's
 * module doc): the loose copy wins, matching {@link readEvent}'s own
 * shard/flat-over-archive precedence.
 */
export async function listAllEventsTolerant(paths: RepoPaths): Promise<ListEventsTolerantResult> {
  const [looseResult, archiveBatches] = await Promise.all([
    listEventsTolerant(paths),
    listAllArchivedEventBatches(paths),
  ]);
  const merged = mergeEventReadResults([
    { dir: paths.eventsDir, events: looseResult.events, problems: [] },
    ...archiveBatches,
  ]);
  return {
    events: merged.events,
    problems: [...looseResult.problems, ...merged.problems].sort(
      (a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind),
    ),
  };
}

/** Strict counterpart to {@link listAllEventsTolerant} — throws on the
 * first unreadable loose OR archive file (same "direct read, no
 * skip-and-report" posture {@link listEvents} already has for the loose
 * case; extended here to archives too). Wired to
 * `StorageBackend.listEvents()`. */
export async function listAllEvents(paths: RepoPaths): Promise<Event[]> {
  const [looseEvents, ticketIds] = await Promise.all([
    listEvents(paths),
    listArchivedTicketIds(paths),
  ]);
  const archivedEventLists = await Promise.all(ticketIds.map((id) => readTicketArchive(paths, id)));

  const byId = new Map<string, Event>();
  for (const event of looseEvents) byId.set(event.id, event);
  for (const events of archivedEventLists) {
    for (const event of events) {
      if (!byId.has(event.id)) byId.set(event.id, event);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Like {@link listEventsTolerant}, but scoped to ONE directory (the flat
 * `events/` dir itself, or a single `events/YYYY-MM/` shard) rather than
 * the whole merged flat+sharded collection — files are read directly from
 * `dir` (never through {@link readEvent}'s flat/shard resolution, since the
 * caller already knows exactly where they live).
 *
 * ticket_01KY9S0172V8AYCYV9KWS6RC9P (t-6tqw9): this is what lets the
 * flatfile storage driver's read cache (`src/storage/flatfile.ts`) treat
 * each shard as an independent cache entry, keyed on that shard's OWN
 * cheap `{count, digest}` fingerprint (`db-index.ts`'s
 * `computeContentFingerprint`) — a repeat read against a db where only
 * THIS month's shard changed re-parses only this one (bounded) directory,
 * reusing every other month's already-parsed events untouched. Fingerprint
 * cost for an unchanged shard therefore never grows with total historical
 * event count, only with that one shard's own (bounded, ~one calendar
 * month's worth) size.
 */
export async function listEventsInDirTolerant(
  dir: string,
  expectedShard?: string,
): Promise<EventDirectoryResult> {
  const entries = await readDirSafe(dir);
  const files = entries
    .filter((name) => name.endsWith(".jsonc") && !name.startsWith(".tmp-"))
    .sort();
  const events: Event[] = [];
  const problems: EventReadProblem[] = [];

  await Promise.all(
    files.map(async (file) => {
      const path = join(dir, file);
      const id = file.slice(0, -".jsonc".length);
      if (!isEventId(id)) {
        problems.push({
          kind: "invalid_filename",
          id: null,
          path,
          message: `${path}: filename must be a valid event_<ulid>.jsonc`,
        });
        return;
      }

      let event: Event;
      try {
        event = await readEntityFile(path, eventSchema);
      } catch (err) {
        problems.push({ kind: "read_error", id, path, message: errorMessage(err) });
        return;
      }

      if (event.id !== id) {
        problems.push({
          kind: "id_mismatch",
          id,
          path,
          message: `${path}: event payload id ${event.id} does not match filename id ${id}`,
        });
        return;
      }
      let actualShard: string | undefined;
      if (expectedShard !== undefined) {
        try {
          actualShard = eventShardMonth(event.id);
        } catch (err) {
          problems.push({
            kind: "read_error",
            id,
            path,
            message: `${path}: event id does not contain a decodable ULID timestamp (${errorMessage(err)})`,
          });
          return;
        }
      }
      if (expectedShard !== undefined && actualShard !== expectedShard) {
        problems.push({
          kind: "wrong_shard",
          id,
          path,
          message: `${path}: event ${id} belongs in shard ${actualShard}, not ${expectedShard}`,
        });
        return;
      }
      events.push(event);
    }),
  );

  return {
    dir,
    events: events.sort((a, b) => a.id.localeCompare(b.id)),
    problems: problems.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function formatEventReadProblems(problems: readonly EventReadProblem[]): string {
  const header = `${problems.length} event file problem(s) were found; affected events were skipped:`;
  const body = problems.map((problem) => {
    const indented = problem.message
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    return `  - [${problem.kind}] ${problem.path}\n${indented}`;
  });
  return [header, ...body].join("\n");
}

export function warnAboutEventReadProblems(problems: readonly EventReadProblem[]): void {
  if (problems.length > 0) {
    process.stderr.write(`warning: ${formatEventReadProblems(problems)}\n`);
  }
}

// --- A4: emit-on-mutation hook --------------------------------------------

/**
 * Who is acting, and under which session — the two facts every event
 * needs that the repo layer itself can never infer on its own (design.md
 * §4.1 item 4: event carries "actor, session"). `session` is nullable:
 * plenty of mutations happen outside any `start`ed session (e.g. `slop
 * new` run cold, before any session exists).
 *
 * Required — not optional — on every mutating repo-layer call (see
 * tickets.ts/sessions.ts's `createTicket`/`updateTicket`/`createSession`/
 * `updateSession`, all of which take this as a parameter with no
 * default). An optional context that quietly defaulted to some "unknown"
 * actor would make it easy to ship a mutation with a meaningless audit
 * trail entry; requiring it makes omitting it a compile error instead.
 */
// Pure — canonically DEFINED in core/storage-contract.ts (see its own doc)
// so CLI composition can import it without crossing into repo-owned data
// access; re-exported here for compatibility.
export { ticketEventContext } from "../core/storage-contract.js";

/**
 * What varies per call site: which of the 15 {@link EventVerb}s applies
 * (the caller's business — only the command knows whether an update is a
 * plain `ticket.updated` or a `ticket.state_changed`; see event.ts's
 * EVENT_VERBS doc) and any verb-specific payload. Deliberately does NOT
 * include `entity` — the mutation functions in tickets.ts/sessions.ts
 * already know exactly which entity they're writing (it's the same
 * ticket/session the caller is mutating), so asking the caller to repeat
 * it here would just be one more way for a payload to accidentally
 * disagree with the write it's describing.
 */
/**
 * Mint and write exactly one event — no accompanying entity write, no
 * lock. The lock-free counterpart to {@link withMutationEvent} below.
 *
 * ticket_01KY9RWFM80BKNE2CDX85QMKGS: a pure `slop update --progress`
 * call (no other field) is the one mutation-adjacent action that emits an
 * event with NOTHING else to make durable first — the note itself only
 * ever lives in the event, never re-written into the ticket file (see
 * db-index.ts's read-time derivation). Calling this directly, instead of
 * `withMutationEvent`, is what lets that call skip `withLock` entirely:
 * safe for the same reason a brand-new entity file already is
 * (entity-file.ts's `createEntityFileCanonical` doc) — every event's
 * filename is its own freshly-minted ULID, so however many callers race
 * this at once, each writes a distinct file and none can ever collide.
 */
export async function appendEvent(
  paths: RepoPaths,
  ctx: EventContext,
  entity: EventEntity,
  spec: MutationEventSpec,
  clock: Clock = systemClock,
): Promise<Event> {
  const event = buildEvent(ctx, entity, spec, clock);
  await createEvent(paths, event);
  return event;
}

function buildEvent(
  ctx: EventContext,
  entity: EventEntity,
  spec: MutationEventSpec,
  clock: Clock,
): Event {
  return {
    id: newEventId(),
    actor: ctx.actor,
    session: ctx.session,
    verb: spec.verb,
    entity,
    payload: spec.payload ?? {},
    at: clock.now().toISOString(),
  };
}

/**
 * The emit-on-mutation hook itself. It pre-mints the event, durably writes
 * a mutation journal, then drives the journal's idempotent replay. This is
 * the mechanism the acceptance criterion ("every repo mutation in tests
 * produces exactly one ordered event") depends on: tickets.ts's
 * `createTicket`/`updateTicket` and sessions.ts's `createSession`/
 * `updateSession` are ALL implemented in terms of this function, so the
 * guarantee is a property of calling them, not a convention every future
 * caller has to remember to uphold — the same reasoning that put A3's
 * index auto-heal inside `loadIndex` rather than at every read call site.
 *
 * `preparation` produces the exact before/after text after older pending
 * intents have recovered, so a new update never snapshots stale state. A
 * failed preparation creates no journal or event. A failed entity or event
 * write leaves the durable intent for the next storage-open/transaction
 * recovery pass; an already-applied entity or event is accepted only when
 * it exactly matches the intent.
 */
export async function withMutationEvent(
  paths: RepoPaths,
  ctx: EventContext,
  entity: MutationEntity,
  spec: MutationEventSpec,
  preparation: MutationPreparation,
  clock: Clock = systemClock,
): Promise<Event> {
  const event = buildEvent(ctx, entity, spec, clock);
  return commitMutationWithEvent(paths, event, entity, preparation, {
    readEvent,
    createEvent,
  });
}

/** Recover pending mutation journals using this module's event I/O. */
export function recoverMutationEvents(paths: RepoPaths): Promise<Event[]> {
  return recoverMutationJournals(paths, { readEvent, createEvent });
}

// --- A4: ULID cursor query -------------------------------------------------

/**
 * The cursor query D3's `slop events --since <event_…> [--ticket <ref>]
 * [--json]` builds directly on. Always returns events in the same total,
 * stable ULID order {@link listEvents} does (design.md §3: "Event
 * ordering cursors on the event ULID itself").
 *
 * Cursor stability across a ticket `index.jsonc` rebuild holds for free:
 * events are immutable, ordered by their own id, and — deliberately, see
 * db-index.ts and this work item's report — entirely independent of
 * `index.jsonc`'s content fingerprint, so rebuilding the ticket index can
 * never change what this function returns for a given query. See
 * tests/acceptance/A4.test.ts for that property exercised directly.
 *
 * Bounded read (perf): unlike a naive `listEvents` + filter-afterward, this
 * never reads or parses a LOOSE file it doesn't need to. `since` is
 * honored on the id LIST first — ids sort chronologically as plain
 * strings (this module's `listEventIds` doc), so every id `<= since` is
 * dropped before any file is opened, not after. `limit` is honored while
 * collecting matches: with no `ticket` filter the id list itself is
 * truncated to `limit` before reading (so files past the window are never
 * touched at all); with a `ticket` filter — which can't be decided without
 * reading each candidate event — the scan instead stops as soon as
 * `limit` matches have been found, so files past the last match are never
 * touched either. Same events, same order as the old
 * read-everything-then-filter version — this only changes how much gets
 * read.
 *
 * t-7eq5s: ALSO merges in archived events (a closed, compacted ticket's
 * history no longer sits loose at all) — bounded to that ONE ticket's own
 * archive when `ticket` is given (a single extra file, cheap regardless of
 * how much history it holds), or every archive in the db when it isn't
 * (still bounded by closed-ticket COUNT, never by total historical event
 * count — the whole point of compaction). `limit`, when given, is applied
 * to EACH side (loose ids / archived events) independently before merging,
 * not just to the final result: the true top-`limit` of the merged stream
 * can only ever be drawn from the top-`limit` of each side considered
 * alone (interleaving more candidates from the other side can only push a
 * given item's rank up, never down), so slicing both sides to `limit`
 * first is lossless and keeps the loose side's read exactly as bounded as
 * it always was. A duplicate id (the residual cross-clone race window, or
 * a resolved double-close conflict — event-archive-format.ts's module doc)
 * resolves loose-wins, matching {@link readEvent}'s own precedence.
 */
export async function queryEvents(paths: RepoPaths, query: EventQuery = {}): Promise<Event[]> {
  const { since, ticket, limit } = query;

  const ids = await listEventIds(paths);
  let candidateIds: EventId[] = ids;
  if (since !== undefined) {
    candidateIds = candidateIds.filter((id) => id > since);
  }

  let archiveCandidates: Event[] =
    ticket !== undefined
      ? await readTicketArchive(paths, ticket)
      : (await listAllArchivedEventBatches(paths)).flatMap((batch) => batch.events);
  if (since !== undefined) {
    archiveCandidates = archiveCandidates.filter((event) => event.id > since);
  }
  archiveCandidates.sort((a, b) => a.id.localeCompare(b.id));

  if (ticket === undefined) {
    // No per-event predicate beyond `since` — `limit` can bound how many
    // LOOSE files get read at all, not just how many survive a post-hoc
    // slice; the (typically far smaller) archive side is sliced the same
    // way rather than read in full.
    if (limit !== undefined) {
      candidateIds = candidateIds.slice(0, limit);
      archiveCandidates = archiveCandidates.slice(0, limit);
    }
    const looseEvents = await Promise.all(candidateIds.map((id) => readEvent(paths, id)));
    const merged = mergeEventsById(looseEvents, archiveCandidates);
    return limit !== undefined ? merged.slice(0, limit) : merged;
  }

  let looseMatches: Event[];
  if (limit === undefined) {
    // A `ticket` filter can't be decided from the id alone, but with no
    // `limit` every since-filtered candidate has to be read regardless —
    // no early stop is possible — so read them in parallel exactly like
    // the unfiltered branch above, then apply the ticket predicate.
    const candidates = await Promise.all(candidateIds.map((id) => readEvent(paths, id)));
    looseMatches = candidates.filter(
      (event) => event.entity.kind === "ticket" && event.entity.id === ticket,
    );
  } else {
    // `ticket` + `limit` together: which ids match can't be known without
    // reading them, so read candidates in ascending (= cursor) order and
    // stop the moment `limit` matches have been found — still bounded to
    // the since-filtered window above, never the whole log.
    looseMatches = [];
    for (const id of candidateIds) {
      const event = await readEvent(paths, id);
      if (event.entity.kind === "ticket" && event.entity.id === ticket) {
        looseMatches.push(event);
        if (looseMatches.length >= limit) break;
      }
    }
    archiveCandidates = archiveCandidates.slice(0, limit);
  }

  const merged = mergeEventsById(looseMatches, archiveCandidates);
  return limit !== undefined ? merged.slice(0, limit) : merged;
}

/** Union `groups` by event id, earlier groups winning a tie, re-sorted
 * ascending — the one place {@link queryEvents} reconciles loose and
 * archived candidates into a single cursor-ordered result. */
function mergeEventsById(...groups: readonly Event[][]): Event[] {
  const byId = new Map<string, Event>();
  for (const group of groups) {
    for (const event of group) {
      if (!byId.has(event.id)) byId.set(event.id, event);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// --- G2 (shard-event-storage): explicit, opt-in migration -----------------

/**
 * Move every FLAT event file (`events/event_<ulid>.jsonc` — i.e. exactly
 * what `listEntityIds(paths.eventsDir, isEventId)` finds, NOT recursing
 * into any `events/YYYY-MM/` shard, which is by definition already
 * sharded) into its own `events/<eventShardMonth(id)>/` shard, computed
 * from each event's own id exactly like {@link createEvent} does for a
 * brand-new one.
 *
 * A plain `rename`, not copy-then-delete: source and destination are
 * always within the same `events/` directory tree, so this is a same
 * -device move — atomic and cheap, unlike a cross-filesystem move would
 * be. The destination shard directory may not exist yet on a repo's
 * very first migration of a given month, so it's `mkdir(dir, {recursive:
 * true})`ed immediately before each rename — the same self-heal
 * `atomicWriteFile` (atomic-write.ts) already applies to every OTHER
 * entity write, reproduced here by hand since this function moves an
 * existing file rather than writing a new one through that helper.
 *
 * Idempotent and safe to call repeatedly: a second call, with no flat
 * files left to move (either because the first call already moved
 * everything, or because there was never anything flat to begin with),
 * finds an empty flat-id list and returns `{ moved: 0, shards: [] }`
 * without touching anything — including any shard directory that already
 * exists from a previous run, which is left completely alone (nothing
 * moves INTO an already-sharded event, and nothing here ever reads or
 * revisits an already-sharded file).
 *
 * `shards` reports only the labels that received at least one file THIS
 * run — a shard that already existed (from an earlier run, or because
 * some other event was already written there directly) but got nothing
 * new this call is NOT included, so a caller can tell "what actually
 * changed just now" from "what shards exist in total"
 * ({@link listEventShardDirs} answers the latter).
 *
 * Acquires no lock of its own: this is a plain filesystem operation, and
 * the caller (src/storage/flatfile.ts's `migrateEventShards`, which wraps
 * this call in its own `transact`/`withLock`) is responsible for
 * serializing access against concurrent writers. Never invoked
 * automatically from anywhere in this module — no read path and no write
 * path calls this; it only ever runs when something external explicitly
 * asks for it.
 */
export async function migrateFlatEventsToShards(
  paths: RepoPaths,
): Promise<{ moved: number; shards: string[] }> {
  const flatIds = await listEntityIds(paths.eventsDir, isEventId);
  const shardsTouched = new Set<string>();
  let moved = 0;

  for (const id of flatIds) {
    const month = eventShardMonth(id);
    const shardDir = join(paths.eventsDir, month);
    await mkdir(shardDir, { recursive: true });
    await rename(eventFilePath(paths, id), join(shardDir, `${id}.jsonc`));
    shardsTouched.add(month);
    moved++;
  }

  return { moved, shards: [...shardsTouched].sort() };
}
