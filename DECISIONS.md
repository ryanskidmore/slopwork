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

## B4 — `ready` ordering's "age" is the ticket's own `id`, not a new `created_at` index column

The acceptance criterion asks for "priority then age," with `created_at`
named as one option and "a documented tiebreak" explicitly permitted as
the alternative. `IndexTicketRow` has no `created_at` field. Rather than
adding one (a new column needing its own secondary tiebreak for two
tickets created in the same batch/millisecond), `src/tickets/ready.ts`'s
`compareReadyOrder` sorts on the ticket's own `id` instead: ids are ULIDs
minted exactly once at creation (`core/ids.ts`'s shared monotonic
factory) and sort chronologically as plain strings — the same property
`events.ts`'s cursor ordering already leans on — so ascending-id order
*is* ascending-creation-order, to the millisecond, and is additionally a
complete, collision-free tiebreak (ids are globally unique; `created_at`
alone is not). This keeps `IndexTicketRow`'s reserved `blocked_count`/
`ready` fill-in (see below) the only shape change this item makes.

## B4 — `blocked_count`/`ready` are recomputed from `Ticket` state at every `buildIndex`, never a stored/decremented counter

`db-index.ts` gains `computeBlockedCounts(tickets)` (live — non-`done`/
`dropped` — blocker count per ticket) and `computeReady(state, count,
activeSession)` (design.md §2's predicate, verbatim), both pure and
exported. `buildIndex` calls them over the full ticket set to fill the
previously-null `blocked_count`/`ready` columns; B4's done-cascade
(`src/tickets/cascade.ts`'s `cascadeOnClose`) calls `computeBlockedCounts`
again over a freshly re-read ticket list after a closure, rather than
decrementing a counter anywhere — there is nowhere on `Ticket` to store
one (D5: derived, never asserted), and a bare decrement is provably wrong
for a diamond (two live blockers; closing one must not flip the target)
without first computing the same live-count this design computes
directly. Recomputing is idempotent by construction, which is what makes
a partial cascade (crash/dispossession after N of M `ticket.ready` events)
safe to leave as-is rather than needing rollback: the graph's derived
state is never torn, only the event log's "who got notified" bookkeeping
can lag, and a re-run of the same cascade repairs it for free. Filling an
already-nullable field is not a schema reshape, so `INDEX_SCHEMA_VERSION`
is unchanged — see `db-index.ts`'s module doc for the one narrow gap this
leaves (a pre-B4 `index.jsonc` already on disk, with untouched ticket
files, stays `"fresh"` with stale nulls until `slop reindex` or a ticket
write forces a rebuild; self-heals either way, same class as the existing
mtime-granularity limitation).

## B4 — `ready --resumable` returns "stopped" work today; C5 widens the same predicate

`src/tickets/ready.ts`'s `filterResumableRows` returns `in_progress`/
`review` tickets with `active_session === null` — reachable today only via
direct repo-layer state (or a future crash/hand-edit), since the currently
-landed `stop` transitions a ticket back to `open`, not to a session
-less `in_progress`. C5 (staleness) should widen the predicate to also
match `row.stale === true || row.review_stale === true` (columns already
reserved on `IndexTicketRow`, `null` until C5) — a one-line change, not a
redesign; see the module's doc comment for the exact seam.

## B4 — adversarial-review fix: `cascadeOnClose` re-invocation now deduplicates `ticket.ready` emission against the event log

**Correction to the two B4 entries above:** they describe `blocked_count`/
`ready`'s recompute-from-truth idempotency and, in doing so, read as if
that also made the done-cascade's `ticket.ready` *emission* exactly-once
on a re-invocation ("a re-run of the same cascade repairs it for free").
That was true of the `blocked_count`/`ready` *answer* recomputed each
call, but NOT of the events actually written: as originally shipped,
`cascadeOnClose` re-emitted an identical `ticket.ready` for every
already-unblocked ticket on every re-invocation, because it had no memory
of what it had already notified. Since re-invoking `cascadeOnClose` for
the same `closedTicketId` is this module's own documented recovery path
after a partial cascade (see its "Failure semantics" doc), this made the
documented recovery path at-least-once with unbounded duplication, not
the exactly-once the surrounding text implied — undermining the clean
audit trail §4.7's dogfood requirement calls for.

**Fix (`src/tickets/cascade.ts`, adversarial review):** before writing a
`ticket.ready` for candidate ticket `T`, `cascadeOnClose` now calls
`queryEvents(paths, { ticket: T })` (A4's existing repo-layer query,
scoped to `T` via its own `ticket` filter rather than a hand-rolled scan)
and skips the write if a `ticket.ready` event already exists for `T` with
`payload.unblocked_by` equal to this `closedTicketId`. `unblocked` on
`CascadeOnCloseResult` is unchanged — still the full, truthful
recompute-from-truth answer — but `events` now reports only what THIS
call actually wrote, so the two arrays are no longer guaranteed the same
length on a re-invocation (see the result type's own doc for the updated
contract). This costs one extra `queryEvents` call per candidate ticket,
scoped by ticket rather than an unscoped full-log fetch reprocessed per
candidate; fine at v0's target scale — see the function's doc comment for
the full mechanism. Regression coverage:
`src/tickets/cascade.test.ts`'s "idempotency" describe block now asserts
a second `cascadeOnClose` call for the same closure emits zero new
events, cross-checked against the full on-disk event log, not just the
function's return value.

## C5 — the index stores a staleness DEADLINE, never a boolean; the boolean is computed live at read time

The plan's C5 row says "computed in index," which read literally means
baking a live `stale: true/false` into `index.jsonc` at build time. **That
design is wrong**, and this work item does not implement it. Staleness is
a function of wall-clock time, not ticket content — and `index.jsonc`
(db-index.ts) only rebuilds on a **content-fingerprint** mismatch (ticket
files, and now config.yaml, changing), never merely because time passed.
A ticket that goes stale purely because N hours elapsed with zero edits
would never trigger a reindex, so a boolean baked in at the last rebuild
would report `false` forever — exactly the failure mode this work item's
own acceptance criterion targets ("a stale review ticket surfaces" — a
ticket whose *content* hasn't changed, only the clock has).

**The fix**, split cleanly across two kinds of function
(`src/tickets/staleness.ts`, new, pure, fully unit-tested with
`fixedClock`):

- `computeStaleAt`/`computeReviewStaleAt` compute a **content-derived
  deadline timestamp** — `last_activity_at + stale_after` for
  `in_progress`; `review.requested_at + review_stale_after` for `review`;
  `null` when the state doesn't apply. This deadline IS safe to persist in
  the index, because — unlike a boolean — it only changes when the
  ticket's own content changes (an activity bump, a review request, a
  state transition), which the fingerprint mechanism already tracks by
  construction. `db-index.ts`'s `buildIndex` calls these once per ticket
  and stores the result as `IndexTicketRow.stale_at`/`review_stale_at`
  (replacing A3's reserved `stale`/`review_stale` booleans outright — not
  filling them in).
- `isStale`/`isReviewStale` compute the **live boolean** — `now >
  deadline`, strictly (a ticket exactly AT its deadline is not yet stale;
  boundary-tested at exactly/just-under/just-over) — against an
  explicitly injected `now: Date`, never a bare `Date.now()`/`new Date()`
  (core/clock.ts's rule). This is the read-time half, called by every
  consumer (`ready --resumable`, `status`) against that command's own
  resolved clock.

This reconciles "computed in index" (the *deadline* is computed into the
index, and — critically — is stable/rebuild-safe: rebuilding the SAME
ticket's index row at two different "now"s yields the identical
`stale_at`, proven directly in `db-index.test.ts` and
`tests/acceptance/C5.test.ts`) with correctness (the *boolean* is always
live, so "time passed, nothing else changed" is handled correctly by
construction, not by luck).

### `requested_at` vs `last_activity_at` for review staleness

design.md §2 says review staleness "catches MRs rotting unreviewed" — it
measures how long the MR has sat **awaiting a human**, not how long ago
the ticket was touched in general. D15's `review.requested_at` marks
exactly the moment review was asked for, so `computeReviewStaleAt`
anchors there, not on `last_activity_at`. Concretely: a ticket that's sat
in review for a week, then gets one unrelated `update --progress` note
today (bumping `last_activity_at` without addressing the review at all),
must still read as review-stale — anchoring on `last_activity_at` would
incorrectly reset the clock on exactly the case this overlay exists to
catch. `last_activity_at` is used only as a defensive fallback if
`review.requested_at` is somehow absent on a `review`-state ticket (the
`Ticket` schema's own `refine` should make this unreachable in practice).
(`src/web/overlays.ts`'s D5 stale panel independently anchors review
staleness on `last_activity_at` for both states — a pre-existing,
documented divergence this work item does not touch; unifying the two
shared helpers is an E1 polish opportunity.)

### Row-shape change: `INDEX_SCHEMA_VERSION` bumped 1 → 2

Unlike B4's `blocked_count`/`ready` fill-in (an already-nullable field
staying nullable, no reshape needed), replacing `stale`/`review_stale:
boolean | null` with `stale_at`/`review_stale_at: IsoTimestamp | null` is
a genuine field-name-and-type change. A pre-C5 `index.jsonc` on disk fails
`dbIndexSchema` validation against the new shape outright, so this bumps
`INDEX_SCHEMA_VERSION` to force it through the existing
`stale_schema_version`/`invalid_schema` auto-heal path — verified
directly: `db-index.ts`'s `tryReadValidIndex` checks the literal
`schema_version` value before/independent of full schema validation, so
any on-disk index at version 1 (or any other non-matching value) is
caught and rebuilt transparently, exactly like the pre-existing
missing/corrupt/stale-content cases.

### Getting real thresholds into `buildIndex` without threading config through every caller

`buildIndex`/`loadIndex` are called from several files this work item
must not touch (`repo/refs.ts`, `sessions/context-pack.ts`,
`tickets/slug.ts`, `cli/commands/show.ts`, ...), all with the bare
`loadIndex(paths)` call — no config parameter. Rather than widen that
signature (which would force edits to every one of those off-limits call
sites, or silently serve wrong thresholds to whichever of them doesn't
pass one), `buildIndex` now loads `.slop/config.yaml`'s `defaults.*`
itself, internally, via a new `repo/config.ts`
(`loadConfigDefaultsTolerant`) — **tolerant**: never throws, falls back
to `core/entities/config.ts`'s own schema defaults (`60m`/`24h`) on any
failure (missing file, unparseable text, schema mismatch), which is what
most existing unit-test fixtures need (`ensureDbDirs` alone, no
`config.yaml` written) and what a repo with a briefly-missing config.yaml
needs too — `buildIndex` must never be the thing that turns a config
hiccup into a crash for every downstream `loadIndex` caller (ref
resolution, `ready`, `status`, ...). This is deliberately NOT
`cli/actor.ts`'s `loadConfig` (which throws) — same reasoning `repo/config.ts`'s
own module doc gives. It reuses `cli/config-yaml.ts`'s `parseConfigYamlText`
(a pure text→object parser) rather than a second implementation, following
the existing precedent of `repo/paths.ts`/`repo/lock.ts`/`repo/refs.ts`
importing `cli/errors.ts`'s `SlopError` — a repo-layer file depending on a
narrow, pure cli-owned helper, not the reverse.

One consequence, accepted: since every caller gets the SAME
tolerantly-loaded config regardless of which one happens to trigger a
rebuild, `computeContentFingerprint` (db-index.ts) now ALSO fingerprints
`config.yaml` itself (a new `"config"` key, shaped like the existing
per-directory `{count, digest}` pair) — so hand-editing
`stale_after`/`review_stale_after` invalidates the index exactly like
editing a ticket file does, rather than silently doing nothing until some
unrelated ticket write happens to force a rebuild anyway.

### A deliberate, documented layering exception: `repo/db-index.ts` imports `tickets/staleness.ts`

The general rule elsewhere in this codebase is `tickets/*.ts` depends on
`repo/*.ts` (I/O), never the reverse (e.g. `tickets/cascade.ts` imports
`repo/index.ts`'s `loadIndex`/`createEvent`; `tickets/ready.ts` imports
the `IndexTicketRow` type from `repo/db-index.ts`). This work item's own
brief explicitly asks for `src/tickets/staleness.ts`, grouping the pure
staleness-deadline formula alongside its sibling pure ticket-domain
modules (`tickets/ready.ts`, `tickets/status.ts`, `tickets/cascade.ts`)
rather than in `core/` or duplicated inline in `db-index.ts`. Since
`staleness.ts` has zero imports back on `repo/` (it is pure — a ticket
-shaped object plus numbers in, a timestamp or boolean out, no I/O), there
is no import cycle, only a one-off crossing of the informal layering
convention — `repo/db-index.ts` imports `computeStaleAt`/
`computeReviewStaleAt` from `../tickets/staleness.js`, and
`tickets/ready.ts` imports `isStale`/`isReviewStale` from the same file
for its `--resumable` widening. Documented here so the next reader
doesn't mistake it for an accident.

### `ready --resumable` widened; a stale ticket with an active session is included, distinctly

`src/tickets/ready.ts`'s `filterResumableRows` now takes an explicit
`now: Date` and includes a row if EITHER it has no active session
(unchanged — the "stopped" case), OR it has one but has gone stale
(`isStale`/`isReviewStale` against `now`) — an agent that vanished
mid-session, or a review nobody's actually watching anymore despite an
"active" session on file. The two cases get distinct `ResumableReason`s
(`in_progress_no_session`/`review_no_session` vs. `in_progress_stale`/
`review_stale`) so the rendered "why" text tells them apart — "stopped;
resumable" reads very differently from "active session gone stale."
`src/cli/commands/ready.ts` supplies `now` via a new `SLOP_READY_FAKE_NOW`
clock-override env var (`ready` had no clock seam before C5; this adds
one, mirroring `status.ts`'s `SLOP_STATUS_FAKE_NOW` / `web.ts`'s
`SLOP_WEB_FAKE_NOW` exactly).

### The MR-link acceptance: `ready --resumable` and `status` both surface it

`IndexTicketRow` carries no `review` field at all (it's a summary row, not
the full ticket). For `ready --resumable`, `src/cli/commands/ready.ts`
does one `readTicket` per resumable **review**-state row (bounded — a
handful in practice, same fault-tolerant "degrade to null, warn on
stderr, never crash" contract `status.ts` already established for its own
per-review-ticket read) to attach `review.mr` to the JSON/text output; `ready`'s
strict (non-resumable) section never needs this, since review-state
tickets never appear there. For `status`, `src/tickets/status.ts`'s
`ReviewTicketRow` gained a `reviewStale: boolean` field, computed by
`src/cli/commands/status.ts` against the index row's `review_stale_at` —
rendered as a `[STALE]` tag ALONGSIDE the `mr` field the "awaiting review"
section already always shows for every row, stale or not (this work
item's acceptance, verbatim: "stale review ticket surfaces with MR
link"). `tests/acceptance/C5.test.ts` drives both paths end-to-end against
a directly-written `review`-state ticket fixture (`review --mr` is C3,
not yet built) under an injected clock, and asserts a FRESH review ticket
does NOT surface as stale in either surface.

### Out of scope, left alone: `slop web`'s stale panel

`src/web/overlays.ts` (D5) computes staleness independently, in-memory,
per HTTP request — already documented there as the "later work item
should swap in B4's persisted index.jsonc" TODO. This work item does not
touch `src/web/` per its own ground rules; unifying `slop web`'s
staleness computation with `tickets/staleness.ts`'s shared helper (so
there's exactly one `isStale`/`isReviewStale` implementation in the
codebase, not two that could drift — note web's already differs on the
`requested_at`-vs-`last_activity_at` question above) is real, valuable
follow-up work, but it's an E1 polish item, not C5's.
