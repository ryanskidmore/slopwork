/**
 * Compatibility facade for the storage port.
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
 *
 * The contract itself — `StorageBackend`, its transaction marker, and every
 * shared event/query/tolerant-read DTO below — is owned by
 * `src/core/storage-contract.ts`; this module re-exports it unchanged so
 * existing `storage/backend.js` imports keep working while domain and
 * adapter code depend directly on the inward-owned definitions.
 */
export { formatDuplicateSlugProblems, formatIndexProblems } from "../core/db-index.js";
export type {
  ContentFingerprint,
  DbIndex,
  DirFingerprint,
  DuplicateSlugProblem,
  EventReadProblem,
  IndexLoadReason,
  IndexTicketRow,
  LoadIndexResult,
  TicketReadProblem,
} from "../core/db-index.js";
export { parseEventPollCursor } from "../core/storage-contract.js";
export type {
  EventContext,
  EventPollCursor,
  EventPollCursorState,
  EventQuery,
  EventShardMigrationResult,
  ListEventsTolerantResult,
  ListSessionsTolerantResult,
  ListTicketsTolerantResult,
  MutationEventSpec,
  SessionReadProblem,
  StorageBackend,
  StorageTxScope,
} from "../core/storage-contract.js";
export { formatEventReadProblems, warnAboutEventReadProblems } from "../repo/events.js";
