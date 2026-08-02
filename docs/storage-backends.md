# Storage backends

Slopwork's commands and `slop web` talk to exactly one interface,
`StorageBackend` (`src/storage/backend.ts`) — never to `.slop/db/` files
directly. `.slop/config.yaml`'s `backend:` key
([Configuration → Storage backend](configuration.md#storage-backend))
selects which implementation (a "driver") a repo uses:

- **`flatfile`** (default, needs no configuration) — `.slop/db/{tickets,
  sessions,events}/` JSONC files on disk, exactly as described throughout
  [Concepts](concepts.md) and [Concurrency & merging](concurrency-and-merging.md).
- **`remote`** — a store reachable over HTTP, e.g. a small Cloudflare
  worker sitting in front of a real database. **Not implemented today** —
  `src/storage/remote.ts` ships a stub whose every method fails
  immediately with a clear, consistent error (exit `1`, never a crash or
  a hang) naming this document. This document specifies the wire contract
  a real remote implementation must speak so that building one later is
  "implement this," not "redesign the interface."

Everything below is written against `StorageBackend`'s own method
signatures (`src/storage/backend.ts` — read that file first; it's
heavily doc-commented and this document assumes its vocabulary:
`StorageTxScope`, the transaction model, tolerant vs. strict reads). Every
endpoint maps 1:1 to one interface method.

## Conventions

- **Base URL**: `backend.url` from `config.yaml` (e.g.
  `https://slop.example.workers.dev`). Every path below is relative to it.
  A version prefix, `/v1`, is part of every path — a future breaking wire
  change bumps this, not the paths themselves.
- **Bodies**: JSON, `Content-Type: application/json`, both directions.
- **Entity shapes**: a request/response body's `ticket`/`session`/`event`
  field is the exact JSON serialization of the corresponding zod schema in
  `src/core/entities/*.ts` (`ticketSchema`/`sessionSchema`/`eventSchema`)
  — the same shape `slop show --json`/`slop events --json` already emit,
  not a separate wire-specific shape. `TicketId`/`SessionId`/`EventId` are
  their plain branded strings (`ticket_<ULID>`, etc.); a server need not
  validate the brand's regex beyond treating the field as an opaque
  string key.
- **Idempotency**: none of these remote endpoints are automatically
  retried by the client on a timeout — a caller that retries a
  `POST`/`PATCH` after a network failure may durably create a duplicate on
  the server unless the server itself de-duplicates. The flatfile driver
  is stronger for local ticket/session writes: its ignored write-ahead
  journal replays one pre-minted event id until the paired entity and
  event both exist. A remote implementation should provide equivalent
  atomicity or accept an idempotency key before it is production-ready;
  the current wire contract does not yet carry one.

### Authentication

Every request carries `Authorization: Bearer <token>`, where `<token>` is
the `SLOP_REMOTE_TOKEN` environment variable (never `config.yaml` — see
[Configuration → Storage backend](configuration.md#storage-backend) for
why the token is deliberately kept out of a committed, git-mergeable
file). A request with no token, or one the server rejects, gets:

```json
{ "error": { "code": "GENERIC_ERROR", "message": "authentication failed: <detail>" } }
```

with HTTP status `401` or `403`. There's no dedicated slop exit code for
"auth failed" ([`EXIT_CODES`](../src/core/exit-codes.ts) has no
AUTH_ERROR) — it surfaces as `GENERIC_ERROR` (exit `1`), same as any
other unexpected backend failure, with the message naming the real cause
so a human can tell it apart from, say, a network outage.

### Error mapping

Every non-2xx response body is:

```json
{ "error": { "code": "<name>", "message": "<human-readable, actionable>" } }
```

`code` is one of `EXIT_CODES`'s names (`src/core/exit-codes.ts`) and is
**authoritative** — the client maps it straight back to a `SlopError`
carrying that exit code; the HTTP status below is an advisory convenience
for anything inspecting the response at the HTTP layer (a proxy, a log
line), not what the client branches on.

| `error.code` | HTTP status | slop exit code | Meaning |
|---|---|---|---|
| `USAGE_ERROR` | 400 | 2 | Bad request shape/args — e.g. an invalid ref syntax, a malformed patch. |
| `NOT_FOUND` | 404 | 4 | The named ticket/session/event/ref does not exist. |
| `AMBIGUOUS_REF` | 409 | 5 | A short-prefix or slug ref matched more than one ticket. |
| `CONFLICT` | 409 | 6 | Illegal state transition, or a transaction lease could not be acquired within the client's configured timeout. |
| `GENERIC_ERROR` | 500 | 1 | Anything else: server bug, storage failure, auth failure (see above). |

A transport-level failure (connection refused, DNS failure, TLS error,
timeout with no response at all) never reaches this mapping — the client
wraps it directly as `GENERIC_ERROR` naming the underlying network error,
since there was no server response to interpret.

## Endpoints

### Tickets

| Method & path | Interface method | Request body | Response |
|---|---|---|---|
| `GET /v1/tickets/:id` | `readTicket(id)` | — | `Ticket` (404 if absent) |
| `GET /v1/tickets` | `listTickets()` | — | `Ticket[]` (strict — the FIRST unreadable/invalid record server-side is a `GENERIC_ERROR`, matching `reindex --strict`'s fail-fast semantics) |
| `GET /v1/tickets?mode=tolerant` | `listTicketsTolerant()` | — | `{ "tickets": Ticket[], "problems": TicketReadProblem[] }` — never a 4xx/5xx for a per-record problem; each `problems[]` entry is `{path, id, message}` (`path` may be a server-internal identifier, not a real filesystem path, when the backend has no files) |
| `POST /v1/tickets` | `createTicket(ticket, ctx, event, clock?)` | `{ "ticket": Ticket, "ctx": EventContext, "event": MutationEventSpec, "clock"?: string }` (`clock`, if given, an ISO timestamp — see "Clock" below) | `Event` — the `ticket.created`-family event this call durably emitted |
| `PATCH /v1/tickets/:id` | `updateTicket(id, patch, expectedAfter, ctx, event, clock?)` | `{ "patch": JsoncPatchEntry[], "expected_after": Ticket, "ctx": EventContext, "event": MutationEventSpec, "clock"?: string }` | `Event` |

`patch` (`JsoncPatchEntry[]`, `src/core/jsonc.ts`) exists so the flatfile
driver can do a comment-preserving rewrite of the on-disk file; a remote
backend has no such text to preserve and **may ignore `patch` entirely,
storing `expected_after` as the ticket's new authoritative state** — this
is explicitly sanctioned by `StorageBackend.updateTicket`'s own doc
comment. Still send both: a future backend that DOES keep an editable
text form (e.g. exposing `slop edit` over a synced file) can use `patch`
if it wants to.

### Sessions

Exactly mirrors tickets:

| Method & path | Interface method |
|---|---|
| `GET /v1/sessions/:id` | `readSession(id)` |
| `GET /v1/sessions` | `listSessions()` |
| `GET /v1/sessions?mode=tolerant` | `listSessionsTolerant()` → `{ "sessions": Session[], "problems": SessionReadProblem[] }` |
| `POST /v1/sessions` | `createSession(session, ctx, event, clock?)` → `Event` |
| `PATCH /v1/sessions/:id` | `updateSession(id, patch, expectedAfter, ctx, event, clock?)` → `Event` |

### Events

Events are immutable and append-only (`src/repo/events.ts`'s module doc)
— there is no `PATCH`/`DELETE` here, matching the interface exactly.

| Method & path | Interface method | Response |
|---|---|---|
| `GET /v1/events/:id` | `readEvent(id)` | `Event` (404 if absent) |
| `POST /v1/events` | `appendEvent(ctx, entity, spec, clock?)` — body `{ "ctx": EventContext, "entity": EventEntity, "spec": MutationEventSpec, "clock"?: string }` | `Event` — the server mints `id`/`at`, exactly like the flatfile driver's `newEventId()`/clock does; the client never supplies them |
| `GET /v1/events?since=<id>&ticket=<id>&limit=<n>` | `queryEvents({since, ticket, limit})` — all three query params optional | `Event[]`, cursor (ascending id) order |
| `GET /v1/events?mode=all` | `listEvents()` (strict) | `Event[]` |
| `GET /v1/events?mode=tolerant` | `listEventsTolerant()` | `Event[]` (corrupt records silently excluded server-side) |

A real implementation is free to shard/partition events however it likes
server-side (the flatfile driver's own `events/YYYY-MM/` sharding is
purely a local storage-layout concern) — nothing about this wire contract
exposes shard layout, since `EventShardMigrationResult` below is the
flatfile driver's own maintenance operation, not a generic one every
backend need implement meaningfully (see "Maintenance").

### Ref resolution

| Method & path | Interface method | Request | Response |
|---|---|---|---|
| `GET /v1/refs?ref=<ref>` | `resolveTicketRef(ref)` | `ref` URL-encoded in the query string (never a path segment — a ref can contain `:` and `/`, e.g. `jira:PROJ-123`, which would collide with path-segment parsing) | `Ticket` (404/409 per the precedence `src/repo/refs.ts` documents: full id / exact slug / `t-<code>` / unique short prefix) |
| `POST /v1/refs/resolve-many` | `resolveTicketRefs(refs)` | `{ "refs": string[] }` | `Ticket[]`, same order as `refs`, resolved against ONE consistent server-side snapshot; the FIRST unresolvable ref fails the whole call (matching the interface's own doc: "first failure throws") |

### Derived index

| Method & path | Interface method | Response |
|---|---|---|
| `GET /v1/index` | `loadIndex(clock?)` | `{ "index": DbIndex, "rebuilt": boolean, "reason": IndexLoadReason }` — a remote backend has no on-disk staleness to detect (its derived data is server-computed on every read, or kept continuously up to date), so it should always respond `rebuilt: false, reason: "fresh"` per `StorageBackend.loadIndex`'s own doc comment |
| `POST /v1/index/rebuild` | `rebuildIndex(clock?)` | `DbIndex` — force a full recompute; for a backend that's always fresh this can be a cheap no-op that just returns the current derived state |

`DbIndex`'s shape (`src/repo/db-index.ts`'s `dbIndexSchema`) includes a
`fingerprint` field that is meaningless off the flatfile layout (it's a
content hash of on-disk directories) — a remote backend may fill it with
any stable placeholder value; nothing reads `fingerprint` through the
`StorageBackend` interface itself (only the flatfile driver's own
internal staleness check does, entirely inside `src/repo/db-index.ts`).

G3 (t-175oq/t-trqk9) added two fields to every `IndexTicketRow`/`DbIndex`
a real remote implementation must also populate (schema `v4` — no
interface *method* signature changed, only this response shape):
- `IndexTicketRow.owner` — the row's `Actor | null`, mirroring
  `ticket.owner` (used by `ready --owner`/`slop list --owner`).
- `DbIndex.slug_problems` — every slug currently claimed by more than one
  ticket, `{slug, ids: TicketId[]}[]` (see
  [Concepts → slug uniqueness](concepts.md#slug-uniqueness)). A backend
  whose storage layer enforces slug uniqueness server-side (e.g. a unique
  index in a real database) can always return `[]` here; one that
  doesn't should compute it the same way the flatfile driver does — group
  by slug, any group with more than one id is a problem entry.

### Transactions

`StorageBackend.transact(fn)` is a **client-side** call: `fn` runs
in-process and makes some number of the calls above, one at a time,
expecting exclusive access for their whole duration (`backend.ts`'s
module doc, "The transaction model"). A remote backend maps this onto a
short-lived server-side **lease**:

| Method & path | Purpose |
|---|---|
| `POST /v1/transactions` | Begin. Body `{ "timeout_ms": number }` — the client's configured `defaults.lock_timeout` (`src/repo/lock.ts`'s `DEFAULT_TIMEOUT_MS`, 5000 by default). Blocks server-side (bounded retry, same shape as the flatfile lock's own capped backoff) until either a lease is granted or `timeout_ms` elapses, in which case it responds `409 CONFLICT` naming the current holder — exactly what a flatfile lock-acquisition timeout does. On success: `{ "lease_id": string, "expires_at": "<ISO timestamp>" }`. |
| every mutating call above, while a lease is held | Add header `X-Slop-Transaction: <lease_id>`. The server rejects (`409 CONFLICT`) any mutating call carrying a lease id that is unknown, expired, or held by a different lease. |
| `DELETE /v1/transactions/:lease_id` | Commit/release — always called in the client's `finally`, mirroring `withLock`'s own release-always-runs guarantee (`src/repo/lock.ts`). Idempotent: releasing an already-released or expired lease is `204 No Content`, never an error. |

`expires_at` is the server's own stale-lease timeout (the remote analogue
of the flatfile lock's pid-liveness + staleness-timeout recovery,
`src/repo/lock.ts`'s module doc) — a lease the client never releases
(crash, network partition) must eventually be reclaimable server-side, the
same "one `kill -9` never bricks the repo permanently" property the
flatfile lock provides locally.

Reads (`GET`) never need a lease — exactly like the flatfile driver, where
every read is either lock-free or (`loadIndex`) self-healing regardless of
what any writer is doing.

A lease supplies exclusivity, not multi-request rollback. The flatfile
driver separately journals each ticket/session entity write with its
audit event and recovers it by roll-forward after restart; it still does
not roll back a whole multi-entity `transact` callback. A real remote
backend should execute each create/update endpoint's entity + event write
as one server-side database transaction. Atomicity spanning several
calls in one lease is deliberately outside the current interface.

### Maintenance (`slop reindex`)

| Method & path | Interface method | Response |
|---|---|---|
| `POST /v1/maintenance/sweep-temp-files` | `sweepTempFiles()` | `string[]` — paths/identifiers of debris removed |
| `POST /v1/maintenance/shard-events` | `migrateEventShards()` | `{ "moved": number, "shards": string[] }` |

Both are flatfile-specific concepts (crashed-writer temp-file cleanup;
migrating a flat event layout into month shards) that a remote backend
manages entirely on its own, with no local filesystem debris and no
flat/sharded layout distinction to migrate between. **A conforming remote
implementation may treat both as no-ops** — `sweepTempFiles` returning
`[]` and `migrateEventShards` returning `{moved: 0, shards: []}` — rather
than erroring; `slop reindex`/`slop reindex --shard-events` must still
complete successfully against a remote backend, just reporting nothing to
do.

### Not part of the wire contract: local file access

`StorageBackend.localTicketFilePath`/`localSessionFilePath` are optional
capabilities with no wire equivalent — a remote backend simply does not
implement them (leaves them `undefined`). `slop edit` checks for this
capability up front and refuses cleanly (`USAGE_ERROR`, exit `2`) against
a backend that lacks it, naming `slop update`'s non-interactive
`--parent`/`--blocks`/`--owner`/`--relates-to` flags as the alternative —
see [CLI reference → `edit`](cli-reference.md#edit).

## `Clock`

Every write method takes an optional `clock` — production code always
omits it (the real wall clock); it exists so tests can pin a fixed "now".
On the wire this is an **optional** ISO-8601 timestamp string in the
request body; a server should treat its absence as "use the server's own
current time" and MAY reject (`USAGE_ERROR`) a client-supplied clock
value outside some sane skew window, since trusting an arbitrary
client-supplied timestamp for an audit-trail event's `at` field is a
real integrity concern for a shared remote store in a way it never was
for a single local flatfile repo.

## See also

- [Configuration → Storage backend](configuration.md#storage-backend) —
  how a repo selects `flatfile` vs. `remote`.
- [Concepts → The flatfile database](concepts.md#the-flatfile-database)
  — the default backend's on-disk layout, which this contract's `flatfile`
  driver wraps unchanged.
- [Concurrency & merging](concurrency-and-merging.md) — the flatfile
  lock's exact semantics, which "Transactions" above generalizes to a
  server-side lease.
- `src/storage/backend.ts` — the source of truth for every method
  signature this document maps to an endpoint.
