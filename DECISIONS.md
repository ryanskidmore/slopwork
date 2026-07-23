# Slopworks — Engineering Decisions

Short-form log of implementation decisions made while executing
`v0-implementation-plan.md` that aren't already captured by one of
`design.md`'s D-numbered decisions, or that sharpen one of them for
implementation. Newest at the bottom. Each entry names the work item that
forced the call.

## A2 — Edges are stored embedded on the source ticket, not in their own `edges/` directory

`design.md` §3's flatfile db layout lists only `tickets/`, `sessions/`,
`events/`, and the derived `index.jsonc` — there is no `edges/` directory.
So the four edge kinds (`blocks` · `parent` · `relates-to` ·
`discovered-from`, design.md §4.1 item 2) are stored as fields embedded
directly on the *source* ticket — `parent` as a single optional field;
`blocks`, `relates_to`, `discovered_from` as arrays of ticket ids — rather
than as free-standing edge records. The reverse direction (e.g. "which
tickets does X block", "who does Y depend on") is never stored; it is
derived into `index.jsonc` at reindex time, which is exactly what B4's
`blocked_count` is.

**Rationale:** this keeps adding a single edge a one-file, one-line change
on the ticket that owns it, which is what §3's git-mergeable-flatfile-db
merge story requires. A free-standing `edges/edge_<ulid>.jsonc` file per
edge would mean every graph mutation touches an extra file — more merge
surface — for no benefit, since edges have no independent identity or
lifecycle of their own in v0 (they're never edited, only created/removed
alongside the ticket that owns them).

See `src/core/entities/edge.ts` for the logical `Edge` shape (`{from, to,
kind}`, used by the index/graph code in B3/B4), the embedded on-ticket
field shape (`ticketEdgeFieldsSchema`), the documented mapping between the
two (`EDGE_KIND_TO_TICKET_FIELD`), and the forward-extraction helper
(`outgoingEdges`) that B4 will call over every ticket to build the
reverse index.

## D5 — `Bun`-only globals are unavailable inside vitest test workers; `slop web`'s tests are black-box, subprocess-only

Verified directly, not assumed: `Bun.serve`, `Bun.file`, `Bun.YAML`,
`Bun.markdown`, and `with { type: "text" }` asset imports all throw/fail
inside a `*.test.ts` file run by `vitest run` — even when the `vitest`
CLI itself is launched via `bun run test`. `process.execPath` inside a
test file resolves to a real `node` binary, not `bun`: vitest's test
workers are genuine Node processes, not Bun ones, regardless of what
started the top-level CLI.

**Consequence:** `src/web/server.ts` (`Bun.serve`, embedded CSS/JS via
`with { type: "text" }`) and `src/web/fixture-data-source.ts` (`Bun.file`,
`Bun.YAML.parse`) can never be `import`ed directly by a test file — only
exercised by spawning a real `bun`/`dist/slop` process and talking to it
over HTTP, exactly as `tests/acceptance/A1.test.ts` already does for the
compiled binary. `tests/acceptance/D5.test.ts` follows that same pattern
for every view/route assertion, not just the compiled-binary one. Modules
with no Bun-only calls (`src/web/overlays.ts`, `src/web/html.ts`,
`src/web/transcript.ts`) stay portable and keep ordinary co-located
`*.test.ts` unit tests.

A second consequence: since `createWebServer` is never called in-process
by a test, staleness determinism (D5: `blocked`/`stale` overlays depend on
"now" vs. the fixture db's fixed timestamps) can't be achieved by passing
a `fixedClock` object through a normal function call across the process
boundary. `src/cli/commands/web.ts` instead reads a `SLOP_WEB_FAKE_NOW`
env var (undocumented as a user-facing flag, read only there) and builds
a `fixedClock` from it when set; the test suite spawns with that env var
pinned to `tests/fixtures/web-db-meta.ts`'s `FIXTURE_NOW_ISO`, and the
real `slop web` invocation (no env var set) always uses `systemClock`.

## D5 — `FixtureDataSource` is generic over any `.slop`-shaped directory, and `slop web` uses it directly today

The brief asked for a `WebDataSource` interface plus a `FixtureDataSource`
implementation reading the *fixture* db, with "the real repo layer" wired
in by a later work item. In practice `FixtureDataSource` (src/web/fixture-data-source.ts)
has no fixture-specific logic at all — it takes any `.slop` root path,
glob-reads `db/{tickets,sessions,events}/*.jsonc` + `config.yaml` +
`transcripts/*.jsonl`, and validates everything against the A2 schemas.
None of D5's read needs (list, get, filter, paginate) require A3's
locking/atomic-write machinery, which only matters for concurrent
*writers*. So `src/cli/commands/web.ts` points this same class at
whatever real `.slop` directory it finds by walking up from `cwd` (the
same convention `.git` discovery uses) — making `slop web` genuinely
usable today, not just against fixtures, without depending on `src/repo/`.

**What the later "wire the real repo layer" work item should actually
do**, given the above: not "make `slop web` work" (it already does) but
*upgrade* the read path — swap in B4's persisted `index.jsonc` instead of
this class's in-memory `blocked`/`stale`/reverse-edge recomputation (an
O(n)-per-request cost that only matters past the flatfile db's target
scale), and reuse A3's canonical ref-resolution function instead of the
locally-reimplemented one in `findTicketByRef` (functionally equivalent
today, via the shared `core/ids.ts` `idMatchesRef` predicate, but two
independent implementations of "which id does this ref mean" is exactly
the kind of drift risk worth collapsing to one). Also decide then whether
live index invalidation matters for a long-running `slop web` process
across concurrent writers — this implementation re-reads from disk on
every request, so it doesn't need cache invalidation at all today.

`Session.transcript_ref` is treated as a path **relative to the `.slop`
root** (e.g. `"transcripts/session_….jsonl"`) — design.md doesn't specify
the exact string shape C4 will write there, only the destination
directory; this is D5's assumption on the writing side, matching what the
fixture generator emits, and needs to line up with whatever C4 actually
writes when that work item lands.

## A3 — adversarial-review fixes: lock fencing, index fault tolerance, content-digest fingerprint, case-insensitive slugs

Four findings from an adversarial review of A3 were fixed without
regressing its own acceptance criterion ("Kill -9 mid-write leaves no
corrupt files; ambiguous prefix errors git-style; deleted index
self-heals"). Two of these settle contracts later work items build on
directly:

**1. `.slop/db/.lock`'s fencing-token contract (`src/repo/lock.ts`).**
Staleness-by-timeout alone can't tell a dead holder from a slow-but-alive
one (contended/I/O-stalled/GC-paused/cgroup-throttled), so a legitimate
holder that ran long could have its lock silently stolen while still
writing — two "exclusive" holders at once, no error. Fix: every
acquisition now records a unique fencing token (a ULID) alongside pid/
`acquired_at`; `acquireLock`/`withLock` return/hand out a `LockHandle`
exposing `assertHeld(): Promise<void>`, which re-reads the lock file and
throws `SlopError(CONFLICT, exit 6)` if the token no longer matches (this
process was dispossessed), and otherwise renews `acquired_at` (so a
holder that calls it regularly is never reclaimed merely for running
past `staleTimeoutMs` — the timeout now means "no progress for N", not
"started more than N ago"). Release is now a token-based compare-and
-delete when a token is available (falls back to the old pid-based
compare for a bare `lockPath` caller with no handle).

**Binding contract for every future multi-file transaction inside
`withLock`** (B4's done-cascade, a future reparent): call the handle's
`lock.assertHeld()` between each individual entity write, not just once
at the top. Skipping it defeats the mechanism — a transaction that never
checks back in can still be silently dispossessed partway through. No
real call site exists yet (B4/C3 aren't implemented as of this fix); the
contract, its doc comment in `lock.ts`, and both a real multi-process test
(`tests/acceptance/a3-lock-worker.ts` via A3.test.ts) and an in-process
`withLock` unit test (`lock.test.ts`) are in place for whoever lands the
first real caller.

**2. Index fault tolerance (`src/repo/db-index.ts`, `src/repo/tickets.ts`,
`src/cli/commands/reindex.ts`).** A single corrupt ticket file used to
make `buildIndex` throw, which took `slop reindex` — the documented
recovery command — down with it, along with every other `loadIndex`
caller. Fix: `tickets.ts` gains `listTicketsTolerant`, a sibling of the
(unchanged, still fail-fast) `listTickets` that returns `{tickets,
problems}` instead of throwing; `buildIndex` uses it and returns
`problems: TicketReadProblem[]` (id/path/message, same message quality
`readTicket` itself throws) as part of `DbIndex`. Policy, enforced at
each layer:
  - `readTicket`/`listTickets` (direct-by-id / all-or-nothing reads):
    unchanged, still throw. Correct there — the caller asked for exactly
    that file, or asked for an all-or-nothing scan.
  - `buildIndex`/`rebuildIndex`: never throw on a bad ticket file; always
    return/persist whatever *could* be read, with problems recorded.
  - `loadIndex` (the function every read path should call): warns on
    stderr (`db-index.ts`'s `formatIndexProblems`) **every single call**
    that returns an index with `problems.length > 0` — including a
    `"fresh"` (non-rebuilt) load serving a persisted problems list from
    an earlier build. Never silent, never "once and done."
  - `slop reindex`: reports every problem in one pass with its full
    actionable error, still rebuilds and saves everything readable, and
    exits `GENERIC_ERROR` (1) iff any problem remains (0 when clean).
    `--strict` restores the old fail-fast, all-or-nothing behavior via a
    `listTickets(paths)` gate call before `rebuildIndex` runs at all.
No `INDEX_SCHEMA_VERSION` bump for the new `problems` field or the
fingerprint shape change below: `loadIndex`'s auto-heal already treats
*any* on-disk shape mismatch (regardless of cause) as `invalid_schema`
and transparently rebuilds, so a version bump would protect nothing a
pre-existing mechanism doesn't already cover for free.

**3. Content fingerprint is now a digest, not max-mtime
(`src/repo/db-index.ts`).** The old `{count, max_mtime_ms}` fingerprint
missed a real content change whenever the edited file's mtime didn't
happen to be the directory's max — e.g. `cp -p`/`rsync -t`/a backup
restore/clock skew between two machines, all realistic given this
project's explicit multi-agent/multi-machine target. Replaced with
`{count, digest}`, where `digest` is a sha256 hex digest over every
entity file's own `(filename, mtimeMs, size)` tuple, sorted by filename —
still `readdir`+`stat` only, no file content read, same cost class
(measured 1.7-5.0ms, median ~2.8ms, over 1,000 tickets in this
environment, vs. the pre-fix implementation's own reported ~1.7ms — see
the work item's report). Narrows the known same-millisecond blind spot to
same-millisecond *and* identical byte size.

**4. Slug ref resolution is now case-insensitive
(`src/repo/refs.ts`).** Slugs are lowercase by construction (`slugify`),
so `resolveTicketRef` now lowercases the incoming ref before the exact
-slug lookup — matching `core/ids.ts`'s `idMatchesRef`, which was already
case-insensitive for short-prefix matching. Documented precedence (slug
beats prefix) is unchanged; this is strictly more permissive than before.
