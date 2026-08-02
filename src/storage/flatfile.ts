/**
 * The flatfile storage driver (G2, t-y2j03): the original repo layer
 * (`src/repo/`) — atomic tmp+rename writes, tolerant reads, `problems[]`,
 * the self-healing derived index, the `.lock` write transaction — wrapped
 * behind {@link StorageBackend}. This class is a thin delegation layer,
 * not a rewrite: every behavior-bearing line still lives in `src/repo/*`,
 * which is now the driver's private implementation (nothing outside
 * `src/storage/` may import it — tests/acceptance/G2.test.ts enforces
 * that).
 *
 * ## Cross-call read cache (resolves ticket_01KYAVM4GJVG34MC95VDNT7JVQ)
 *
 * The tolerant bulk listings (`listTicketsTolerant`/`listSessionsTolerant`
 * /`listEventsTolerant`) are cached in memory, keyed by the SAME cheap
 * content fingerprints the index auto-heal already trusts
 * (`readdir`/`stat` only — db-index.ts's "Content staleness"). A repeat
 * call against an unchanged directory pays one fingerprint sweep instead
 * of re-reading + re-parsing every file — which is exactly what makes the
 * long-lived `slop web` server stop full-rescanning the db on every
 * request, while a write between requests (this process or a concurrent
 * CLI) changes the fingerprint and is served fresh.
 *
 * Correctness inside one process never rests on the fingerprint alone:
 * every mutation through this driver — and every `transact` entry/exit —
 * drops the cache outright, so a read-after-write in the same process is
 * always a real read. The fingerprint only gates reuse across calls with
 * no interleaved local write, where its known millisecond-granularity
 * caveat is the same one `index.jsonc` itself has always documented
 * (`slop reindex` remains the escape hatch).
 *
 * ## Events specifically: cached PER SHARD, not as one blob
 * (t-6tqw9's acceptance criterion — "fingerprint cost no longer scales
 * with total historical event count for unchanged shards")
 *
 * Tickets/sessions each live in one flat directory, so one fingerprint
 * covers the whole listing. Events are sharded (`events/YYYY-MM/`,
 * events.ts's module doc), so `listEventsTolerant` caches one entry PER
 * shard key (`"events"` for the flat leftovers, `"events/2026-08"` per
 * month — the exact keys `db-index.ts`'s `computeEventsFingerprint`
 * already produces), each keyed on THAT shard's own `{count, digest}`.
 * A repeat call re-parses only the shard(s) whose fingerprint actually
 * changed (typically just the current month, where new events keep
 * landing) and reuses every other month's already-parsed `Event[]`
 * untouched — a years-old repo with dozens of shards pays for re-reading
 * ONE small, bounded month, never a re-scan proportional to its whole
 * history. Contrast this with `listTicketsTolerant`/`listSessionsTolerant`
 * above, which are single cache entries by design (tickets/sessions have
 * no shard concept to subdivide).
 */
import { join } from "node:path";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type {
  Event,
  EventEntity,
  EventId,
  Session,
  SessionId,
  Ticket,
  TicketId,
} from "../core/index.js";
import { isSessionId, isTicketId } from "../core/index.js";
import type { JsoncPatchEntry } from "../core/jsonc.js";
import {
  buildIndex,
  computeEventsFingerprint,
  fingerprintEntityDir,
  loadIndex,
  writeIndex,
} from "../repo/db-index.js";
import type { DbIndex, DirFingerprint, LoadIndexResult } from "../repo/db-index.js";
import {
  appendEvent,
  listEvents,
  listEventShardDirs,
  listEventsInDirTolerant,
  mergeEventReadResults,
  migrateFlatEventsToShards,
  queryEvents,
  readEvent,
  recoverMutationEvents,
} from "../repo/events.js";
import type {
  EventContext,
  EventDirectoryResult,
  EventQuery,
  ListEventsTolerantResult,
  MutationEventSpec,
} from "../repo/events.js";
import { DEFAULT_TIMEOUT_MS, withLock } from "../repo/lock.js";
import { hasPendingMutationJournals } from "../repo/mutation-journal.js";
import { sweepStaleTempFiles } from "../repo/atomic-write.js";
import type { RepoPaths } from "../repo/paths.js";
import { resolveTicketRef, resolveTicketRefs } from "../repo/refs.js";
import {
  createSession,
  listSessions,
  listSessionsTolerant,
  readSession,
  sessionFilePath,
  updateSession,
} from "../repo/sessions.js";
import type { ListSessionsTolerantResult } from "../repo/sessions.js";
import {
  createTicket,
  listTickets,
  listTicketsTolerant,
  readTicket,
  ticketFilePath,
  updateTicket,
} from "../repo/tickets.js";
import type { ListTicketsTolerantResult } from "../repo/tickets.js";
import type { EventShardMigrationResult, StorageBackend, StorageTxScope } from "./backend.js";

