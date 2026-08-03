# Changelog

Notable changes to `slopwork`. Format loosely follows [Keep a Changelog]; this
project uses [semantic versioning], and while it is `0.x` the minor version is
where breaking changes land.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[semantic versioning]: https://semver.org/

## Unreleased

### Added

- **Auto-compact events into a per-ticket archive on terminal transitions**
  (t-7eq5s). `slop done`/`slop drop` now fold a closing ticket's full event
  history — every `ticket.*`/`session.*`/`plan.*`/... event it or its
  sessions ever produced, full records, never summaries — into
  `events/archive/<ticket_id>.jsonc`, deleting the now-redundant loose
  originals, inside the same write transaction as the terminal-state write.
  One-file-per-event is unchanged for LIVE tickets (still load-bearing for
  conflict-free parallel appends and lock-free `--progress`); this only
  ever touches a ticket once it's `done`/`dropped`. Reads are unaffected:
  `slop show`, `slop events` (`--since`/`--poll`/`--ticket`), and the web
  audit spine all merge archived and loose events transparently — same
  ids, same order, byte-identical output before and after compaction — and
  a merge-safe poll cursor taken before a close resumes correctly after.
  Design choice: one archive file per TICKET (not embedded on the ticket
  entity), so a ticket's own metadata reads — the hottest path in this
  codebase — never pay to parse its full historical event count; a
  cross-clone double-close (illegal within one db, but possible across
  unsynced clones) produces an ordinary, human-resolvable small-file
  conflict on the archive, no different in kind from the ticket file's own
  existing `state`/`updated_at` conflict in that scenario, and every read
  path dedupes by event id so a "keep both" resolution loses nothing. New
  `slop reindex --compact` retroactively (and idempotently) runs the same
  compaction for every already-closed ticket in a db — the migration path
  for a repo whose closed tickets predate this feature — and, like
  `--shard-events`, never runs implicitly. See [Concurrency & merging →
  Event-archive
  compaction](docs/concurrency-and-merging.md#event-archive-compaction-t-7eq5s).
- **Bounded the remaining unbounded web API collections** (t-m1j8y): the
  review/stale/questions panels and a ticket's events/sessions timeline now
  take the same validated, capped `page`/`limit` query params `GET
  /api/tickets` already established (50 default, 100 max, a 400
  `ApiErrorDTO` over the max or on a non-positive-integer value) — same
  envelope shape (`page`/`limit`/`total`/`total_pages`/`previous_page`/
  `next_page`), just without the extra whole-repo-vs-filtered split that
  endpoint alone needs. `GET /api/tree` bounds the nested hierarchy
  differently, since it has no "page N" of its own: a total node budget (500
  default, 1,000 max) walked breadth-first across roots, plus a per-branch
  depth budget (6 default, 12 max); each node now carries `has_children`/
  `children_truncated` so a client can tell "this subtree is complete" from
  "there's more here, not shown" even where the walk stopped short. The SPA
  gained a reusable `CollectionLoadMore` control + `useLoadMoreCollection`
  hook (review/stale/questions panels, and the ticket-detail page's
  events/sessions tabs) and the tree page now reads `has_children`/
  `children_truncated` instead of inferring from a (possibly bounded)
  `children` array, with a banner when the whole response was truncated.
- **Merge-safe event polling cursors** (t-r0hnj). `slop events --since
  <event_id>` is a scalar ULID watermark: an event created earlier on
  another clone can still arrive later (after a Git merge of `.slop/db/`)
  and sort BEFORE that watermark, so it is permanently skipped by every
  future poll — there is no way to move the watermark backward without
  re-scanning everything already consumed. `slop events --poll [cursor]`
  replaces the watermark with an opaque `cursor_v1_<hex>` token over a
  durable, versioned set of event ids already returned to that consumer
  (`src/repo/event-cursor.ts`, lock-serialized under the same `.lock`
  writes already use). A poll only ever advances by unioning the ids it
  actually returned into that set, so a late-merged event with an older
  id is still discovered on the next call — it simply isn't in the seen
  set yet. Four new `StorageBackend` methods carry this over the wire
  contract: `createEventPollCursor`, `readEventPollCursor`,
  `advanceEventPollCursor`, `deleteEventPollCursor`
  (`docs/storage-backends.md`'s `/v1/event-cursors*` endpoints);
  `FlatfileBackend` implements them against gitignored state under
  `.slop/db/event-cursors/`, `RemoteBackend` fails loud like every other
  unimplemented remote method. `--json` now reports `cursor_mode`
  (`static_snapshot` vs. `merge_safe_poll`) and `poll_cursor` alongside
  the legacy `next_cursor`; `--since` remains for scripts paging a fixed
  snapshot but is documented as exclusion-only, not a durable watermark,
  and warns on every use. `--delete-poll-cursor <cursor>` retires a
  cursor's stored state.
- **`slop init` manages `.gitattributes`** (t-mgx82). Same idempotent,
  append-don't-clobber managed-section convention `init` already used for
  `.gitignore`: created if absent, appended if `.gitattributes` exists
  without the section, byte-identical on repeat runs, and never touches
  content outside its own markers. The managed section marks the tracker
  database as generated for both GitHub and GitLab
  (`.slop/db/** linguist-generated gitlab-generated`, so it collapses in
  PR/MR diffs by default) and scopes LF enforcement to just the db
  (`.slop/db/**/*.jsonc text eol=lf`), which the flatfile db's merge story
  depends on.
- **`slop ready` is leaf-first.** Direct or transitive parents with any
  nonterminal descendant are omitted from both the strict and `--resumable`
  queues, so agents pull actionable leaf work instead of umbrella tickets.
  Terminal (`done`/`dropped`) descendants do not suppress a parent; ordering
  among eligible tickets remains priority then age.
- **Frontend regression gates for `slop web`.** A jsdom component suite covers
  fetch timeout/retry, route recovery, and tree interaction/persistence; a
  Playwright Chromium suite exercises real desktop/mobile flows, keyboard
  controls, accessible navigation names, layout bounds, and visual snapshots.
  Both CI and release workflows enforce the new gates.
- **Crash-recoverable entity/event writes.** Flatfile ticket and session
  creates/updates now persist a gitignored write-ahead intent before the
  entity changes and retire it only after the matching pre-minted event is
  durable. Pending intents replay automatically under the db lock on
  storage open or the next transaction; replay is idempotent and refuses
  to overwrite divergent entity state or a different event with the same
  id. This closes the crash window where a committed entity mutation could
  permanently lose its audit event. See
  [Concurrency & merging → Crash recovery](docs/concurrency-and-merging.md#crash-recovery-for-entity--event-pairs).
- **Elicitations: structured questions, `awaiting_input`, questions inbox**
  (G4, t-jggg9). The only agent→human escalation channel used to be a
  string convention (`update --progress "QUESTION: …"`) with no state, no
  inbox, and no filter. Three new commands replace it:
  - `slop ask <ticket-ref> "<question>" [--option "<text>"]...` records a
    `question.asked` event (ticket-scoped, actor-attributed; `--option` is
    repeatable, for multiple-choice questions).
  - `slop answer <question-id> "<answer>"` records a `question.answered`
    event referencing the question it closes (`<question-id>` accepts a
    full event id or a unique short prefix, same as any other ref).
    Answering an already-answered question is a `CONFLICT` (exit `6`).
  - `slop questions` is the inbox: unanswered questions, oldest first,
    grouped by ticket; `--all` includes answered ones; `--ticket <ref>`
    scopes to one ticket; `--json`/`--budget` throughout.

  Questions are events, not a new stored entity — this keeps the
  merge-clean, immutable one-file-per-event property and puts them on the
  same audit spine as everything else. `awaiting_input` is a new derived
  overlay (never stored, computed identically by the CLI and `slop web`,
  `src/tickets/overlay.ts`): a ticket has it iff it has `>=1` unanswered
  question. It surfaces in `slop status` (a new "Awaiting input" section),
  `slop list` (a badge + `--awaiting-input` filter), and `slop show` (open
  questions rendered prominently, before `spec`). **`slop ready` excludes
  `awaiting_input` tickets by default** (`--include-awaiting` overrides) —
  an agent picking up a ticket blocked on an unanswered question just
  stalls on the same question the last session already hit. The web UI
  gains a Questions panel (`/questions`, `GET /api/questions`) mirroring
  the review panel's "longest-waiting-first" shape, an `awaiting_input`
  overlay badge on the ticket list/detail (same treatment as
  `blocked`/`stale`), and `question.asked`/`question.answered` events on
  the ticket-detail audit spine, with an answer visually paired with the
  question it closes. See
  [CLI reference → `ask`](docs/cli-reference.md#ask)/
  [`answer`](docs/cli-reference.md#answer)/
  [`questions`](docs/cli-reference.md#questions) and
  [Concepts → derived overlays](docs/concepts.md#derived-overlays-blocked-stale-ready-awaiting_input).

  The old `update --progress "QUESTION: …"` convention still works (it's
  just a progress note, never validated) but is no longer the recommended
  path — onboarding docs (`slop instructions`, the Claude Code skill) point
  at `slop ask` instead.
- **Pluggable storage backend** (G2). Every command and `slop web` now go
  through a `StorageBackend` interface (`src/storage/`) instead of
  importing the flatfile repo layer directly — sized to what the 22
  commands and the web explorer actually need: ticket/session CRUD, event
  append/query, ref resolution, the derived index, and a transactional
  write scope. `.slop/config.yaml` gains a `backend:` key selecting the
  implementation (absent, or `backend: flatfile`, is the default and needs
  no configuration); see [Configuration → Storage
  backend](docs/configuration.md#storage-backend).
- **Remote backend stub + wire contract** (`backend: remote`/
  `backend: {kind: remote, url: ...}`). No real remote store exists yet —
  every call fails immediately with a clear, non-crashing error (exit `1`)
  naming the new [`docs/storage-backends.md`](docs/storage-backends.md),
  which specifies the full JSON-over-HTTP contract (every endpoint, error
  → exit-code mapping, the transaction lease model, auth via
  `SLOP_REMOTE_TOKEN`) a real implementation must speak.
- **Event storage shards by calendar month.** New events land under
  `.slop/db/events/YYYY-MM/` (UTC month from the event's own id) instead
  of flat in `events/`; every read path merges flat and sharded layouts
  transparently, so this is invisible until you look. `slop reindex
  --shard-events` explicitly migrates an existing flat layout into shards
  (idempotent, never runs implicitly — see
  [CLI reference → `reindex`](docs/cli-reference.md#reindex)).
- `defaults.lock_timeout` in `config.yaml` — how long a mutating command
  waits for the db write lock before giving up with `CONFLICT` (exit `6`).
  Defaults to `5s`, matching the previous hardcoded value.
- **`slop list`** (t-km7mb): filtered ticket enumeration —
  `--state`/`--label`/`--owner`/`--priority`/`--parent`/`--subtree` plus a
  free-text positional match against name/slug/spec summary,
  `--limit`/`--offset`, `--json`/`--budget`. Deterministic sort (state,
  then priority, then age). Everything the web UI's ticket-list filters
  can express is now expressible from the CLI too — see
  [CLI reference → `list`](docs/cli-reference.md#list).
- **`ready` gains `--owner`/`--priority`, and `--label` is now repeatable**
  (t-175oq, AND semantics — every given label must be present), so
  multiple actors/queues can scope their own pull without a separate
  `slop list` round-trip. Ordering and `--resumable` semantics unchanged.
- **Bulk multi-ref on `done`/`drop`/`update`** (t-mmngo): all three now
  accept multiple refs (or `-` to read refs from stdin, one per line),
  applied per-ref rather than all-or-nothing — one bad ref never blocks
  the others. `--json` gains a `results[]` array with per-ref
  `{ref, ok, exit_code, result | error}`; text output is one line per ref.
  The process exits `0` only if every ref succeeded, otherwise the most
  severe per-ref exit code. Given exactly one ref, output is unchanged
  (byte-for-byte) from before this ticket. See
  [CLI reference → `done`](docs/cli-reference.md#done).
- **`update` can now clear owner/parent and edit `discovered-from`, and
  `--owner` accepts an explicit actor kind** (t-9uvbr): `--clear-owner`/
  `--clear-parent` (mutually exclusive with `--owner`/`--parent`
  respectively) give a non-interactive way to remove either field —
  previously only possible via `slop edit`'s `$EDITOR`, which refuses to
  launch on a non-TTY. `--discovered-from <±ref>` (repeatable, same `±`
  convention as `--label`/`--blocks`) makes `discovered-from` editable
  after creation for the first time. `--owner` now accepts `agent:<name>`/
  `human:<name>` prefixes to set the stored actor kind explicitly (a bare
  name still stores `kind: "human"`, unchanged back-compat behavior) —
  applies to `new --owner` too.
- **Slug-shadowing detection and healing** (t-trqk9): a cross-clone merge
  producing two tickets with the same slug is now detected at index build
  time (a loud stderr warning, never silent last-writer-wins) and
  resolving the duplicated slug as a `<ref>` returns `AMBIGUOUS_REF`
  (exit `5`) listing every candidate — never a silent pick. `slop reindex
  --heal` additionally repairs it deterministically: the OLDEST ticket
  (by id) keeps the slug, newer duplicates are re-suffixed (`-2`, `-3`,
  ..., git-style). See
  [Concepts → slug uniqueness](docs/concepts.md#slug-uniqueness).

### Fixed

- **Test suite safe for concurrent runs** (t-ebgqb). Root-caused via a new
  reproduction harness (`bench/concurrent-repro.ts`, which races `bun run
  <cmd>` across N throwaway git worktrees) rather than guessing: two real
  concurrency hazards, both now fixed. (1) `tests/acceptance/D4.test.ts`'s
  real-wall-clock `< 800ms` budget for a spawned `slop status` call
  reliably flaked under concurrent full-suite runs (860ms-1.6s observed);
  `tests/support/perf-scale.ts` adds an opt-in `SLOP_TEST_PERF_SCALE`
  multiplier (default `1`, i.e. unchanged) a caller can set when it knows
  it's racing other full-suite runs. (2) `playwright.config.ts`'s
  hardcoded fixture-server port (`4765`) meant two concurrent `bun run
  test:browser` runs raced for the same port, one failing outright —
  fixed by picking a free port at config-load time, same ephemeral-port
  idea every acceptance test's `--port 0` already used. Deliberately
  *not* changed: vitest's worker/fork count — the originally-suspected
  `spawnSync`-returns-`status:null` OOM-killer fork-storm was not
  reproduced even under deliberately escalated concurrent load (see
  `bench/evidence/` and README.md's Testing section for the full
  writeup and numbers).

### Changed

- **Enforceable dependency boundaries** (t-y3fg1, docs/architecture.md).
  Shared contracts that used to live behind `src/cli/`/`src/storage/`
  adapters now live in `src/core/`, above every adapter: `SlopError`
  (`core/errors.ts`; `cli/errors.ts` keeps its reporting helpers and a
  compatibility re-export), the derived-index schema/DTOs and pure problem
  formatters (`core/db-index.ts`; `repo/db-index.ts` owns only building,
  fingerprinting, reading, and writing it), and the `StorageBackend` port
  itself plus its transaction marker and every shared event/query/
  tolerant-read DTO (`core/storage-contract.ts`; `storage/backend.ts` is
  now a pure compatibility re-export). `ticketEventContext` — a pure
  `Actor`+`Ticket` -> `EventContext` derivation CLI commands need before a
  backend is even selected — moves to `core/storage-contract.ts` for the
  same reason. No persisted schema, formatter text, command output, exit
  code, or remote wire shape changed. `tests/acceptance/G2.test.ts`
  replaces its old immediate-directory import blacklist with a recursive
  scan of every production `.ts`/`.tsx` file (type and runtime imports
  treated equally), enforcing the core -> domain -> repo -> storage ->
  CLI/web layer direction, a symbol-level allowlist for the CLI's narrow
  pre-backend-selection repo imports (`RepoPaths`/`repoPaths`/
  `requireRepoRoot`/`findRepoRoot`/`ensureDbDirs`/`atomicWriteFile`), and
  deterministic strongly-connected-component detection over the whole
  module graph — catching nested files, re-exports, and type-only
  inversions the old blacklist could miss.
- **`.slop/db/.lock` simplified.** The per-acquisition fencing protocol
  (tokens, `assertHeld()` renewal, dispossession detection) is removed —
  no real transaction in this codebase ever ran anywhere near its 5-minute
  stale-lock timeout, so the protocol guarded a scenario with no actual
  call site. What remains (O_EXCL acquisition, pid-liveness + timeout
  stale-breaking via an atomic rename-away, capped-backoff retry,
  `CONFLICT` on timeout) is unchanged in observable behavior, just
  reachable through `StorageBackend.transact` now rather than
  `src/repo/lock.ts` directly. See
  [Concurrency & merging → the db lock](docs/concurrency-and-merging.md#the-db-lock-serializing-the-write-path).
- The done-cascade (`src/tickets/cascade.ts`) and several other
  business-logic helpers now take a `StorageBackend` (and, for the
  cascade specifically, an opaque transaction-scope marker) instead of a
  flatfile `RepoPaths` — internal only, no CLI-visible change.
- `slop web`'s data source is now backed by `StorageBackend` instead of
  reading `.slop/db/` directly — as a side effect, a long-running `slop
  web` process no longer re-scans the whole db on every request when
  nothing has changed since the last one (the flatfile driver's
  in-process read cache).
- **Benchmarks reweighted to a realistic event ratio** (G5, t-ukxun):
  `bench/` now seeds ~9 events per ticket (this repo's own observed
  dogfood ratio), through the real `events/<YYYY-MM>/` shard layout,
  instead of a never-measured 2:1 ratio capped at 200,000 events. The
  1,000,000-ticket rung is dropped (it measured a scale far past where
  slopwork is designed to run, at real seed/run cost). `docs/benchmarks.md`
  is refreshed with fresh 1k/10k/100k numbers — the realistic ratio
  surfaces a real finding: `slop show`/`slop search` (both unconditional
  full-event-log scans) are markedly slower than the old ratio implied.
- **Docs corrections from the audit** (G5, t-drz1d): `docs/DECISIONS.md`
  gained a short preamble disambiguating its own `##` headings' lane-letter
  numbering (e.g. "D5" = lane D's 5th implementation-plan item) from
  design.md's separate D1–D17 decision table — additive only, no entries
  rewritten. `docs/concurrency-and-merging.md` now documents three
  cross-clone realities honestly: same-slug creation across clones (handled
  — `reindex --heal`), `active_session` double-claims across clones
  (unhandled, tracked as t-621mr), and unconditional `updated_at` merge
  conflicts (accepted v0 behavior, tracked as t-687rg).
- **Post-G3 polish** (G5, t-z4ci3): the Commander argv shim
  (`src/cli/argv.ts`) now also covers `update --blocks <±ref>`/
  `update --relates-to <±ref>` — the same leading-dash-value hazard
  `--label`/`--discovered-from` already had (e.g. `update <ref> --blocks
  -oldblocker` now parses correctly). `slop edit`'s non-TTY refusal message
  names the full current set of `update`'s edge/owner-repair flags
  (`--clear-owner`/`--clear-parent` added alongside the existing
  `--parent`/`--blocks`/`--relates-to`/`--owner`). `docs/getting-started.md`
  refreshed for the current command surface: `slop list`, bulk `done`/`drop`,
  and `ask`/`answer`/`questions` now appear in the walkthrough.

### Breaking

- `slop edit` now requires the flatfile backend's local-file capability;
  against a `remote` backend it refuses cleanly (`USAGE_ERROR`, exit `2`)
  naming `slop update`'s non-interactive flags instead of trying (and
  failing) to open a local file that was never going to exist.
- **Transcripts are removed from the product entirely** (product audit).
  Everything about the feature is gone, locally and remote:
  - the harness-transcript capture machinery (Claude Code / opencode / Codex
    locators, the most-recently-modified-file fallback, and
    capture-on-session-end from `stop`/`done`/`drop`/`review`/takeover);
  - the `transcript_ref` field on the session schema — new sessions no longer
    carry it. Session files written by an older version that still have it
    load fine: the unknown key is ignored;
  - the `--transcript <path>` flag on `review`, `stop`, `done`, and `drop`
    (now an unknown option, exit 2), the transcript-warning stderr output on
    session end, and the `transcript` field in those commands' `--json`
    output;
  - the `transcripts:` config key (`local`/`commit`/`off`), `slop init`'s
    `.slop/transcripts/` scaffolding, and the `.slop/transcripts/` gitignore
    rule. A legacy `transcripts:` key in an existing `config.yaml` is
    ignored with a stderr warning — delete the line to silence it;
  - the web transcript viewer page, its
    `/api/tickets/:ref/sessions/:sessionId/transcript` endpoint (now 404),
    its DTOs, and the "View transcript" links on session cards.

  Everything else about sessions is unchanged: harness kind detection,
  `harness.session_id` capture, git branch/commit capture, plans, and end
  summaries all still work exactly as before.

- **Simplification sweep** (G5, product audit): five de-engineering passes,
  landed together.
  - **Exit code `3` (`NOT_IMPLEMENTED`) is removed entirely.** It was
    reserved-but-unreachable scaffolding from early v0 — no command ever
    threw it. `EXIT_CODES` no longer defines it, and it's gone from
    README/`docs/cli-reference.md`'s exit-code tables. `4`/`5`/`6` keep
    their original numbers; nothing is renumbered down to fill the gap, so
    any existing exit-code-branching logic keeps meaning exactly what it
    always has.
  - **One `SLOP_FAKE_NOW` env var replaces three.** `SLOP_STATUS_FAKE_NOW`,
    `SLOP_READY_FAKE_NOW`, and `SLOP_WEB_FAKE_NOW` (each an identically
    -shaped, test-only clock override) are consolidated into a single
    `SLOP_FAKE_NOW`, honored everywhere a clock is injected
    (`core/clock.ts`'s `resolveFakeClock`). Test-only, never a
    user-facing/documented flag, absent from every real invocation.
  - **`adhoc` is folded into `provenance.method`.** The ticket schema's
    standalone `adhoc: boolean` field is removed — `provenance.method ===
    "adhoc"` (set by `new --adhoc`) is now the single source of truth for
    adhoc-ness, whose only behavior is exempting `done` from the
    review-skip nag. `new --adhoc`'s own behavior is unchanged. A ticket
    file written before this change that still carries a standalone
    `adhoc:` key loads fine — the unknown key is silently ignored, the
    same pattern this changelog's transcript-removal entry established for
    `transcript_ref`.
  - **`--budget` elision is one shared strategy, not six-plus bespoke
    ladders.** `ready`/`list`/`search`/`status`/`events`/`questions`/
    `context`/`show --context` all now go through one function
    (`core/budget.ts`'s `renderEntriesWithBudget`) — the per-command
    elision orderings and the context pack's old session-then-binary
    -search-details_md ladder are gone in favor of one generic "drop the
    least-important entries from the tail" rule. Guarantees are
    unchanged: `--json` under budget is always valid, never truncated
    mid-structure; `counts`/`derived`/`problems`-shaped summary fields are
    never elided; every response carries an explicit elision indicator;
    `events`' `next_cursor`/`has_more` still let a caller resume without
    losing events. `docs/cli-reference.md` gained one shared "Budget"
    section replacing the per-command paragraphs.
  - Dead web components (`components/ui/badge.tsx`, `label.tsx`, and the
    now-unused `@radix-ui/react-label` dependency) and dead test scaffolding
    (`tests/support/cli-harness.ts`'s unused `BOOTSTRAP_DEFAULTS`, the
    already-removed `SLOP_TEST_CLAUDE_HOME` knob still being scrubbed from
    several env-strip lists) are removed.

## 0.2.0 — 2026-07-24

The first sweep after v0 feature-completeness: a full review of the
implementation, then every finding fixed. Behavior changes below are grouped by
whether they can surprise an existing user.

### Breaking

- **`--spec` JSON that fails validation is now an error, not silent prose.**
  Previously, a `--spec` value that parsed as a JSON object but carried an
  unknown key or violated the schema was silently stored whole as
  `spec.details_md`, so `acceptance[]`/`context[]` came out empty with exit 0
  and no warning. It now exits `USAGE_ERROR` (2) naming the offending key.
  Bare (non-JSON) markdown still lands in `details_md` exactly as before.
- **`new --label` rejects a leading `+`/`-`.** `slop new x --label +bug` used to
  store a literal `"+bug"`, which then failed to match `update --label -bug`.
  Sigil-prefixed labels are now a usage error; `update`'s `±label` grammar is
  unchanged.
- **Negative `--budget` is rejected everywhere.** `ready`/`status`/`search`/
  `events`/`show` used to accept a negative budget and silently elide
  everything — an empty result on exit 0, indistinguishable from "nothing
  found". All budget-taking commands now share one parser and one unit.
- **`--note`/`--reason`/`--outcome` have length caps** (10k, 10k, 64k) enforced
  as clean usage errors rather than growing the ticket file unbounded.
- **`--json` shapes are now consistent across the loop.** Commands that report
  only a ticket stay flat (`new`, `update`, `draft`, `undraft`); commands that
  act through a session nest `ticket` and `session` (`start`, `stop`, `done`,
  `drop`, `review`). Previously `start` nested while `stop`/`done`/`drop`/
  `review` flattened ticket fields alongside session ones, so `id` meant the
  ticket but `session_id` meant the session. Read `ticket.id` and
  `session.id` now. `drop` reports `"session": null` when there was no active
  session.
- **`slop events` defaults to `--limit 100`.** It previously returned the entire
  log; pass `--limit` to widen. `has_more` is now only ever true alongside a
  cursor that genuinely advances.

### Added

- **Structured spec flags**: `--summary`, `--details`, `--acceptance`
  (repeatable), `--context` (repeatable) on `new` and `update`, so agents no
  longer hand-serialize JSON in a shell to fill `acceptance[]`/`context[]`.
- **`--json` on the closing half of the loop**: `update`, `review`, `stop`,
  `done`, `drop` (plus `draft`/`undraft`), with shapes reusing `new`/`show`
  field names. `done`/`drop` expose the unblocked cascade as a real array
  instead of prose.
- **`update --parent`, `--blocks`, `--owner`** — edges and ownership are now
  repairable non-interactively, instead of `edit`'s `$EDITOR` being the only
  route.
- **`slop reindex --heal`** repairs orphaned sessions left `ended_at: null` by
  an interrupted command.
- **`slop review --mr <url>` on a ticket already in review** attaches or
  replaces the MR link instead of erroring, so the "re-run once the MR exists"
  advice the CLI prints is actually possible.
- The `t-<code>` handle now appears in `ready`/`search`/`status` JSON, not just
  `new`/`show`.

### Fixed

- **Repository hygiene is enforced:** maintained files are scanned for literal
  NUL bytes and known mojibake, while checked-in `AGENTS.md`/`SKILL.md` outputs
  are verified byte-for-byte against the canonical onboarding renderer. Stale
  transcript settings were also removed from active benchmark/tooling config.
- **`slop web` no longer strands failed reads in loading states.** Tree,
  review, questions, stale, and project configuration requests are abortable,
  time bounded, and recover through explicit retry states; unexpected route
  errors have a page-level fallback. The tree now opens only root branches by
  default, persists named expand/collapse controls, supports expand/collapse
  all, wraps cleanly on mobile, and the icon-only mobile navigation exposes
  accessible names.
- **Stored XSS in `slop web`**: the external-parent badge built an `href`
  straight from `config.remotes.jira` without a scheme check, so a
  `javascript:` URL committed to `config.yaml` executed in the web UI's origin
  (which can read transcripts). It now goes through the same `safeUrl` guard as
  every other link.
- **A corrupt or missing `config.yaml` no longer 500s every web page** — it
  degrades to a warning banner.
- **`slop web` validates the `Host` header**, closing a DNS-rebinding path that
  let a malicious page in the user's browser read tickets and transcripts from
  the localhost server.
- **A second `slop web` on a busy port fails cleanly** instead of silently
  double-binding via `SO_REUSEPORT` on Linux.
- **Transcript capture no longer attaches the wrong conversation**: the Codex
  locator attached a *previous* session's rollout when no candidate postdated
  the session, and the Claude Code locator lacked the ambiguity/`started_at`
  guards, so two concurrent agents in one repo could capture each other's
  transcripts. Claude Code's cwd encoding now matches the real algorithm
  (verified against the shipped binary), so repos with `_` or spaces in their
  path capture correctly.
- **A huge `stale_after` no longer crashes every index build** — an overflowing
  duration disables staleness with a warning instead of throwing `RangeError`
  out of `buildIndex` and taking `status`/`ready`/`reindex` down with it.
- **`slop edit` no longer hangs forever** when `$EDITOR`/`$VISUAL` are unset on
  a non-TTY; it exits 2 with guidance.
- **Warnings no longer describe things that did not happen**: `review`/`stop`
  printed their nags before validating, so a nonexistent ref produced "is
  entering review" followed by "not found".
- **Session-end write ordering** makes the ticket write the commit point, so an
  interrupted takeover can no longer strand the superseded session.
- Self `relates-to` edges are rejected; empty names and plan steps produce clean
  usage errors instead of raw schema dumps; a missing `.slop/` reports the same
  exit code from every command, `slop web` included.

### Changed

- `slop web`'s transcript pager labels now match chronology (they were
  inverted), and out-of-range offsets clamp.
- The stale panel anchors review rows on `review.requested_at` rather than
  `last_activity_at`, so an unrelated progress note no longer hides how long an
  MR has waited.
- Session ownership is a warning, not a gate: acting on another actor's session
  via `plan`/`stop`/`done`/`drop` warns on stderr and proceeds.
- **Tooling**: `oxfmt` replaces Biome as the formatter (`oxlint` already
  replaced its linter). See `docs/DECISIONS.md` — notably, `src/web/views/**` is
  excluded because formatting `` html`` `` tagged templates changes the emitted
  HTML.
- **`slop web` is now a React + Tailwind + shadcn-style single-page app** over a
  new read-only JSON API, replacing the server-rendered HTML views. Everything
  (JS, CSS, an inlined monospace font) is bundled into the single binary — no
  CDN, no external requests, still fully offline. Adds a command palette,
  copy-on-click identifiers, light/dark, and an audit-spine timeline on ticket
  detail that shows a ticket's whole provenance from creation through session,
  plan checkpoints, review and done. All the web hardening fixes above carry
  forward. See [`docs/web-ui.md`](docs/web-ui.md).
- **Docs**: the internal spec, decision log, and implementation plan moved under
  `docs/` with a History & internals index; `docs/benchmarks.md` records
  measured scaling limits (1k → 1,000,000 tickets).
- **Resolving many refs in one command is no longer quadratic.** `slop new
  --blocks a --blocks b …` re-scanned and re-parsed the whole index once per
  ref; it now shares a single load across the batch. At 100k tickets that was
  ~1.3s of re-scanning *per ref*.
- The npm package no longer ships test files — roughly half the previous
  tarball.
- **CI passes for the first time.** Three causes: the quadratic ref resolution
  above (which timed out the degree-cap tests on slower runners), a property
  test whose clock was tighter than its real work, and coverage collection
  crashing on the new browser bundle. The full gate — lint, format, typecheck,
  test with coverage thresholds, build, and a compiled-binary smoke test — is
  green on a clean machine.

## 0.1.1

Test-suite portability fix: in-process CLI tests no longer depend on the
developer's own environment.

## 0.1.0

First tagged release. v0 feature-complete: all 22 commands (`init`,
`instructions`, `reindex`, `new`, `split`, `draft`, `undraft`, `edit`,
`update`, `ready`, `start`, `context`, `plan`, `review`, `stop`, `done`,
`drop`, `status`, `show`, `search`, `events`, `web`) over a git-mergeable
flatfile JSONC database, with sessions, plans, transcript capture, and a
read-only web explorer.
