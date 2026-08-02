/**
 * The storage-backend interface (G2, t-y2j03) — the seam between what
 * slopwork's commands/web explorer NEED from a data store and how any
 * particular store provides it.
 *
 * Two drivers implement it today:
 *   - {@link ../storage/flatfile.js!FlatfileBackend} — the default: the
 *     original flatfile repo layer (`src/repo/`) refactored behind this
 *     interface. `.slop/db/{tickets,sessions,events}/` JSONC files,
 *     atomic tmp+rename writes, tolerant reads, the self-healing derived
 *     index, the `.lock`-file write transaction.
 *   - {@link ../storage/remote.js!RemoteBackend} — a stub for a future
 *     remote (e.g. Cloudflare worker) backend. Every method fails with a
 *     clear "not implemented" error; docs/storage-backends.md specifies
 *     the JSON-over-HTTP wire contract, mapped 1:1 to this interface,
 *     that a real remote implementation must provide.
 *
 * Selection is per-repo via `.slop/config.yaml`'s `backend:` key
 * (docs/configuration.md); `src/storage/open.ts`'s `openStorage` reads it
 * and constructs the right driver. Commands and the web data source talk
 * ONLY to this interface — nothing outside `src/storage/` and the
 * driver's own internals (`src/repo/`) may import flatfile modules
 * directly (tests/acceptance/G2.test.ts enforces this with an
 * import-boundary scan).
 *
 * ## Sizing: what commands actually need
 *
 * The method set below is deliberately the observed union of what the 22
 * commands and the web data source call — ticket/session CRUD, event
 * append/query, ref resolution, the derived index, a transactional write
 * scope, and two flatfile-only maintenance operations `slop reindex`
 * exposes — not a speculative general-purpose datastore API.
 *
 * ## The transaction model
 *
 * {@link StorageBackend.transact} is the write scope: run `fn` with the
 * exclusive right to perform a multi-step read-modify-write against the
 * store (the flatfile driver implements it as the `.slop/db/.lock`
 * acquisition, timeout from config.yaml's `defaults.lock_timeout`; a
 * remote backend implements it server-side — see docs/storage-backends.md
 * for the lease-based mapping). `fn` receives an opaque
 * {@link StorageTxScope} marker; functions that MUST only run inside a
 * transaction (e.g. `src/tickets/cascade.ts`'s done-cascade) take that
 * marker as a parameter, which turns "must be called under the lock" into
 * a compile-time property instead of a comment. Individual writes outside
 * `transact` are still atomic per entity — `transact` exists for
 * multi-write units and read-modify-write races, exactly like the lock it
 * wraps (docs/concurrency-and-merging.md).
 *
 * Crash semantics do not include cross-entity rollback: a transaction
 * that dies partway leaves earlier logical mutations committed and later
 * ones unstarted. The flatfile driver does guarantee that each individual
 * ticket/session mutation and its audit event roll forward together via
 * `.slop/db/mutation-journal/`; pending intents recover on storage open
 * and transaction entry. Every derived value (blocked/ready/index) is
 * recomputed from truth, so partial larger transactions do not leave torn
 * derived state. A remote backend must provide its own equivalent for
 * each create/update endpoint; the lease only supplies exclusivity.
 */
import type { Clock } from "../core/clock.js";
import type {
  Event,
  EventEntity,
  EventId,
  Session,
  SessionId,
  Ticket,
  TicketId,
} from "../core/index.js";
import type { JsoncPatchEntry } from "../core/jsonc.js";
// Type-only imports from the flatfile driver's modules: these shapes are
// canonically DEFINED next to the zod schemas that validate them (the
// driver persists/validates the index and result shapes), and re-exported
// here as the interface's own vocabulary. `import type` only — no runtime
// dependency from the interface onto any driver.
import type { DbIndex, LoadIndexResult } from "../repo/db-index.js";
import type {
  EventContext,
  EventQuery,
  ListEventsTolerantResult,
  MutationEventSpec,
} from "../repo/events.js";
import type { ListSessionsTolerantResult } from "../repo/sessions.js";
import type { ListTicketsTolerantResult } from "../repo/tickets.js";

export { formatDuplicateSlugProblems, formatIndexProblems } from "../repo/db-index.js";
export { formatEventReadProblems, warnAboutEventReadProblems } from "../repo/events.js";
export type {
  DbIndex,
  DuplicateSlugProblem,
  IndexTicketRow,
  LoadIndexResult,
  TicketReadProblem,
} from "../repo/db-index.js";
export type {
  EventContext,
  EventQuery,
  EventReadProblem,
  ListEventsTolerantResult,
  MutationEventSpec,
} from "../repo/events.js";
export type { ListSessionsTolerantResult, SessionReadProblem } from "../repo/sessions.js";
export type { ListTicketsTolerantResult } from "../repo/tickets.js";

/**
 * Opaque marker for "inside a {@link StorageBackend.transact} scope".
 * Only drivers construct one; a function that takes it as a parameter can
 * only be called from inside a transaction callback. It carries no
 * capability — the transaction's exclusivity belongs to the backend the
 * callback closes over — it exists purely for compile-time discipline.
 */
export interface StorageTxScope {
  readonly kind: "storage-transaction";
}

/** What {@link StorageBackend.migrateEventShards} did — see docs/cli-reference.md's `reindex --shard-events`. */
export interface EventShardMigrationResult {
  /** Flat-layout event files moved into `events/YYYY-MM/` shards this run (0 = already fully sharded). */
  moved: number;
  /** Distinct shard directories that received at least one file. */
  shards: string[];
}

export interface StorageBackend {
  /** Which driver this is — for diagnostics and capability checks. */
  readonly kind: "flatfile" | "remote";

