# Slopwork — Engineering Decisions

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

## C3 — the session model: `review` captures a transcript but does NOT end the session; only `done`/`stop`/`drop` do

design.md §2 is explicit that `done` "finalizes the session" but is
deliberately non-committal about `review` ("records the MR and flips
state"), while §4.3 still lists `review` as a transcript-capture
checkpoint. The chosen resolution — the "clean model" the work item's own
brief suggested and this implementation adopted as-is — is: **a session
stays active (`ended_at: null`) across an entire `in_progress -> review ->
{done | re-entry}` round-trip; `review` only ever folds a fresh
`transcript_ref` snapshot into the SAME still-open session; `done`,
`stop`, and `drop` are the only three edges that ever set
`ended_at`/`end_summary`.** Concretely: `slop review --mr` reads the
ticket's active session, calls `captureTranscript` against it (§4.3's
"capture on every session end... or checkpoint" — a review round is a
checkpoint even though the session itself isn't ending), and folds only
`transcript_ref` into a `updateSession` write — `ended_at`/`end_summary`
are untouched. No dedicated "session updated" verb exists in the closed
`EVENT_VERBS` set, so this write reuses `review.requested` (the same verb
the ticket's own `in_progress -> review` transition emits), per
`src/sessions/transcript.ts`'s module doc, "Exactly how C3 must call
this" — two `review.requested` events, one per entity (session, ticket),
both under the same `slop review` invocation.

**Consequence this decision forced, and how it was closed:** since
`review` leaves `active_session` pointing at a still-*live* session, two
places elsewhere in the codebase would otherwise have silently done the
wrong thing once a ticket could actually reach `review` state (unreachable
before C3, since nothing wrote `state: "review"` until now):

1. **`slop start` on a `review`-state ticket** (D15's changes-requested
   re-entry) would have hit C1's *own-session-active* conflict check —
   the same one a genuine `--takeover` needs — and refused without
   `--takeover`, even though a plain re-`start` is documented, ordinary
   usage for this edge. Fixed in `src/cli/commands/start.ts`: the
   conflict gate is now skipped when `current.state === "review"`, and
   the superseded session is closed via a new local `buildReenteredSession`
   (accurate "review round ended, re-entered via `slop start`" wording,
   event verb `session.ended` with `payload: {reason: "review_reentry",
   re_entry: true}`) instead of `buildSupersededSession`/`session.takeover`
   — mechanically similar (old session ends, new one begins) but logged
   as what it actually is, not a takeover. `re_entry: true` also rides
   the `session.started` event's payload and (already, via C1's
   pre-existing `buildStartedTicket`) the `ticket.state_changed` event —
   three places an auditor can find the SAME re-entry, not one.
2. **`slop stop` on a `review`-state ticket** would have satisfied C1's
   `assertStoppable` (`active_session !== null` was its only check) and
   silently performed `review -> open`, an edge that does not exist
   anywhere in §2's diagram. Fixed with one added guard clause in
   `src/sessions/stop.ts`'s `assertStoppable`: a `review`-state ticket is
   now refused (CONFLICT, exit 6), pointing at `slop done`/`slop start`
   instead. Both fixes are covered directly (`start.test.ts`'s existing
   D15 re-entry cases plus `stop.test.ts`'s new refusal case) and
   end-to-end (`tests/acceptance/C3.test.ts`'s state-machine property test
   and its dedicated re-entry describe block).

`review`/`done`/`drop` never write more than one `updateSession` call
each, so `active_session`, `ended_at`, `transcript_ref`, and the end
summary can never disagree with each other or with `ticket.review`: the
ticket schema's own refine (`review` present iff `state === "review"`)
plus this session-lifecycle discipline together keep every reachable
state — `in_progress` (session active, no `review`), `review` (session
still active, `review` set), `done`/`dropped` (session ended,
`active_session: null`, `review` cleared) — internally coherent by
construction, not by convention. `tests/acceptance/C3.test.ts`'s property
test asserts this directly after every step of every generated operation
sequence, not just at the end.

## C3 — `done` requires `review` first; there is no direct `in_progress -> done` shortcut (SUPERSEDED — see "review made optional" below)

**Superseded by ticket_01KY9RWFDR9QEWQ5B1ZACQJ338** (this file's own
newest entry, at the bottom): `checkDoneEntry` now also accepts a direct
`in_progress -> done` edge, with a non-`adhoc`-only nag replacing the
hard CONFLICT this entry originally documented. Kept below verbatim as
the historical record of the original v0 call and its reasoning; do not
treat it as the current behavior.

design.md §2's diagram draws `review --done--> done` as the only path
into `done` — no `in_progress -> done` edge exists in the diagram at all —
and §5's house rule for agents is explicit: "open an MR and call `review`
before claiming done." Given the work item's brief explicitly allowed
either choice provided it's enforced and documented, this implementation
requires `review` first, matching both the diagram and the house rule
literally rather than treating them as aspirational. Enforced by
`src/tickets/state.ts`'s new `checkDoneEntry` (`ok` only when `from ===
"review"`), which `slop done` (`src/cli/commands/done.ts`) checks before
doing anything else — `slop done` on an `in_progress` ticket is a
CONFLICT (exit 6) naming the missing `slop review --mr` step, not a
silent skip-the-review shortcut. `slop drop`, by contrast, keeps §2's
"dropped (wontdo) from anywhere" literally: legal from `draft`/`open`/
`in_progress`/`review` alike (`checkDropEntry`), since dropping was never
gated on review in the first place.

## C3 — `slop review`/`done`/`drop` get their own single-edge legality checks in `state.ts`, not a same-state shortcut

Extending `src/tickets/state.ts` (per this work item's brief: "extend
this, do not fork a second table") added `checkReviewEntry`,
`checkDoneEntry`, `checkDropEntry` — one exported function per edge
`checkStateTransition`'s own `to === "review"`/`to === "done"` branches
already excluded (plus a stricter `-> dropped` check) — rather than a
second `Record<TicketState, TicketState[]>` adjacency table. Together
with the pre-existing `RAW_STATE_TRANSITIONS`, these three now cover every
edge in §2's diagram with nothing left implicit. Deliberately WITHOUT
`checkStateTransition`'s `from === to` same-state shortcut (draft/undraft
keep that convention — re-running `slop draft` on an already-draft
ticket is a harmless, B2-established no-op): `slop review`/`done`/`drop`
are real, side-effecting actions (session finalization, MR recording, the
done-cascade), not idempotent field setters, so calling any of them a
second time on a ticket already at the target state is treated as a
genuine usage mistake (CONFLICT, exit 6) — most concretely, `checkDropEntry`
is intentionally NOT implemented as `checkStateTransition(from,
"dropped")`, because that function's same-state shortcut would otherwise
let a second `slop drop` on an already-dropped ticket through as a silent
no-op.

## C3 — done/drop call B4's `cascadeOnClose` exactly once, immediately after writing the terminal state, inside the same lock

Both `src/cli/commands/done.ts` and `drop.ts` follow the exact shape
`cascade.ts`'s own module doc prescribes: resolve the ticket, open one
`withLock`, write the session-finalize update (if there's a session to
finalize), `lock.assertHeld()`, write the ticket's terminal state
(`done`/`dropped`) with its own dedicated verb (`ticket.done`/
`ticket.dropped`), `lock.assertHeld()` again, THEN call `cascadeOnClose`
once — never in a loop, never re-invoked speculatively "just in case."
`drop` treats "no active session" (an `open`/`draft` ticket with nothing
started) as a legitimate skip of the session-finalize step entirely, not
an error — §2's "dropped... from anywhere" includes states that never had
a session to begin with. B4's cascade treats `done`/`dropped` identically
as "no longer a live blocker" (`isLiveBlockerState`), so both commands'
single `cascadeOnClose` call is exactly the mechanism §4.7's dogfood bar
("every completed ticket... a transcript" / clean audit trail) depends
on. The concurrently-landed cascade-idempotency fix (this file's B4 entry
above) means a hypothetical future retry-after-partial-failure caller
could safely re-invoke `cascadeOnClose` a second time without duplicate
`ticket.ready` events — but neither `done.ts` nor `drop.ts` does this
today; the acceptance test's e2e/drop cases assert exactly one
`ticket.ready` event per closure.

## C3 — `--mr` is required-with-warning: `slop review` without it still succeeds

Per design.md §8.1 item 3 / D15, `slop review <ref>` with no `--mr`
prints a `warning:` line to stderr (naming the exact `--mr <url>` flag to
re-run with) and still performs the `in_progress -> review` transition,
leaving `ticket.review.mr` absent (not `null` — an honest "we don't know
yet," matching `reviewSchema`'s `mr: z.url().optional()`). `--mr <url>`
suppresses the nag and records the link. Both halves are asserted
directly in `tests/acceptance/C3.test.ts`'s dedicated clause-2 describe
block, and exercised incidentally throughout the property test (each
generated `review` step randomly includes or omits `--mr`).

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

## E1 — `--json`/`--budget` never corrupt JSON: one shared helper, two shapes

B4's adversarial review found `ready --json --budget <tiny>` could emit
invalid, truncated-mid-structure JSON on exit 0 — the character-budget
eliding helper (`sessions/context-budget.ts`, built for prose) falls back
to a raw string slice as its last resort, which corrupts JSON. Deferred to
this work item, whose brief asked for a shared fix across every command
pairing `--json` with `--budget`.

**`src/core/budget.ts`** (new, pure, zero I/O — the lowest layer, so every
other layer can depend on it without a cycle) holds two helpers, matching
the two shapes of unbounded output this codebase has:

- `renderEntriesWithBudget` — **list-shaped** output (`ready`'s combined
  rows, `search`'s ranked results, `events`' event page, `status`'s three
  row-sections combined into one elision-priority list). Elides whole
  entries from the tail; for `format: "json"`, the final fallback is the
  already-valid EMPTY-entries envelope returned as-is (never sliced),
  reported via `withinBudget: false` when even that doesn't fit — a
  budget of 0 or 1 characters can never truly be met by valid JSON, and
  that's an honest, non-corrupting answer to an unmeetable request, not a
  bug. `tickets/ready.ts`'s `renderReadyWithBudget` is now a thin wrapper
  over this (kept for its existing call sites/doc, `format` defaults to
  `"text"` for backward compatibility).
- `renderJsonBodyWithBudget` — **single-object-shaped** output (`context`'s
  pack; by extension `show --context --json`, which reuses the same
  function). Takes an explicit degradation ladder of candidate builders,
  most-complete first; the first whose JSON fits wins, and if none do, the
  LAST (caller-guaranteed-minimal) candidate is returned as-is.
  `context-budget.ts`'s `renderContextPackJsonWithBudget` mostly hand-rolls
  its OWN elision loop (session-dropping, then a `details_md` binary
  search) rather than expressing every step as a ladder candidate — that
  needs iterative search granularity a short fixed candidate list can't
  give cheaply — but its OWN final fallback step (drop everything down to
  ticket-core-fields-only) calls `renderJsonBodyWithBudget` directly for
  exactly the "return the guaranteed-minimal candidate as-is, valid JSON,
  possibly over budget" decision, rather than re-deriving that one-line
  policy a third time.

**`show`'s `--budget` floor** (E1's brief explicitly sanctions this: "a
single show of one ticket may exceed a tiny budget... define and document
the floor behaviour"): `--budget` only ever bounds the `--context`
sub-object (reusing `context`'s own budget machinery directly, not
re-deriving it) — the surrounding `ticket`/`tree` JSON fields, and the
plain (no-`--context`) ticket detail in text mode, are never elided. A
bare `show <ref>` returns exactly one ticket's data, which isn't a list to
drop entries from; `--budget` genuinely has no effect there, documented in
the command's own `--help` text rather than silently ignored.

**`show --context --budget`'s unit reconciled to characters.** Before this
work item, `show --context --budget N` meant "~4×N characters" (a rough
token estimate, `tickets/context.ts`'s `budgetCharsFromTokens`) while
`slop context --budget N` meant "exactly N characters" — a real,
documented inconsistency (`sessions/context-budget.ts`'s module doc
flagged it for E1 by name). `show.ts` now calls the same
`renderContextPackWithBudget`/`renderContextPackJsonWithBudget` `context`
itself uses; `budgetCharsFromTokens` stays exported (still unit-tested,
still documented) but nothing in the CLI wires it anymore.

**`status --budget`'s elision order**: the three list sections
(`in_progress`, `review`, `stale`) are combined into ONE elision-priority
list — `in_progress` first (kept longest), `review` second, `stale` last
(dropped first, since it's a derived overlay largely redundant with the
`stale`/`review_stale` flags the other two sections already carry).
`counts`/`derived`/`problems` are never elided — small, fixed-size, and
the entire point of a pulse view. This is a genuine behavior change from
D4's original "`--json` is never truncated" — superseded here since "every
read respects budget" is this work item's own acceptance clause.

## E1 — `draft`/`undraft` on an already-target-state ticket: no-op, not a fake mutation

`assertDraftable`/`assertUndraftable` (`tickets/draft.ts`, B2) treat
`draft -> draft` / `open -> open` as legal (idempotent) rather than
CONFLICT — correct, and unchanged here. But the CLI commands used to fall
through into a REAL `buildUpdate` + `updateTicket` call regardless, which
silently bumped `updated_at` and emitted an empty-payload `ticket.updated`
event for a call that changed NOTHING, while printing `drafted `/
`undrafted ` — actively misleading when the ticket was already at the
target state. Fixed by short-circuiting before any write when
`current.state` already equals the target: no write, no event, and the
message says "already draft"/"already open — no changes made" instead.
A genuine illegal transition (e.g. `draft` on an `in_progress` ticket)
still throws CONFLICT (exit 6) from the existing guard, unaffected — this
only touches the one case that guard already treats as legal.

## E1 — exit-code audit finding: every `parseIntegerOption`-style flag parser exited 1, not the documented 2

`src/cli/commands/shared.ts`'s `parseIntegerOption` (backing `--priority`,
`--limit`, `--check`/`--uncheck`, `--port`, and several `--budget` flags),
plus `context.ts`'s `parseBudgetFlag` and `start.ts`'s `parseHarnessFlag`,
all threw a bare `new Error(...)` on a malformed value, on a documented
assumption ("caught and reported by the top-level Commander error
handling") that turned out to be false: Commander's `_callParseArg` only
intercepts errors carrying its own `commander.invalidArgument` code, so a
plain `Error` propagates past Commander's handling entirely and lands in
`src/cli/index.ts`'s generic catch, which treats a non-`SlopError` `Error`
as `GENERIC_ERROR` (1) — verified directly against the compiled binary
(`slop new x --priority notanumber` exited 1). Every one of these now
throws a `SlopError(..., EXIT_CODES.USAGE_ERROR)` instead, landing on the
documented 2 regardless of which layer's `catch` actually handles it.
Found via this work item's own exit-code audit, not a pre-existing bug
report — `tests/acceptance/E1.test.ts`'s usage-error matrix now guards it.

## Adversarial-review fixes (post-E2): `update --state` escape hatch, C3 property-test vocabulary, `review --mr` atomicity, fresh-clone crash, `updated_at` merge behaviour

Five findings from an adversarial review of C3 plus the E2 merge
simulation, fixed together (all touch the same lifecycle/merge surface).

**Fix 1 (CRITICAL) — `update --state` was an unguarded escape hatch around
the lifecycle.** B1's original guard (`src/tickets/state.ts`'s
`checkStateTransition`) only excluded `to === "review"`/`to === "done"`
(the two edges needing data the mutator doesn't have) but still let
`update --state` perform `open -> in_progress`, `in_progress -> open`,
`review -> in_progress`, and `-> dropped` directly — every one of which
ALSO needs session-lifecycle machinery this generic, side-effect-free
mutator doesn't have. Concretely exploitable: `start X` (in_progress,
`active_session: S`) → `update X --state dropped` left the ticket
`dropped` with `active_session` STILL `S` and no B4 cascade (dependents
never got `ticket.ready`); a later `stop X` then performed `dropped ->
open`, RESURRECTING a terminal ticket — `stop`'s own guard
(`sessions/stop.ts`'s `assertStoppable`) had never needed to consider
"already dropped" because no legal path to that combination existed
before this hole. Separately, `update X --state open` on an `in_progress`
ticket orphaned the session (state moves to `open`, `active_session`
stays set — invisible to `ready`, which requires `active_session ===
null`, yet unable to be `start`ed again without `--takeover`); and
`update X --state in_progress` on a `review` ticket was a second,
UNLOGGED "changes-requested" path — no fresh session, no `re_entry` flag
— parallel to and inconsistent with `slop start`'s D15 re-entry.

**Fix:** `RAW_STATE_TRANSITIONS` narrowed to exactly D13's `draft ⇄ open`
edge (`draft: ["open"], open: ["draft"], in_progress: [], review: []`),
and `checkStateTransition` extended with dedicated rejections for `to ===
"dropped"`/`to === "in_progress"` and for leaving `in_progress`/`review`
at all (even to `"open"`) — each naming the dedicated command
(`slop start`/`slop stop`/`slop review`/`slop done`/`slop drop`) that
actually has the session/lock-aware machinery the transition needs. Same
-state is still always a legal no-op (mutates nothing, so it can never
desync the db), checked first, before anything else — including on a
terminal ticket, which is also the adversarial review's minor finding 6:
the terminal-state check now runs BEFORE the dedicated-command messages,
so `update <done-ticket> --state review` reports "terminal state," not
the misleading "use `slop review --mr`" (implying the command would
succeed from `done`, which `checkReviewEntry` also rejects). Nothing else
in the codebase calls `checkStateTransition` directly — `draft`/`undraft`
(`src/tickets/draft.ts`) pre-narrow their own legal `from` states via
`assertDraftable`/`assertUndraftable` before ever reaching `buildUpdate`,
so both still work unchanged; `start`/`stop` have always used their own
separate `assertStartable`/`assertStoppable`, never this table.

**Fix 2 (test) — C3's property test didn't even generate `update --state`
calls, which is exactly why it missed Fix 1's class of bug**, and at
`numRuns: 20` a seeded single-rule regression was caught only ~4/15
repeat invocations (~27%). `tests/acceptance/C3.test.ts`'s op vocabulary
now includes `"update"` (with a randomly generated `--state <target>`,
legality checked by a second hand-written oracle, `isUpdateStateLegal`,
independent of the implementation exactly like `ORACLE` itself), and
`numRuns` raised from 20 to 150. Measured directly (temporarily
re-seeding each mutation in a scratch copy of `state.ts`, rebuilding, and
re-running the property test's own `-t` selector repeatedly): the `update
--state dropped` escape hatch was 0/5 catchable with the OLD vocabulary
at 20 runs (structurally unreachable — no `update` op existed) and 12/12
(100%) with the NEW vocabulary at 150 runs; the pre-existing
`in_progress -> done` regression (`checkDoneEntry`, reachable via the
plain `done` op, unrelated to `update`) went from the reported ~27% at 20
runs to ~81-92% (13/16, 11/12 in two separate measured batches) at
150-200 runs. 150 was kept as the final number — 100% in local
measurement on Fix 1's own bug class, the concrete motivation for this
change, while keeping the file's wall-clock cost in the same ballpark as
this project's other subprocess-spawning acceptance suites.

**Fix 3 — `review --mr <invalid-url>` wasn't atomic.**
`src/cli/commands/review.ts` used to fold `transcript_ref` into the
active session (an `updateSession` write + a `review.requested` session
event) BEFORE `buildReviewedTicket` validated `--mr` via `reviewSchema`'s
`z.url()` — an invalid URL left that write behind (an orphaned
session-side event, a wasted transcript capture) for an operation that
then failed anyway (exit 1, GENERIC_ERROR — a bad argument reported as an
internal error, the wrong exit code besides). Fixed by validating `--mr`'s
shape up front, before the lock, before resolving `<ref>`, before any
read or write, via a new shared `mrUrlSchema` (`core/entities/ticket.ts`
— the exact schema `reviewSchema.mr` already used, factored out so the
two can never drift), failing with `USAGE_ERROR` (exit 2 — this is a bad
argument, not a state CONFLICT) on a malformed non-empty `--mr`. An
empty/whitespace-only `--mr` is still treated as omitted (D15's
required-with-warning), unchanged.

**Fix 4 — a fresh clone could crash writing into a git-untracked empty
db directory.** Git does not track empty directories, so a committed
`.slop/db` missing e.g. `sessions/` (no session ever created there) has
that directory entirely ABSENT after a fresh clone — and
`atomicWriteFile` (`src/repo/atomic-write.ts`) never `mkdir`ed the
target's directory, so the first write of that kind threw a raw ENOENT.
Confirmed this affected THIS repo's own committed `.slop/db` (`tickets/`
and `events/` present, `sessions/` empty and untracked — a fresh clone
would have crashed on the first `slop start`). Two-part fix: **(1)**
`atomicWriteFile` now calls `mkdir(dir, {recursive: true})` before
opening the temp file — self-healing at the single lowest-level write
primitive every entity write, the lock file, transcript capture, and
`init`'s own config/doc writes all already funnel through, rather than
threading "does this directory exist yet" through each call site
individually. **(2)** `slop init` (`src/cli/commands/init.ts`) now also
writes a tracked, empty `.gitkeep` placeholder into each of `tickets/`,
`sessions/`, `events/` (idempotent — only when absent), so a freshly
-initialized repo's db skeleton is always complete and committable from
the start; this repo's own `.slop/db/sessions/.gitkeep` was added
alongside this change. The E2 merge simulation's `slop init --yes` re-run
workaround on both clones (`tests/acceptance/e2-merge-sim.ts`) is removed
— no longer needed — and E2's `it.fails` regression test for this defect
(`tests/acceptance/E2.test.ts`) is now a normal passing test, plus a
second test that isolates fix (1) alone (deletes the tracked `.gitkeep`
before committing, to prove the self-heal — not just the placeholder —
independently prevents the crash).

**Fix 5 — `updated_at`'s merge behaviour is documented, accepted v0
behaviour, not a defect to chase.** E2's `it.fails` asserted that two
clones editing DIFFERENT fields of the SAME ticket merge with zero
conflicts; today they conflict on the trailing `updated_at` line (bumped
on every write, always the file's last field). That assertion read the
acceptance bar too literally: the SAME goal condition explicitly allows
"zero manual conflicts *except same-ticket edits*," and a different-field
edit is still a same-ticket edit — the carve-out applies. The principled
fix (deriving `updated_at` from the immutable event log instead of
stamping it on every write, so even this bookkeeping field stops
colliding) is a schema change judged too risky this late in v0 — NOT
done here. Instead, `tests/acceptance/E2.test.ts`'s `it.fails` is now a
normal passing test asserting the actual, acceptable shape: create/close
and different-*ticket* edits merge with zero conflicts (already covered
by this file's very first test in the same describe block), and a
same-ticket different-field edit conflicts on EXACTLY the `updated_at`
line — one hunk, both clones' real edits present and unconflicted
everywhere else in the file (the pre-existing "characterizes..." test,
kept, now reframed as characterizing accepted behavior rather than an
open defect). `tests/acceptance/e2-merge-sim.ts`'s module doc and
`formatReport()` output were reworded to match (`KNOWN ISSUE` /
`real defect` → `KNOWN BEHAVIOR` / documented, accepted). The ticket
schema and `updated_at` bumping are untouched by this fix.

## C3 — review made optional: `done` now also accepts a direct `in_progress -> done` edge, with a non-`adhoc` nag replacing the old CONFLICT (ticket_01KY9RWFDR9QEWQ5B1ZACQJ338)

**Supersedes this file's earlier "`done` requires `review` first" entry
above.** design.md §2's diagram was revised to draw a direct
`in_progress -> done` edge alongside `review -> done`, making review an
optional checkpoint rather than a mandatory gate. `checkDoneEntry`
(`src/tickets/state.ts`) now returns `ok: true` for `from === "review"`
OR `from === "in_progress"` — legality is unconditional on `adhoc`; this
function only ever answers "is the edge legal," never "should it warn."

Discipline is preserved one layer up instead, in `slop done`
(`src/cli/commands/done.ts`), by a NAG rather than a block — the same
required-with-warning philosophy this file's own `--mr` entry above
already documents for `review --mr`. When `runDone` completes a ticket
whose `current.state === "in_progress" && current.adhoc !== true` (i.e.
it never went through `review`), it prints, on stderr, AFTER the
transaction commits (same convention as the transcript-miss warning):

```
warning: <id> (<slug>) done without a review/MR — if this had a code
change, open an MR and run `slop review --mr <url>` first next time
(D15: review is optional, not required)
```

`adhoc` tickets get no nag at all (D13 already exempts them from the
usual planning ceremony, and review is part of that ceremony), and
`review -> done` is unaffected — never nagged, exactly as before. Exit
code is 0 either way; the transition, session finalization, and B4
cascade all proceed identically regardless of which of the two legal
entry states triggered them. `slop drop`'s "dropped (wontdo) from
anywhere" behavior is untouched by this change.

## Tooling — oxlint adopted (replaces Biome's linter); oxfmt deferred; deps already current (ticket_01KY9RVF5PBVGEQG69H3AKDM6W)

Final "modern tooling" pass. Version survey (`bun outdated` + `npm view` against every runtime/dev dependency, 2026-07-24): `typescript` (7.0.2), `zod` (4.4.3), `commander` (15.0.0), `jsonc-parser` (3.3.1), `ulid` (3.0.2), `fast-check` (4.9.0), `vitest`/`@vitest/coverage-v8` (4.1.10), `@types/bun` (1.3.14) were all ALREADY at npm's `latest` — nothing to bump. Only `@biomejs/biome` had a move available, 2.5.4 -> 2.5.5 (patch); applied, full gate re-verified green after.

**oxlint — adopted, replaces `biome lint` outright (not run alongside it).** `oxlint@1.74.0` (npm's newest is 1.75.0, published 3 days before this pass and blocked by this machine's own `min-release-age=3` npmrc guard — 1.74.0 is the actual latest-available; a supply-chain safeguard already in place, not something to fight) is a mature, actively-developed Rust linter (v1.x, 202 published versions) with meaningfully more rules than Biome's linter and — per `slop`'s own performance ethos (this whole project's shtick is a fast Rust-adjacent CLI) — dramatically faster. Running it out of the box (default `correctness`-plus-recommended rule set across the `typescript`/`unicorn`/`oxc` plugins it enables by default) surfaced 6 real findings, all fixed: four call sites used `new Array(n).fill(x)` (`src/sessions/plan.ts:56`, `src/sessions/plan-diff.ts:62`, `tests/acceptance/B3.test.ts:255,454` — the `unicorn/no-new-array` "is n a length or the only element" ambiguity), replaced with `Array.from({ length: n }, () => x)`; two used a redundant `[...arr.map(...)].sort()` spread (`src/repo/events.test.ts:327,343` — `.map()` already returns a fresh array, the spread before `.sort()` did nothing) replaced with `arr.map(...).sort()`. `.oxlintrc.json` pins the plugin set explicitly (`typescript`, `unicorn`, `oxc`, plus `import` — enabled after confirming it adds zero findings and ~70ms overhead on this codebase, i.e. free defense-in-depth for this `"type": "module"`/bundler-resolution project) and `categories.correctness: "error"`, matching oxlint's own `--init` template. **Deliberately NOT enabled: `--vitest-plugin`.** Tried it — 373 warnings, the overwhelming majority `vitest/valid-expect` false positives against this codebase's own established, deliberate pattern of `expect(actual, customMessage)` (e.g. `src/tickets/state.test.ts:41` — the second argument is Vitest's supported per-assertion failure-message override, used throughout this repo's loop-driven tests to identify which iteration failed) plus a cluster of `no-conditional-expect` hits on tests that intentionally assert inside a caught-error branch. This is exactly the "noisy/opinionated rule that doesn't fit this codebase" case the ticket calls out for curation rather than a mass rewrite — left off, documented here instead of silenced file-by-file. `biome.json`'s `linter` block is now `{"enabled": false}` (formatter + the `assist`/organize-imports config are untouched, still Biome's job); `package.json`'s `lint`/`lint:fix` scripts now run `oxlint .` / `oxlint . --fix` in place of `biome lint`; no CI change needed beyond that since `.github/workflows/ci.yml` already just calls `bun run lint` by name.

**oxfmt — evaluated, deferred; Biome stays the formatter.** `oxfmt` is still pre-1.0 (0.60.0 on npm; 0.59.0 is the latest this machine's release-age guard actually allows — either way, sub-1.0 by the project's own semver signal) despite the underlying `oxc_formatter` being maintained by the same team as the now-mature `oxlint`. Its own changelog shows a `formatter/sort_imports` **BREAKING** rename as recently as v0.33.0 (2026-02-16) and *new* features still landing as "Experimental" (`.svelte` support, v0.49.0, 2026-05-11) — a tool still actively settling its config surface, not a drop-in-and-forget swap. Concretely verified against this repo rather than taken on faith: `bunx oxfmt@0.59.0 --check` (non-destructive) over `src/**/*.ts tests/**/*.ts` flags 11 of 238 files as differing from Biome's current output, and the diffs are not cosmetic — e.g. `src/web/views/tree.ts` gets a materially different line-wrap/indent of `html\`...\`` tagged-template markup throughout the file (reflowed multi-line JSX-like content, not just quote/semicolon nits). That fails this ticket's own bar ("a clean, reviewable result") for adoption; forcing it through now would mean an unreviewable churn-everything diff for a formatter that itself says "stay on [the incumbent] if you still depend on exact plugin behavior not yet covered." (oxfmt does correctly format `.json`/`.jsonc` too — not a blocker on its own, just not the deciding factor either way.) Revisit once `oxfmt` reaches a 1.0 release.

**`jsonc-parser` stays at 3.3.1 (already latest) — the defensive hybrid-write logic in `src/core/jsonc.ts` is untouched, on purpose.** No newer release exists to fix the documented inline-array-delete corruption bug (`spikes/jsonc.md`, `src/core/jsonc.ts`'s own header comment) this pass could have picked up even if it wanted to; `writeUpdate`'s mandatory reparse-and-validate safety net remains the only defense and was explicitly out of scope to touch or remove here regardless.
