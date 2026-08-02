# Concepts

Slopwork models work as five kinds of object, stored as flatfile JSONC
under `.slop/db/`. This doc explains each one, the state machine tickets
move through, the overlays computed *on top of* stored data (never stored
themselves), and the on-disk layout.

## The five entities

### Ticket

The unit of work. Key fields (see `src/core/entities/ticket.ts` for the
full schema):

| Field | Notes |
|---|---|
| `id` | `ticket_<ULID>` — immutable, minted once |
| `name`, `slug` | human name + short branch-style handle (`slop new --slug`, or auto-generated) |
| `spec` | structured JSON: `summary`, `details_md` (markdown), `acceptance[]`, `context[]`, `meta`, schema version `v` |
| `state` | see [state machine](#state-machine) below |
| `review` | `{mr, requested_at, by}` — present **iff** `state === "review"` |
| `priority` | `0` (urgent) .. `3` (low), default `2` |
| `labels` | `key:value` strings |
| `parent` | a local `ticket_<ULID>` or an external ref like `jira:PROJ-123` |
| `blocks` / `relates_to` / `discovered_from` | outgoing edges, see [Edges](#edge) |
| `root_id`, `path` | materialized ancestry: `root_id` is this ticket's own id if it has no local parent (a true root, or its parent is external); `path` is the ordered list of local ancestor ids |
| `active_session` | the session id currently "owning" this ticket, or `null` |
| `last_activity_at`, `latest_note` | bumped by `update --progress`; see the note on **effective values** below |
| `resolution` | long-form outcome writeup, set via `done --outcome` (absent unless ever set) |
| `owner` | an `Actor`, or `null` |
| `provenance` | `{method: new\|split\|draft\|adhoc, created_by, split_from?}` — `method === "adhoc"` (set by `--adhoc`, `slop new`) is the single source of truth for "created outside normal planning," exempting `done` from the review-skip nag (no separate stored `adhoc` field) |

**Effective, not stored-verbatim `latest_note`/`last_activity_at`:** a pure
`update --progress` call appends an event without rewriting the ticket
file at all (see [Concurrency & merging](concurrency-and-merging.md)). What
`show`/`status`/`ready`/`web` display is the *effective* value — the
ticket's stored baseline folded together with every progress event for it —
not necessarily a byte-for-byte read of the ticket file.

### Edge

Four kinds, defined in `src/core/entities/edge.ts`:

| Kind | Meaning | Stored as |
|---|---|---|
| `parent` | this ticket's parent (local or external) | `ticket.parent` (single value) |
| `blocks` | this ticket blocks another ticket | `ticket.blocks[]` |
| `relates-to` | a loose association between two tickets | `ticket.relates_to[]` |
| `discovered-from` | this ticket was discovered while working another | `ticket.discovered_from[]` |

There is no separate `edges/` store — every edge is embedded as a field on
its *source* ticket. The reverse direction (who blocks *me*, who relates to
*me*) is never stored; it's derived by scanning every ticket's outgoing
edges at index-build time.

Only `parent` may target an external ref (`jira:PROJ-123`) — external
parents terminate the local tree, so a ticket parented under an external
ref is the root of its own local subtree. `blocks`, `relates-to`, and
`discovered-from` always target a local ticket.

**What has a CLI flag today:** `slop new` accepts `--parent`, `--blocks`,
`--relates-to`, and `--discovered-from` — every one of them add-only, set
at creation time. `slop update` additionally accepts `--relates-to <±ref>`,
`--blocks <±ref>`, and `--discovered-from <±ref>` (t-9uvbr — `+ref` to
add, `-ref` to remove any of the three), `--owner <actor>`/`--clear-owner`,
and `--parent <ref>`/`--clear-parent` (t-9uvbr: explicit clear flags,
mutually exclusive with their set/replace counterpart) to change an
EXISTING ticket's edges/owner after creation
(edit-vi-fallback-hangs-agents: a non-interactive alternative to `slop
edit`, whose `$EDITOR` fallback can hang forever on a non-TTY — see
[CLI reference → `edit`](cli-reference.md#edit)) — see
[CLI reference → `new`](cli-reference.md#new) and
[→ `update`](cli-reference.md#update) for the full flag docs. Every graph
field an agent is told to maintain is now editable via `update` on a
non-TTY, including clearing owner/parent and touching `discovered-from` —
`slop edit`'s `$EDITOR` hand-edit is no longer the only way to do any of
this, though it remains available for anything not covered above.

### Session

A real harness session — not a lock/claim (`src/core/entities/session.ts`):

- `harness`: `{kind: claude-code|opencode|codex|other, session_id}` —
  sniffed from the environment (`--harness` overrides), see
  [Configuration](configuration.md#actor--harness-identity-d17).
- `git`: `{branch, commit_at_start}` — captured at `start` time; `null` if
  not a git repo or there's no branch/commit yet.
- `plan`: an ordered list of **versions** (`{version, steps[], created_at}`)
  — a plan revision is a new version appended, never a mutation of an old
  one, so v1 vs v2 is diffable.
- `started_at` / `ended_at` — `ended_at` stays `null` while the session is
  active. **`slop review` never sets `ended_at`** — a session stays active
  across a review round-trip; only `done`, `drop`, and `stop` end a
  session.
- `end_summary` — from `--note` on `stop`/`done`.

A ticket points at its current session via `active_session`; `ready`
excludes any ticket with one set.

### Event

Immutable, one file per event, never updated or deleted
(`src/core/entities/event.ts`). Every mutating command appends one or more.
Shape: `{id, actor, session, verb, entity: {kind, id}, payload, at}`.

The verb vocabulary is closed (`EVENT_VERBS`), grouped by area:

- **Ticket lifecycle:** `ticket.created`, `ticket.updated`,
  `ticket.state_changed`, `ticket.ready` (blockers cleared — the ticket's
  own `state` doesn't change, only the derived `blocked` overlay does),
  `ticket.done`, `ticket.dropped`, `ticket.split`.
- **Session lifecycle:** `session.started` (includes takeover and review
  re-entry), `session.stopped`, `session.ended` (done or drop — the
  payload's `reason` says which), `session.takeover`.
- **Plans:** `plan.set`, `plan.revised`, `plan.step_checked`.
- **Review:** `review.requested`.
- **Elicitations (G4):** `question.asked` (`slop ask`), `question.answered`
  (`slop answer`) — see
  [Derived overlays](#derived-overlays-blocked-stale-ready-awaiting_input)
  below for the `awaiting_input` overlay these two verbs feed.

`slop events` lists these, optionally scoped to a ticket or paged with
`--since`. See [CLI reference → `events`](cli-reference.md#events).

### Actor

Not a stored entity with its own file — a small `{name, kind: human|agent}`
value embedded wherever something needs to say who did it (`ticket.owner`,
`session.actor`, `event.actor`, `ticket.review.by`,
`ticket.provenance.created_by`). See
[Configuration → actor/harness identity](configuration.md#actor--harness-identity-d17)
for how the ACTING actor's `name`/`kind` are resolved for an event/session.

`ticket.owner` specifically is set by `new --owner`/`update --owner` (or
cleared via `update --clear-owner`), whose value grammar (t-9uvbr) is: a
bare name (e.g. `--owner priya`) stores `kind: "human"`, unchanged
back-compat behavior; an explicit `agent:`/`human:` prefix (e.g. `--owner
agent:codex-3`) sets `kind` directly — this is what makes an agent-owned
subtree (D1's agent-owned-below-root policy) actually representable,
rather than every owner being forced into `kind: "human"` regardless of
who's really driving it.

## State machine

Stored states: `draft`, `open`, `in_progress`, `review`, `done`, `dropped`.

```
draft ⇄ open ──start──▶ in_progress ──review --mr──▶ review ──done──▶ done
              ▲              │  ▲                       │              ▲
              └────stop──────┘  └──────start (changes requested)──────┘│
                                 └──────────done (review optional)──────┘
```

Plus `dropped` (wontdo), reachable from any non-terminal state via
`slop drop --reason "…"`.

| Transition | Command | Notes |
|---|---|---|
| `draft ⇄ open` | `slop draft` / `slop undraft`, or `update --state` | Drafts never appear in `ready` and can't be started. |
| `open → in_progress` | `slop start` | Creates a session; captures harness + git. |
| `in_progress → open` | `slop stop --note "…"` | Ends the session, hands the ticket back, no cascade. |
| `in_progress → review` | `slop review --mr <url>` | `--mr` is **recommended, not required** — omit it and the ticket still moves, but the command nags on stderr and `review.mr` is left absent (never `null`). The session stays **active** across this move. |
| `review → review` | `slop review --mr <url>` | The **one** legal same-state case: idempotent attach/replace of the MR link on a ticket already in review — exactly the recovery path the no-`--mr` nag above advises. A **bare** `review <ref>` (no `--mr`) on an already-review ticket is still rejected (`CONFLICT`, exit `6`) — nothing to update without a link. |
| `review → in_progress` | `slop start` again | Changes-requested re-entry: no `--takeover` needed, a fresh session is created, logged with `re_entry: true`. |
| `review → done` | `slop done` | The "went through review" path — never nags. |
| `in_progress → done` | `slop done` | **Also legal directly** — review is optional, not mandatory. A non-`adhoc` ticket that skips review this way still succeeds but nags on stderr; `adhoc` tickets and the `review → done` path never nag. |
| any non-terminal → `dropped` | `slop drop --reason "…"` | Finalizes any active session; runs the same done-cascade as `done`. |

`update --state` can perform **only** `draft ⇄ open` directly — every other
edge needs a dedicated command because it has a real side effect (session
creation/finalization, an MR link, the done-cascade) that a generic field
setter can't perform coherently. Same-state is always a legal no-op
(`update --state open` on an already-open ticket does nothing), except for
`done`/`drop`, which are one-way, side-effecting actions where re-running
them on a ticket already at that state is a rejected usage mistake, not a
no-op. `review` is the one partial exception: re-running `slop review` on
an already-review ticket is legal **only** given `--mr` (an MR
attach/replace, not a new review round — see the `review → review` row
above); a bare re-run is still rejected the same way `done`/`drop` are.

`src/tickets/state.ts` is the single source of truth for transition
legality.

## Derived overlays: `blocked`, `stale`, `ready`, `awaiting_input`

None of these are stored on a ticket (D5: "derived, never asserted") —
they're computed fresh, every time, from stored data plus (for staleness)
the current clock.

- **`blocked`** — a ticket is blocked if one or more *other* tickets, still
  in a non-`done`/`dropped` state, name it in their own `blocks[]`. The
  live count is recomputed from scratch on every index rebuild and after
  every `done`/`drop` cascade — never a counter that gets decremented (a
  decrement-by-one is provably wrong for a diamond dependency: closing one
  of two live blockers must not flip a ticket to unblocked while the other
  is still live).
- **`ready`** — `state === "open" ∧ no live blockers ∧ active_session === null`.
  Drafts and in-review tickets never qualify, no matter what.
- **`stale`** — `in_progress` *or* `review` with no activity past a
  configured threshold. This is a **deadline**, not a boolean: the index
  stores `last_activity_at + stale_after` (in_progress) or
  `review.requested_at + review_stale_after` (review — anchored on when
  review was *requested*, not general activity, so an unrelated progress
  note doesn't reset a rotting review's clock). The live true/false is
  computed at read time (`now > deadline`) by `slop ready --resumable` and
  `slop status`, against the thresholds in `.slop/config.yaml` — see
  [Configuration](configuration.md#staleness-thresholds).
- **`awaiting_input`** (G4, t-jggg9) — a ticket has it iff it has one or
  more *unanswered* questions: a `question.asked` event (`slop ask`) with
  no later `question.answered` event (`slop answer`) referencing it by the
  asked event's own id. Unlike `stale`, this needs no clock — it's a pure
  fold over the ticket's own events (`src/tickets/overlay.ts`'s
  `computeAwaitingInputOverlay`, built on `src/tickets/questions.ts`'s
  `deriveQuestions`), computed identically by the CLI's index build and
  the web explorer. `slop ready` excludes `awaiting_input` tickets by
  default (`--include-awaiting` overrides — see
  [CLI reference → `ready`](cli-reference.md#ready)); `slop status`/`slop
  list`/`slop show` surface it (a section, a badge/`--awaiting-input`
  filter, and the open questions themselves, respectively).

## The flatfile database

```
.slop/
  config.yaml                          # committed
  AGENTS.md                            # committed — agent onboarding
  db/
    tickets/ticket_<ulid>.jsonc
    sessions/session_<ulid>.jsonc      # plan embedded, versioned
    events/event_<ulid>.jsonc          # immutable — flat layout (pre-sharding, or never migrated)
    events/2026-08/event_<ulid>.jsonc  # immutable — sharded layout (G2), one dir per UTC month
    index.jsonc                        # derived — GITIGNORED, auto-healed
    .lock                              # write-path transaction lock
```

`index.jsonc` is a pure function of the entity files on disk: slug → id
lookup, reverse edges, `blocked_count`, `ready`, staleness deadlines. It is
never authoritative and self-heals transparently — a deleted index, a
fresh clone, or a repo that just went through `git merge`/`git pull`/a
hand-edit all rebuild it on the next command that needs it. `slop reindex`
is the manual escape hatch.

**Events shard by month (G2).** A freshly-written event lands under
`events/YYYY-MM/` — the UTC calendar month derived from the event's own
ULID timestamp, not wall-clock time at write — rather than flat in
`events/`. Every read path (`slop events`, the derived index, `slop web`,
...) merges flat and sharded events transparently: an old repo with
events still sitting flat, a repo mid-migration with a mix of both, and a
fully-sharded repo all read identically, with no user-visible difference.
Sharding exists purely for scale: a repo with years of history no longer
means every read of "the event log" scans one ever-growing directory —
each shard's own content fingerprint (used by the derived index's
staleness check, and by the flatfile driver's in-process read cache) only
changes when THAT month gets a new event, so an unchanged month is never
re-scanned on a repeat read. Migrating an existing flat layout into shards
is explicit and manual — `slop reindex --shard-events`
([CLI reference → `reindex`](cli-reference.md#reindex)) — never automatic,
since event files are git-tracked and the resulting renames should land as
a commit you chose to make.

Why the db merges cleanly across parallel agent branches, and how the
`.lock` file and lock-free progress updates work, is its own topic — see
[Concurrency & merging](concurrency-and-merging.md).

## Slug uniqueness

Slugs are meant to be unique — `nextAvailableSlug` (B1) appends a
`-2`/`-3`/... suffix whenever a new ticket's slug would collide with one
already on disk. That check only ever sees what its OWN clone can
currently see, though: two clones can each independently create a ticket
whose name slugifies to the same thing (or an explicit `--slug` picked by
two agents working in parallel) before either has seen the other's
ticket, and a normal `git merge`/`git pull` merges both new ticket files
cleanly — nothing about a plain file merge notices two tickets now
sharing a slug.

**Detection is loud, never silent** (t-trqk9). Every index rebuild
(`slop reindex`, or any command's transparent auto-heal — see "The
flatfile database" above) detects every slug currently claimed by more
than one ticket and records it in the index's `slug_problems[]`; any
command that surfaces index problems (the same `loadIndex()` warning path
`problems[]`/unreadable-ticket-file detection already uses) warns on
stderr, naming every candidate id per duplicated slug.

**Resolution never silently picks one.** Looking up a duplicated slug as
a `<ref>` — via `slop show`, `slop start`, `slop update`, or any other
command that resolves a ref — returns `AMBIGUOUS_REF` (exit `5`), listing
every candidate ticket, exactly like a short-id-prefix or `t-<code>`
handle that happens to match more than one ticket. Nothing ever falls
back to "pick the first/last one" for a duplicated slug.

**Healing is deterministic**: `slop reindex --heal` repairs every
duplicated slug it finds — the OLDEST ticket in each group (by id; ids
are ULIDs, so "oldest by id" is also "created first") keeps the slug
unchanged, and every newer duplicate is re-suffixed via the same
`-2`/`-3`/... collision rule `slop new` already uses, git-style. Each
rename is recorded as a normal `ticket.updated` event — the same audit
trail any other field change leaves. See
[CLI reference → `reindex`](cli-reference.md#reindex).

## Storage backend

Every command, and `slop web`, read and write through one interface,
`StorageBackend` — never `.slop/db/` files directly. `config.yaml`'s
`backend:` key selects which implementation: **flatfile** (everything
above; the default, no configuration needed) or **remote** (a store
reachable over HTTP — not implemented yet, but the wire contract a real
implementation must speak is fully specified). See
[Configuration → Storage backend](configuration.md#storage-backend) for
how to select one and [Storage backends](storage-backends.md) for the
full interface/wire-contract design.

## See also

- [CLI reference](cli-reference.md) — every command that reads or writes
  these entities.
- [Agent workflow](agent-workflow.md) — how the loop actually gets driven.
- [Storage backends](storage-backends.md) — the pluggable storage
  interface and its remote wire contract.