  // --- tickets ---------------------------------------------------------
  /** Strict read of one ticket. Throws NOT_FOUND (exit 4) if absent, GENERIC_ERROR on a corrupt file. */
  readTicket(id: TicketId): Promise<Ticket>;
  /** Every ticket, strict: throws on the first unreadable file (reindex --strict semantics). */
  listTickets(): Promise<Ticket[]>;
  /** Every readable ticket + a problem entry per unreadable one; never throws on a bad file. */
  listTicketsTolerant(): Promise<ListTicketsTolerantResult>;
  /** Create a ticket AND emit exactly one event describing it (the A4 emit-on-mutation guarantee). */
  createTicket(
    ticket: Ticket,
    ctx: EventContext,
    event: MutationEventSpec,
    clock?: Clock,
  ): Promise<Event>;
  /**
   * Update a ticket AND emit exactly one event. `patch` is the minimal
   * field-path patch (drives the flatfile driver's comment-preserving
   * JSONC rewrite); `expectedAfter` is the full post-update ticket and is
   * authoritative — a backend that has no text to preserve (remote) may
   * ignore `patch` and store `expectedAfter`.
   */
  updateTicket(
    id: TicketId,
    patch: JsoncPatchEntry[],
    expectedAfter: Ticket,
    ctx: EventContext,
    event: MutationEventSpec,
    clock?: Clock,
  ): Promise<Event>;

  // --- sessions --------------------------------------------------------
  readSession(id: SessionId): Promise<Session>;
  /** Every session, strict (throws on the first unreadable file). */
  listSessions(): Promise<Session[]>;
  listSessionsTolerant(): Promise<ListSessionsTolerantResult>;
  createSession(
    session: Session,
    ctx: EventContext,
    event: MutationEventSpec,
    clock?: Clock,
  ): Promise<Event>;
  updateSession(
    id: SessionId,
    patch: JsoncPatchEntry[],
    expectedAfter: Session,
    ctx: EventContext,
    event: MutationEventSpec,
    clock?: Clock,
  ): Promise<Event>;

  // --- events ----------------------------------------------------------
  readEvent(id: EventId): Promise<Event>;
  /**
   * Mint and append exactly one immutable event — the lock-free write
   * (safe outside `transact`: every event gets its own fresh ULID
   * filename, so concurrent appends can never collide). This is what a
   * pure `update --progress` and the done-cascade's `ticket.ready`
   * emissions use.
   */
  appendEvent(
    ctx: EventContext,
    entity: EventEntity,
    spec: MutationEventSpec,
    clock?: Clock,
  ): Promise<Event>;
  /** ULID-cursor query (`since`/`ticket`/`limit`) — `slop events`' backing read. */
  queryEvents(query?: EventQuery): Promise<Event[]>;
  /** Every event, strict, in cursor (ascending id / chronological) order. */
  listEvents(): Promise<Event[]>;
  /** Every readable event plus structured diagnostics for every skipped file. */
  listEventsTolerant(): Promise<ListEventsTolerantResult>;

  // --- ref resolution --------------------------------------------------
  /**
   * Resolve a user-supplied ref (full id / exact slug / `t-<code>` /
   * unique short prefix — src/repo/refs.ts's precedence) to a ticket.
   * Throws NOT_FOUND (4), AMBIGUOUS_REF (5), or USAGE_ERROR (2) for an
   * external ref.
   */
  resolveTicketRef(ref: string): Promise<Ticket>;
  /** Resolve many refs against one consistent snapshot; first failure throws. */
  resolveTicketRefs(refs: string[]): Promise<Ticket[]>;

  // --- derived index ---------------------------------------------------
  /**
   * The derived index (per-ticket summary rows, slug map, reverse edges,
   * blocked/ready columns, staleness deadlines, ticket `problems[]`, and
   * event `event_problems[]`),
   * transparently rebuilt when stale — the flatfile driver's self-healing
   * `index.jsonc`. A remote backend serves the equivalent server-derived
   * data with `rebuilt: false, reason: "fresh"`.
   */
  loadIndex(clock?: Clock): Promise<LoadIndexResult>;
  /** Force a full rebuild (slop reindex). */
  rebuildIndex(clock?: Clock): Promise<DbIndex>;

  // --- transactions ----------------------------------------------------
  /**
   * Run `fn` holding the store's exclusive write scope — see the module
   * doc's "The transaction model". Timeout/contention surfaces as a
   * CONFLICT (exit 6) SlopError naming the holder.
   */
  transact<T>(fn: (tx: StorageTxScope) => Promise<T>): Promise<T>;

  // --- maintenance (slop reindex) --------------------------------------
  /** Remove stale atomic-write temp debris (crashed writers). Returns the paths removed. */
  sweepTempFiles(): Promise<string[]>;
  /**
   * G2 (shard-event-storage): move flat-layout `events/event_*.jsonc`
   * files into `events/YYYY-MM/` shards (month from each event ULID's
   * own timestamp, UTC). Explicit only — `slop reindex --shard-events`;
   * never runs implicitly, because event files are git-tracked and the
   * rename should land as a visible commit. Safe and idempotent.
   */
  migrateEventShards(): Promise<EventShardMigrationResult>;

  // --- optional local-file capabilities --------------------------------
  /**
   * Absolute path of the locally-editable file holding `id`, when this
   * backend stores tickets as local files. `slop edit` requires this
   * capability; a backend without it cannot support $EDITOR-based editing.
   */
  localTicketFilePath?(id: TicketId): string;
  /** Like {@link localTicketFilePath} for sessions — used only to name files in diagnostics. */
  localSessionFilePath?(id: SessionId): string;
}