export interface FlatfileBackendOptions {
  /** Write-lock acquisition timeout, from config.yaml's `defaults.lock_timeout` (default 5s). */
  lockTimeoutMs?: number;
}

const TX_SCOPE: StorageTxScope = { kind: "storage-transaction" };

/** One fingerprint-keyed cached value — see the module doc's cache section. */
interface CacheEntry<T> {
  key: string;
  value: T;
}

function fingerprintKey(fp: DirFingerprint): string {
  return `${fp.count}:${fp.digest}`;
}

export class FlatfileBackend implements StorageBackend {
  readonly kind = "flatfile" as const;
  readonly lockTimeoutMs: number;

  private ticketsCache: CacheEntry<ListTicketsTolerantResult> | null = null;
  private sessionsCache: CacheEntry<ListSessionsTolerantResult> | null = null;
  /** One entry per event shard key (`"events"`, `"events/YYYY-MM"`) — see
   * the module doc's "Events specifically: cached PER SHARD" section. */
  private eventShardCache = new Map<string, CacheEntry<EventDirectoryResult>>();

  constructor(
    /** The flatfile layout under this repo's `.slop/` — driver-internal;
     * commands never touch it (they only see {@link StorageBackend}). */
    readonly paths: RepoPaths,
    options: FlatfileBackendOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Any local mutation invalidates every cached listing — see module doc. */
  private invalidateCaches(): void {
    this.ticketsCache = null;
    this.sessionsCache = null;
    this.eventShardCache.clear();
  }

  // --- tickets ---------------------------------------------------------

  readTicket(id: TicketId): Promise<Ticket> {
    return readTicket(this.paths, id);
  }

  listTickets(): Promise<Ticket[]> {
    return listTickets(this.paths);
  }

  async listTicketsTolerant(): Promise<ListTicketsTolerantResult> {
    const key = fingerprintKey(await fingerprintEntityDir(this.paths.ticketsDir, isTicketId));
    if (this.ticketsCache?.key === key) return this.ticketsCache.value;
    const value = await listTicketsTolerant(this.paths);
    this.ticketsCache = { key, value };
    return value;
  }

  async createTicket(
    ticket: Ticket,
    ctx: EventContext,
    event: MutationEventSpec,
    clock: Clock = systemClock,
  ): Promise<Event> {
    this.invalidateCaches();
    return createTicket(this.paths, ticket, ctx, event, clock);
  }

  async updateTicket(
    id: TicketId,
    patch: JsoncPatchEntry[],
    expectedAfter: Ticket,
    ctx: EventContext,
    event: MutationEventSpec,
    clock: Clock = systemClock,
  ): Promise<Event> {
    this.invalidateCaches();
    return updateTicket(this.paths, id, patch, expectedAfter, ctx, event, clock);
  }

  // --- sessions --------------------------------------------------------

  readSession(id: SessionId): Promise<Session> {
    return readSession(this.paths, id);
  }

  listSessions(): Promise<Session[]> {
    return listSessions(this.paths);
  }

  async listSessionsTolerant(): Promise<ListSessionsTolerantResult> {
    const key = fingerprintKey(await fingerprintEntityDir(this.paths.sessionsDir, isSessionId));
    if (this.sessionsCache?.key === key) return this.sessionsCache.value;
    const value = await listSessionsTolerant(this.paths);
    this.sessionsCache = { key, value };
    return value;
  }

  async createSession(
    session: Session,
    ctx: EventContext,
    event: MutationEventSpec,
    clock: Clock = systemClock,
  ): Promise<Event> {
    this.invalidateCaches();
    return createSession(this.paths, session, ctx, event, clock);
  }

  async updateSession(
    id: SessionId,
    patch: JsoncPatchEntry[],
    expectedAfter: Session,
    ctx: EventContext,
    event: MutationEventSpec,
    clock: Clock = systemClock,
  ): Promise<Event> {
    this.invalidateCaches();
    return updateSession(this.paths, id, patch, expectedAfter, ctx, event, clock);
  }

  // --- events ----------------------------------------------------------

  readEvent(id: EventId): Promise<Event> {
    return readEvent(this.paths, id);
  }

  async appendEvent(
    ctx: EventContext,
    entity: EventEntity,
    spec: MutationEventSpec,
    clock: Clock = systemClock,
  ): Promise<Event> {
    this.invalidateCaches();
    return appendEvent(this.paths, ctx, entity, spec, clock);
  }

  queryEvents(query: EventQuery = {}): Promise<Event[]> {
    return queryEvents(this.paths, query);
  }

  listEvents(): Promise<Event[]> {
    return listEvents(this.paths);
  }

  /**
   * Per-shard incremental cache (module doc, "Events specifically") — the
   * flat `events/` fingerprint plus one per `events/YYYY-MM` shard
   * currently on disk (the exact keys `computeEventsFingerprint` already
   * produces, reused directly rather than re-deriving shard discovery a
   * second time here). A shard whose fingerprint hasn't moved since the
   * last call is served from cache untouched; only a changed (or
   * never-seen) shard is actually read + parsed.
   */
  async listEventsTolerant(): Promise<ListEventsTolerantResult> {
    const fp = await computeEventsFingerprint(this.paths);
    const shardEntries = Object.entries(fp)
      // Preserve readEvent's shard-first precedence when an id exists in
      // both layouts; the duplicate flat copy becomes the problem.
      .sort(([a], [b]) => {
        if (a === "events") return 1;
        if (b === "events") return -1;
        return a.localeCompare(b);
      });

    const perShard = await Promise.all(
      shardEntries.map(async ([key, dirFp]) => {
        const cached = this.eventShardCache.get(key);
        const cacheKey = fingerprintKey(dirFp);
        if (cached?.key === cacheKey) return cached.value;
        const dir =
          key === "events"
            ? this.paths.eventsDir
            : join(this.paths.eventsDir, key.slice("events/".length));
        const result = await listEventsInDirTolerant(
          dir,
          key === "events" ? undefined : key.slice("events/".length),
        );
        // A damaged shard is deliberately never cached. Its cheap
        // count/max-id fingerprint can stay unchanged after an in-place
        // repair, so re-reading is required for repair visibility.
        if (result.problems.length === 0) {
          this.eventShardCache.set(key, { key: cacheKey, value: result });
        } else {
          this.eventShardCache.delete(key);
        }
        return result;
      }),
    );

    // Drop cache entries for shard keys no longer present at all (events
    // are never deleted and shards are never removed once created, but
    // being defensive against a hand-deleted shard directory costs
    // nothing and keeps this map from growing unboundedly stale).
    const currentKeys = new Set(shardEntries.map(([key]) => key));
    for (const key of this.eventShardCache.keys()) {
      if (!currentKeys.has(key)) this.eventShardCache.delete(key);
    }

    return mergeEventReadResults(perShard);
  }

  // --- ref resolution --------------------------------------------------

  resolveTicketRef(ref: string): Promise<Ticket> {
    return resolveTicketRef(this.paths, ref);
  }

  resolveTicketRefs(refs: string[]): Promise<Ticket[]> {
    return resolveTicketRefs(this.paths, refs);
  }

  // --- derived index ---------------------------------------------------

  loadIndex(clock: Clock = systemClock): Promise<LoadIndexResult> {
    return loadIndex(this.paths, clock);
  }

  async rebuildIndex(clock: Clock = systemClock): Promise<DbIndex> {
    const index = await buildIndex(this.paths, clock);
    await writeIndex(this.paths, index);
    return index;
  }

  // --- transactions ----------------------------------------------------

  async transact<T>(fn: (tx: StorageTxScope) => Promise<T>): Promise<T> {
    // Invalidate on entry AND exit: whatever another process wrote while
    // we waited on the lock, and whatever fn itself wrote, must never be
    // served from a pre-transaction cache.
    this.invalidateCaches();
    try {
      return await withLock(
        this.paths.lockFile,
        async () => {
          await recoverMutationEvents(this.paths);
          return fn(TX_SCOPE);
        },
        { timeoutMs: this.lockTimeoutMs },
      );
    } finally {
      this.invalidateCaches();
    }
  }

  /** Recover local pending intents, taking the write lock only when needed. */
  async recoverPendingMutations(): Promise<Event[]> {
    if (!(await hasPendingMutationJournals(this.paths))) return [];
    this.invalidateCaches();
    try {
      return await withLock(this.paths.lockFile, () => recoverMutationEvents(this.paths), {
        timeoutMs: this.lockTimeoutMs,
      });
    } finally {
      this.invalidateCaches();
    }
  }

  // --- maintenance -----------------------------------------------------

  async sweepTempFiles(): Promise<string[]> {
    const shardDirs = await listEventShardDirs(this.paths);
    return sweepStaleTempFiles([
      this.paths.dbDir,
      this.paths.ticketsDir,
      this.paths.sessionsDir,
      this.paths.eventsDir,
      this.paths.mutationJournalDir,
      ...shardDirs,
    ]);
  }

  async migrateEventShards(): Promise<EventShardMigrationResult> {
    this.invalidateCaches();
    return this.transact(() => migrateFlatEventsToShards(this.paths));
  }

  // --- local-file capabilities -----------------------------------------

  localTicketFilePath(id: TicketId): string {
    return ticketFilePath(this.paths, id);
  }

  localSessionFilePath(id: SessionId): string {
    return sessionFilePath(this.paths, id);
  }
}
