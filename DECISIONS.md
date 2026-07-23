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
