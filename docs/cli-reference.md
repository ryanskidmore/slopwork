# CLI reference

Every `slop` command below was verified against `./dist/slop <command>
--help` and the command's implementation in `src/cli/commands/`. Commands
are grouped exactly as `slop --help` groups them.

A note on `--json`, which shows up on most commands below: it switches to
machine-readable output. `--budget <n>` shows up on most *read* commands —
see [Budget](#budget) just below for the one shared contract every one of
them follows.

## Budget

`--budget <n>` caps output to roughly `n` characters on every command that
takes it — `ready`, `list`, `search`, `status`, `events`, `questions`,
`context`, and `show --context` — via ONE shared strategy, not a
per-command bespoke ladder:

- Each command reduces its output to a list of entries already in
  elision-priority order (least important last), then drops whole entries
  from the tail, one at a time, until the rendering fits `n`. What counts
  as an "entry" is the obvious one for that command — a ticket row
  (`ready`/`list`), a search result (`search`), an event (`events`), a
  question (`questions`), a status section row (`status`), or a context
  pack section (`context`/`show --context`: prior sessions oldest-first,
  then spec prose + ancestry + blockers dropped together as one final
  tier). Fixed-size summary fields — `counts`/`derived`/`problems` on
  `status`, `total`/`problems` on `list`, and their equivalents elsewhere —
  are never elided.
- Every response that could be shortened carries an explicit elision
  indicator: `elided`/`elisions` (an array of human-readable notes on what
  was dropped) in `--json`, and a trailing `(--budget, characters): ...`
  block in the human view. Both are empty/absent iff nothing needed to be
  dropped.
- **`--json` is never truncated mid-structure.** If even the
  zero-entries envelope doesn't fit `n`, that minimal-but-valid envelope
  is returned as-is (a budget of 0 or 1 characters can never truly be met
  by valid JSON) — reported via `withinBudget: false`, never by emitting
  invalid JSON. The human (text) view has no such syntax to protect, so
  its own last resort is a raw character slice, which always exactly
  meets the budget.
- `events`' `next_cursor`/`has_more` are always recomputed against
  whatever `--budget` actually kept, not the pre-elision page — a caller
  paging with `--since <next_cursor>` never loses an event that got
  elided from a page it already saw.
- `--budget` counts in characters, always (never tokens), and rejects a
  negative value as a usage error (exit `2`) rather than silently eliding
  everything.

See `src/core/budget.ts` for the implementation (`renderEntriesWithBudget`
— the one function every command above calls into).

## Ref resolution

Anywhere a `<ref>` is accepted, it resolves in this order:

1. **Full id** — `ticket_<ULID>`, exact match, case-sensitive.
2. **Exact slug** — case-insensitive, always wins over a short-prefix
   interpretation. Slugs may carry a single `type/` prefix
   (`fix/ui-not-showing`) for branch-name alignment.
3. **Short `t-<code>` handle** — a stable 5-character handle derived from
   the ticket's own id (printed by `slop new`/`slop show`), e.g. `t-m1k6w`.
4. **Unique short id prefix** — any unambiguous prefix of the id or its
   bare ULID (`01KYA7`).

A prefix or `t-<code>` that matches more than one ticket is a **git-style
ambiguous-ref error** (exit `5`) listing every candidate, never a
pick-the-first-one. `jira:PROJ-123`-style external refs are only valid as
`--parent` values — passing one where a local ticket ref is expected is a
usage error (exit `2`).

## `--json` output shapes

Commands that support `--json` follow one rule, so an agent can parse any of
them without special-casing:

- **Commands that report only a ticket** return its fields **flat**: `new`,
  `update`, `draft`, `undraft`.
  ```json
  { "id": "ticket_01…", "slug": "add-auth", "handle": "t-ab12x", "name": "Add auth", "state": "open" }
  ```
- **Commands that act on a ticket through a session** nest both, plus whatever
  else that command reports: `start`, `stop`, `done`, `drop`, `review`.
  ```json
  {
    "ticket":  { "id": "ticket_01…", "slug": "add-auth", "handle": "t-ab12x", "name": "Add auth", "state": "done" },
    "session": { "id": "session_01…", "note": "shipped" },
    "unblocked": ["ticket_01…"]
  }
  ```

The `ticket` object always carries the same five fields (`id`, `slug`,
`handle`, `name`, `state`), so `ticket.id` means the same thing everywhere.
`drop` reports `"session": null` when the dropped ticket had no active session
at all.

- **`done`/`drop`/`update` given MULTIPLE refs** (t-mmngo — see each
  command's own section below) switch to a bulk envelope instead:
  ```json
  {
    "results": [
      { "ref": "a", "ok": true,  "exit_code": 0, "result": { /* the single-ref shape above */ } },
      { "ref": "b", "ok": false, "exit_code": 4, "error": "no ticket found for ref \"b\"" }
    ],
    "ok": false,
    "succeeded": 1,
    "failed": 1
  }
  ```
  Given exactly ONE ref, all three commands still emit the plain single-ref
  shape above, byte-for-byte — the bulk envelope only appears once more than
  one ref is actually being processed, so a script written against the
  single-ref shape never has to change to keep working on a single ref.

Errors never go to stdout, so a `--json` stdout stream is always either valid
JSON or empty; branch on the [exit code](#exit-codes) first. For a bulk
`done`/`drop`/`update` call this still holds at the TOP level (the process's
own stdout is exactly one valid JSON document, or empty) — a failing ref's
error message lives INSIDE that document, as `results[].error`, not printed
bare to stdout.

## Exit codes

Every command exits with exactly one of these (`src/core/exit-codes.ts`),
so a driving agent can branch on `$?` instead of scraping output:

| Code | Name | Meaning |
|---|---|---|
| 0 | `SUCCESS` | Command completed successfully. |
| 1 | `GENERIC_ERROR` | Unexpected runtime error (I/O failure, bug, etc). |
| 2 | `USAGE_ERROR` | Bad invocation — missing/invalid arguments or flags. |
| 4 | `NOT_FOUND` | A `<ref>` did not resolve to any entity, or no `.slop/` repo was found. |
| 5 | `AMBIGUOUS_REF` | A short-prefix or slug `<ref>` matched more than one entity. |
| 6 | `CONFLICT` | Illegal state transition or other conflicting operation. |

Code `3` is intentionally absent (it was `NOT_IMPLEMENTED`, reserved-but-unreachable scaffolding
no command ever threw — G5's simplification sweep removed it entirely); `4`/`5`/`6` keep their
original numbers, not renumbered down to fill the gap.

`NOT_FOUND` (4) is also what every command throws when it can't find a `.slop/` repo — walking up
from the cwd the same way `git` looks for `.git/` (`requireRepoRoot`, `src/repo/paths.ts`). This
includes `slop web`, which used to run its own separate discovery and exit `1` instead; it now
shares the same discovery and exit code as every other command.

**Bulk `done`/`drop`/`update`** (t-mmngo, given more than one ref): the process exits `0` only if
every ref succeeded. Otherwise it exits with the numerically **greatest** exit code among the refs
that failed (e.g. one ref failing `NOT_FOUND` (4) and another `CONFLICT` (6) exits `6`) — a
documented judgment call, since this table has no inherent severity ranking of its own; check
`results[].exit_code`/`results[].ok` per-ref for the full picture, not just the process's own exit
code.

---

## Setup & maintenance

### `init`

Initialize `.slop/` in this repo. See
[Getting started → Initialize a repo](getting-started.md#initialize-a-repo)
for the full write-up of what it creates.

```sh
slop init --yes
slop init --project myproj --jira "" --yes
```

| Flag | Meaning |
|---|---|
| `--jira <url>` | set `remotes.jira` non-interactively (pass `""` for explicitly blank) |
| `--project <name>` | override the autodetected project name |
| `--user <name>` | override the autodetected user (D17 config rung) |
| `--yes` | accept all detected defaults; never prompt |
| `--link-claude-md` | non-interactively add a slopwork pointer to an existing `CLAUDE.md` |

Safe to re-run: never touches `config.yaml` or `db/` on an already
-initialized repo, only regenerates `AGENTS.md`/the skill file/the
gitignore section.

### `instructions`

Prints this project's onboarding rules — the loop and house rules,
interpolated with this repo's `config.yaml` (project name, Jira URL). No
flags. See [Agent workflow](agent-workflow.md) for the content.

```sh
slop instructions
```

### `reindex`

Rebuilds the derived, gitignored `.slop/db/index.jsonc` from the tickets,
sessions, and events on disk. You rarely need this by hand — every read
path auto-heals a missing/stale index — but it's the manual escape hatch
after a bulk hand-edit, or to force-surface every unreadable ticket file
in one pass. It also scans for **orphaned active sessions** — sessions
with no `ended_at` that no ticket's `active_session` references, which
can happen if a `start`/takeover is interrupted (e.g. a crash) between
creating the session and the ticket write that points to it.

```sh
slop reindex
slop reindex --strict         # fail on the first unreadable file instead of skipping it
slop reindex --heal           # also close out any orphaned active sessions found
slop reindex --shard-events   # migrate flat-layout events/ into events/YYYY-MM/ shards
```

`--strict` restores pre-fault-tolerance, all-or-nothing behavior. Without
it, `reindex` skips unreadable ticket files, still rebuilds everything it
could read, reports every problem, and exits `1` if any remain.

`--heal` closes out every orphaned active session it finds: sets
`ended_at` and a synthesized `end_summary` explaining the auto-heal, and
records a `session.ended` event (`reason: "orphan_repair"`) per session,
same audit trail any other session-ending command leaves. Detection
always runs and is reported in the summary line even without `--heal`.
The scan is skipped (with a warning) whenever the ticket read itself had
unreadable files — a corrupt ticket's own `active_session` would
otherwise be invisible to the scan, which could misreport a genuinely
live session as orphaned.

`--shard-events` (G2) migrates any events still sitting flat
(`events/event_<ulid>.jsonc`, the pre-sharding layout) into
`events/YYYY-MM/` shard directories, one shard per calendar month (UTC)
derived from each event's own id — see
[Concepts → The flatfile database](concepts.md#the-flatfile-database) for
why events shard by month at all. **Never runs implicitly** — event files
are git-tracked, so the rename lands as a normal, visible commit you
choose to make, not something a routine `reindex` does on your behalf.
Idempotent and safe to run repeatedly: a repo that's already fully
sharded (or has no events at all) reports zero files moved. Reading has
always transparently handled a mix of flat and sharded events (and
always will, even after every repo you use has been migrated), so
`--shard-events` is a housekeeping/performance choice, never a
requirement.

**Duplicate-slug detection and healing** (t-trqk9). A cross-clone merge
can produce two tickets sharing one slug (each clone picked the same slug
independently, before either saw the other's ticket) — `reindex` detects
this on every run (not just with `--heal`) and warns loudly on stderr,
naming every candidate id per duplicated slug; the process still exits
`0` (this is a warning, not a failure — resolving the slug is already
loud and safe, see [Concepts → slug
uniqueness](concepts.md#slug-uniqueness)). `--heal` additionally repairs
it, deterministically: the OLDEST ticket in each duplicated group (by id)
keeps the slug; every newer duplicate is re-suffixed (`-2`, `-3`, ...,
git-style — the same collision rule `slop new` already uses), each
rename recorded as its own `ticket.updated` event. The index is rebuilt a
second time after healing so the summary line (and every subsequent
read) reflects the repaired slugs.

---

## Creating & shaping

### `new`

```sh
slop new "Adding new auth provider"
slop new "Fix login redirect" --parent jira:PROJ-123 --priority 1
slop new "Add OAuth callback tests" --discovered-from add-oauth-provider
slop new "Track the migration spike" --relates-to migration-spike
slop new "Spike: passkeys" --draft
slop new "Detailed ticket" \
  --summary "Short one-liner" \
  --acceptance "criterion 1" --acceptance "criterion 2" \
  --context "src/foo.ts:42" \
  --details "Longer markdown prose"
slop new --spec - "Detailed ticket" < spec.json
```

| Flag | Meaning |
|---|---|
| `--summary <text>` | spec summary — structured, preferred over `--spec` JSON (default: the ticket name) |
| `--details <text>` | spec `details_md` prose — structured, preferred over `--spec` JSON; `-` reads from stdin |
| `--acceptance <text>` | an acceptance criterion — structured, preferred over `--spec` JSON (repeatable) |
| `--context <text>` | a context note/file/URL pointer — structured, preferred over `--spec` JSON (repeatable) |
| `--spec <json>` | ticket spec as JSON; `-` reads from stdin. Mutually exclusive with the four flags above |
| `--parent <ref>` | parent ticket ref, slug, or external ref (`jira:PROJ-123`) |
| `--blocks <ref>` | this ticket blocks `<ref>` (repeatable) |
| `--relates-to <ref>` | this ticket relates to `<ref>` — symmetric, informational (repeatable) |
| `--discovered-from <ref>` | the ticket this work was discovered while doing |
| `--label <key:value>` | repeatable; can't start with `+`/`-` (that's `update`'s `±label` add/remove syntax — `new` only ever adds) |
| `--draft` | create in draft state (never appears in `ready`) |
| `--adhoc` | mark as created outside normal planning (exempts `done` from the review-skip nag) |
| `--owner <actor>` | owning actor: a bare name (human, back-compat) or `agent:<name>`/`human:<name>` (t-9uvbr) to set the actor kind explicitly |
| `--priority <0-3>` | 0 urgent .. 3 low, default 2 |
| `--slug <slug>` | explicit branch-style handle, optionally `type/`-prefixed; auto-generated from the name when omitted |
| `--json` | machine-readable result |

Without `--spec`/`--summary`/`--details`/`--acceptance`/`--context`, the
spec defaults to `{summary: <name>}`. `--relates-to` is add-only here, same
as `--blocks`/`--discovered-from` — every ref given is resolved and
validated (existence, the per-edge-kind degree cap) exactly like
`--blocks`; a repeated `--relates-to` naming the same ticket twice is
deduplicated, not stored twice. To add or remove a `relates-to` edge on an
**existing** ticket, see `update`'s own `--relates-to <±ref>` below — see
[Concepts → Edge](concepts.md#edge) for what the edge itself means.

**Prefer `--summary`/`--details`/`--acceptance`/`--context` over
`--spec <json>`** — house rules already ask for structured
`acceptance[]`/`context[]` rather than prose, and hand-assembling `--spec`
JSON in a shell means quoting hazards plus the failure mode below; the
structured flags are plain repeatable text, same convention as `--label`.
They cannot be combined with `--spec` (a `USAGE_ERROR`, exit 2, if both are
given — two different ways to say what the spec is).

`--spec`'s value is either a JSON object matching the spec schema
(`summary`/`details_md`/`acceptance[]`/`context[]`/`meta`/`v`), used
structurally, or bare markdown prose, which lands whole in `details_md`.
If a `--spec` value **parses as a JSON object** but carries an unknown
top-level key (a typo, e.g. `acceptence`) or otherwise fails the spec
schema, that's a hard error (`USAGE_ERROR`, exit 2) naming the offending
key/issue — never a silent fallback, since that would quietly turn the
JSON into prose and lose the key. Only text that isn't JSON-object-shaped
at all (doesn't parse as JSON, or parses to an array/primitive) falls
through to the `details_md` markdown path.

### `split`

```sh
slop split auth-overhaul "Add OAuth provider" "Add MFA"
```

Creates one new sub-ticket per name given, each parented under `<ref>` and
carrying a `discovered-from` edge back to it, state always `open`
regardless of the target's own state. `--json` for a machine-readable
result naming the target plus every new child's id/slug.

### `draft` / `undraft`

```sh
slop draft <ref>      # -> draft (never ready, never startable)
slop undraft <ref>    # -> open
slop draft <ref> --json     # {id, slug, handle, name, state, already_draft}
slop undraft <ref> --json   # {id, slug, handle, name, state, already_open}
```

Re-running either on a ticket already at its target state is an idempotent
no-op (distinct stdout wording, `already_draft`/`already_open: true` in
`--json`), not an error.

### `edit`

```sh
slop edit <ref>
```

Opens `<ref>`'s ticket JSONC file in `$VISUAL`/`$EDITOR` for direct
hand-editing.

**Non-TTY safety**: if neither `$VISUAL` nor `$EDITOR` is set AND stdin/
stdout isn't a real terminal, `edit` refuses to launch the platform
default (`vi`/`notepad`) — that combination used to block forever waiting
for interactive input that can never arrive (a harness-driven pipe that's
never closed). It fails fast instead (`USAGE_ERROR`, exit `2`), naming
`update --parent/--blocks/--owner/--relates-to` as the non-interactive
alternative for the edge/owner repair `edit` used to be the only way to
do. An explicitly configured `$VISUAL`/`$EDITOR` is exempt from this guard
even off a real terminal (it's trusted to be non-interactive-safe on
purpose).

**Requires the flatfile backend** (G2): `edit` opens a real local file, a
capability [a remote backend doesn't have](storage-backends.md#not-part-of-the-wire-contract-local-file-access).
Against `backend: remote`, it refuses cleanly (`USAGE_ERROR`, exit `2`)
naming `update`'s non-interactive flags, same as the non-TTY refusal
above — never a confusing failure trying to locate a file that was never
going to exist.

### `update`

The general mutator — every dedicated verb command above is sugar over
this for the one edge it can perform (`draft ⇄ open`); everything else
(state transitions with side effects) needs its own command, see
[Concepts → state machine](concepts.md#state-machine). Also the
non-interactive path for post-creation edge/owner repair
(`--parent`/`--clear-parent`/`--blocks`/`--discovered-from`/`--owner`/
`--clear-owner`/`--relates-to`) — previously `edit`'s `$EDITOR` hand-edit
was the only way to touch these fields at all, and clearing owner/parent
had no non-interactive path whatsoever (t-9uvbr).

```sh
slop update <ref> --progress "one-line status note"
slop update <ref> --priority 0 --label +urgent --label -stale
slop update <ref> --name "Better ticket name"
slop update <ref> --acceptance "new criterion 1" --acceptance "new criterion 2"
slop update <ref> --context "src/bar.ts:10"
slop update <ref> --spec - < new-spec.json
slop update <ref> --state open      # only draft <-> open is legal here
slop update <ref> --relates-to +other-ticket-slug
slop update <ref> --relates-to +new-related --relates-to -no-longer-related
slop update <ref> --blocks +some-other-ticket
slop update <ref> --discovered-from +some-spike --discovered-from -old-context
slop update <ref> --owner priya                # bare name: human (back-compat)
slop update <ref> --owner agent:codex-3         # explicit agent owner
slop update <ref> --clear-owner
slop update <ref> --parent new-parent-slug
slop update <ref> --parent jira:PROJ-123
slop update <ref> --clear-parent

# t-mmngo: multiple refs, applied per-ref (never all-or-nothing)
slop update a b c --label +triaged
echo -e "a\nb\nc" | slop update - --label +triaged
```

| Flag | Meaning |
|---|---|
| `--progress <note>` | append a progress note, bump activity |
| `--state <state>` | `draft\|open\|in_progress\|review\|done\|dropped` — only `draft ⇄ open` succeeds; every other target explains which dedicated command to use instead |
| `--priority <0-3>` | |
| `--label <±label>` | `+label` to add, `-label` to remove (repeatable) |
| `--name <name>` | rename |
| `--summary <text>` | replace the spec summary — structured, preferred over `--spec` JSON; the rest of the spec is untouched |
| `--details <text>` | replace the spec `details_md` prose — structured, preferred over `--spec` JSON; `-` reads from stdin; the rest of the spec is untouched |
| `--acceptance <text>` | replace `acceptance[]` wholesale — structured, preferred over `--spec` JSON (repeatable); the rest of the spec is untouched |
| `--context <text>` | replace `context[]` wholesale — structured, preferred over `--spec` JSON (repeatable); the rest of the spec is untouched |
| `--spec <json>` | replace the WHOLE spec; `-` reads from stdin. Mutually exclusive with the four flags above |
| `--relates-to <±ref>` | `+ref` to add, `-ref` to remove a `relates-to` edge — symmetric, informational (repeatable) |
| `--blocks <±ref>` | `+ref` to add, `-ref` to remove a `blocks` edge — cycle-checked, same as `new --blocks` (repeatable) |
| `--discovered-from <±ref>` | `+ref` to add, `-ref` to remove a `discovered-from` edge (repeatable; t-9uvbr) — not cycle-checked, same as `--relates-to` |
| `--owner <actor>` | set/replace the owning actor: a bare name (human, back-compat) or `agent:<name>`/`human:<name>` (t-9uvbr) to set the actor kind explicitly. Mutually exclusive with `--clear-owner` |
| `--clear-owner` | clear the owning actor entirely (t-9uvbr) — the non-interactive alternative to `slop edit`'s hand-edit. Mutually exclusive with `--owner` |
| `--parent <ref>` | reparent `<ref>` under this ticket, or an external ref (`jira:PROJ-123`); recomputes `root_id`/`path` for `<ref>` AND every existing descendant. Mutually exclusive with `--clear-parent` |
| `--clear-parent` | clear the parent, becoming a local root (t-9uvbr) — recomputes `root_id`/`path` for `<ref>` and every descendant, same as reparenting. Mutually exclusive with `--parent` |
| `--json` | machine-readable result — see below |

Unlike `--spec` (which replaces the entire spec blob — an omitted key
resets to its schema default), `--summary`/`--details`/`--acceptance`/
`--context` follow `update`'s usual "say what changes, the rest stays"
convention: each touches only its own field, on top of the ticket's
CURRENT spec. `--acceptance`/`--context` replace their whole array when
given at all (no per-entry add/remove sigil, unlike `--label`); omitted
entirely, the current array is untouched. Combining `--spec` with any of
the four is a `USAGE_ERROR` (exit 2) — two different ways to say what the
spec is.

`--relates-to`/`--blocks`/`--discovered-from`/`--owner`/`--parent` are
the edge/ownership fields `update` can touch. `--relates-to`/`--blocks`/
`--discovered-from` use the same `+`/`-` sigil convention as `--label`
(rather than a separate `--unrelate`/`--unblock`/`--undiscover` flag)
because that's the established `update` convention for "add or remove,
repeatable, one flag"; `new --relates-to <ref>`/`new --blocks <ref>`/`new
--discovered-from <ref>` stay bare (no sigil) because `new` only ever
adds. Each ref is resolved and re-validated the same way `new`'s edge
flags are (existence, the per-edge-kind degree cap, and — for `--blocks`/
`--parent` only, not `--relates-to`/`--discovered-from` — a cycle check);
a redundant add/remove (e.g. `+already-related`, or `-` on a target that
isn't related) is a no-op, not an error.

`--owner`/`--parent` are plain set/replace flags (no sigil): re-stating
the same value is a no-op. `--clear-owner`/`--clear-parent` (t-9uvbr) give
each an explicit, non-interactive way to CLEAR instead — mutually
exclusive with their set/replace counterpart (`--clear-owner` +
`--owner`, or `--clear-parent` + `--parent`, together is a `USAGE_ERROR`,
exit 2). Clearing the parent recomputes `root_id`/`path` for `<ref>` and
every existing descendant exactly like reparenting does — the ticket
becomes its own local root.

`--owner`'s value grammar (t-9uvbr): a bare name (e.g. `priya`) stores a
**human** actor, unchanged back-compat behavior; an explicit `agent:` or
`human:` prefix (e.g. `agent:codex-3`, `human:priya`) picks the stored
actor `kind` directly — closing the gap where an agent-owned subtree
(D1's agent-owned-below-root policy) could only ever be stored as a
human owner. Applies to `new --owner` too.

A **pure `--progress`-only call** (nothing else on the command line) is
lock-free — see
[Concurrency & merging](concurrency-and-merging.md#lock-free-progress-updates).
Any call that touches `--relates-to`/`--blocks`/`--discovered-from`/
`--owner`/`--clear-owner`/`--parent`/`--clear-parent` always takes the
locked read-modify-write path (same as `--label`/`--priority`/etc.) —
never the lock-free `--progress`-only path.

**Bulk multi-ref** (t-mmngo): `update` accepts multiple `<refs...>`, or a
single `-` to read refs from stdin (one per line, blank lines dropped).
Every flag applies to EVERY ref (e.g. `slop update a b c --label
+triaged` adds the label to all three); each ref is applied
independently — one ref failing (a bad ref, an illegal `--state`
transition, ...) never blocks the others. Given exactly one ref, output
is byte-identical to before this ticket: `--json` returns the flat
`{id, slug, handle, name, state, priority, reparented_descendants}`
shape, text prints the same multi-line summary. Given more than one ref,
text output is one line per ref (`<ref> -> updated <id> (<slug>)  state:
...  priority: ...`, a failing ref's line on stderr instead), and
`--json` returns `{results: [{ref, ok, exit_code, result | error}, ...],
ok, succeeded, failed}` — see [`--json` output shapes](#json-output-shapes)
above for the full envelope. The process exits `0` only if every ref
succeeded; see [Exit codes](#exit-codes) for the bulk failure rule.

---

## The agent loop

### `ready`

```sh
slop ready
slop ready --label area:auth
slop ready --label area:auth --label team:infra   # AND — both labels required
slop ready --owner priya --priority 0
slop ready --resumable
slop ready --include-awaiting
slop ready --json --budget 3000
```

Lists actionable leaf tickets that are `open`, have no live blockers, no
active session, and no nonterminal descendants — ordered by priority then
age (oldest first). Drafts and in-review tickets never appear.

The descendant check is transitive and applies to both the plain list and
`--resumable`: a parent stays out while any child or deeper descendant is
`draft`, `open`, `in_progress`, or `review`, even when that descendant is
itself blocked or awaiting input. `done` and `dropped` descendants do not
suppress their parent. This keeps the default pull queue leaf-first without
changing the established priority-then-age ordering among eligible tickets.

| Flag | Meaning |
|---|---|
| `--label <label>` | filter to tickets carrying this label (repeatable; AND — every given label must be present, t-175oq) |
| `--owner <name>` | filter to tickets owned by this exact actor name (t-175oq) |
| `--priority <0-3>` | filter to tickets at exactly this priority (t-175oq) |
| `--resumable` | also list stopped or gone-stale in_progress/review leaf tickets worth resuming |
| `--include-awaiting` | include tickets with an unanswered question (G4) — excluded by default |
| `--json` | machine-readable |
| `--budget <n>` | cap output size — see [Budget](#budget) |

`--label`/`--owner`/`--priority` all compose with AND — `ready --owner
priya --label area:auth --label team:infra` returns only tickets owned by
`priya` carrying BOTH labels. Ordering and `--resumable` semantics are
unchanged from before t-175oq.

**`--include-awaiting` (G4, t-jggg9):** by default, `ready` (both the
plain list and `--resumable`) excludes any ticket with the `awaiting_input`
overlay (see [Concepts → derived
overlays](concepts.md#derived-overlays-blocked-stale-ready-awaiting_input))
— a ticket blocked on an unanswered question just stalls an agent that
picks it up, on the exact same question the last session already hit.
Pass `--include-awaiting` to opt back into the pre-G4 behavior for a
specific pull (e.g. a human deliberately re-driving one anyway).

### `start`

```sh
slop start <ref>
slop start <ref> --as ryan --harness codex
slop start <ref> --takeover
slop start <ref> --json
```

Creates a session (harness + git capture), moves the ticket to
`in_progress`, and prints the context pack.

| Flag | Meaning |
|---|---|
| `--as <name>` | override actor identity for this session |
| `--harness <kind>` | `claude-code\|opencode\|codex\|other` — overrides auto-detection |
| `--takeover` | take over a ticket with another active session (logged as a takeover event) |
| `--json` | small stable result (session/ticket ids, git info) — **omits** the context pack; follow with `slop context <ref> --json` |

Starting a ticket that's currently `review` (changes-requested re-entry)
never needs `--takeover` — it's logged as `re_entry: true`, not a takeover.
Starting a ticket someone else has actively `in_progress` **does** need
`--takeover`; without it the command refuses with a `CONFLICT` (exit `6`).

### `context`

```sh
slop context <ref>
slop context <ref> --json --budget 4000
```

Reprints `<ref>`'s context pack (spec, ancestry, blockers, prior sessions)
mid-session, without changing state — useful after context compaction.

| Flag | Meaning |
|---|---|
| `--budget <n>` | cap output size — see [Budget](#budget) |
| `--json` | structured pack; degrades to a minimal-but-valid envelope under a tight budget rather than corrupting the JSON |

### `plan`

```sh
slop plan <ref> "step 1" "step 2" "step 3"   # sets/revises the plan (new version)
slop plan <ref> --check 2
slop plan <ref> --uncheck 2
```

Step text and `--check`/`--uncheck` are mutually exclusive; `--check` and
`--uncheck` are mutually exclusive with each other. Supplying step text
always creates a **new plan version** (diffable from the last); checking or
unchecking a step number (1-based) mutates the *current* version in place
— it does not version-bump. Every step's text must be non-blank; a
blank/whitespace-only step is a `USAGE_ERROR` (exit 2) naming its 1-based
position, nothing partially applied.

### `ask`

```sh
slop ask <ref> "Should we use approach A or B?"
slop ask <ref> "Which one?" --option "A" --option "B"
slop ask <ref> "Ship it?" --json
```

Records a structured question (G4, t-jggg9) — a `question.asked` event,
ticket-scoped, actor-attributed. This is what makes `<ref>` `awaiting_input`
(see [Concepts → derived
overlays](concepts.md#derived-overlays-blocked-stale-ready-awaiting_input))
until answered via `slop answer`. Replaces the old `slop update <ref>
--progress "QUESTION: …"` string convention entirely — there is no state, no
inbox, and no filter behind that convention; this one has all three
(`slop questions`, `slop status`'s "Awaiting input" section, `slop ready`'s
default exclusion).

| Flag | Meaning |
|---|---|
| `--option <text>` | a multiple-choice option (repeatable) — shown alongside the question in the inbox/web |
| `--json` | machine-readable result: `{question: {id, ticket, text, options, asked_by, asked_at}}` |

Lock-free, like a pure `update --progress` note — no read-modify-write of
the ticket file, so concurrent `ask` calls on the same ticket never
contend.

### `answer`

```sh
slop answer event_01KY9RVF2DCG6TDQ8EBSGXQXT1 "B, and here's why…"
slop answer <short-question-id-prefix> "Yes, ship it."
slop answer <question-id> "…" --json
```

Answers a question `slop ask` opened — a `question.answered` event
referencing the question it closes (`payload.question_id`). Once answered,
the question no longer counts toward `awaiting_input`.

`<question-id>` accepts the same ref forms every other id in this CLI does:
a full `event_<ULID>` id, or a unique short prefix (more than one match is
`AMBIGUOUS_REF`, exit `5`; no match is `NOT_FOUND`, exit `4`). Answering an
already-answered question is a `CONFLICT` (exit `6`) naming who answered it
and when — never a second `question.answered` event for the same question.

| Flag | Meaning |
|---|---|
| `--json` | machine-readable result: `{question_id, ticket, answer: {id, text, by, answered_at}}` |

### `review`

```sh
slop review <ref> --mr https://github.com/org/repo/pull/42
slop review <ref>                       # legal, but nags on stderr
slop review <ref> --mr <url>            # also legal AGAIN once <ref> is already in review — attaches/replaces the link
```

Moves `in_progress → review`. `--mr` is recommended, not required (D15):
omitting it still moves the ticket, but nags on stderr and leaves
`review.mr` absent. Re-running on a ticket already in review with `--mr`
replaces the link; a bare re-run (no `--mr`) is a conflict (exit `6`).

`--json` returns `{id, slug, handle, name, state, review,
already_in_review}` — `review` is `null`, or `{mr, requested_at, by}`
(same shape as `show --json`'s ticket field, `mr: null` when absent).

### `stop`

```sh
slop stop <ref> --note "state: X done, next: Y, gotcha: Z"
```

Ends the current session without completing the ticket: hands it back to
`open` and records the handoff note.

`--json` returns `{id, slug, handle, name, state, session_id, note}`.

### `done`

```sh
slop done <ref> --note "merged and verified"
slop done <ref> --note "…" --outcome "Long-form writeup of what changed and why."
slop done <ref> --outcome - < outcome.md

# t-mmngo: multiple refs, applied per-ref (never all-or-nothing)
slop done a b c --note "batch: all merged and verified"
echo -e "a\nb\nc" | slop done - --note "batch closed"
```

Completes one or more refs — legal from `review` **or** directly from
`in_progress` (review is optional). Finalizes each session (end summary),
then runs the done-cascade exactly once per ref, reporting any ticket
that ref was blocking that just became unblocked.

| Flag | Meaning |
|---|---|
| `--note <text>` | completion note, applies to every ref (also becomes each session's end summary and ticket's `latest_note`) |
| `--outcome <text>` | long-form resolution writeup, applies to every ref; `-` reads stdin |
| `--json` | machine-readable result — see below |

Completing a non-`adhoc` ticket directly from `in_progress` (never went
through `review`) still succeeds but nags on stderr; `adhoc` tickets and
the `review → done` path never nag.

Given exactly ONE ref, `--json` returns the same shape as before t-mmngo:
`{id, slug, handle, name, state, note, resolution_set, unblocked,
problems, skipped_review}` — `unblocked` is the `TicketId[]` cascade list
the prose output only ever joined into a comma-separated string;
`problems` is `{id, message}[]` (any ticket/session file the cascade's
own scan couldn't read, almost always `[]`); `resolution_set` is a
boolean (whether `--outcome` set a resolution), never the resolution
text itself — fetch that with `show --json`.

**Bulk multi-ref** (t-mmngo): given more than one ref (or `-` to read refs
from stdin, one per line), each ref is completed independently — one
ref's failure (wrong state, bad ref, ...) never blocks the others. Text
output is one line per ref (`<ref> -> done <id> (<slug>)  state: done
unblocked: ...`, a failing ref's line on stderr instead); `--json`
returns `{results: [{ref, ok, exit_code, result | error}, ...], ok,
succeeded, failed}` — see [`--json` output shapes](#json-output-shapes)
above. Exits `0` only if every ref succeeded.

### `drop`

```sh
slop drop <ref> --reason "superseded by ticket_01…"

# t-mmngo: multiple refs, applied per-ref (never all-or-nothing)
slop drop a b c --reason "superseded by the rewrite"
```

Marks one or more refs `dropped` (wontdo) from any non-terminal state.
`--reason` is **required** and applies to every ref. Finalizes an active
session if one exists, and runs the same done-cascade `done` does — a
dropped ticket also stops blocking its dependents.

Given exactly ONE ref, `--json` returns the same shape as before t-mmngo:
`{id, slug, handle, name, state, reason, session, unblocked, problems}`
— same `unblocked`/`problems` shape as `done --json` (both run the
identical cascade); `session` is `null` when there was no active session
to finalize.

**Bulk multi-ref** (t-mmngo): same contract as `done`'s above — multiple
refs (or `-` for stdin) applied per-ref, text output one line per ref, a
`{results[], ok, succeeded, failed}` `--json` envelope, exit `0` only if
every ref succeeded.

---

## Inspecting

### `status`

```sh
slop status
slop status --json --budget 2000
```

Project pulse: counts by state, in-progress tickets with sessions,
awaiting-input tickets (G4 — unanswered questions), stale items, and
tickets awaiting review with their MR links.

| Flag | Meaning |
|---|---|
| `--json` | machine-readable |
| `--budget <n>` | cap output size — see [Budget](#budget); counts/derived totals are always kept in full |

The "Awaiting input" section (G4, t-jggg9) lists every ticket with `>=1`
unanswered question — ticket, open-question count, and the oldest question's
age — oldest-waiting first. `--json` adds an `awaiting_input: [{id, slug,
handle, name, open_question_count, oldest_question_at,
oldest_question_age_ms}]` array alongside the existing `in_progress`/
`review`/`stale` ones.

### `show`

```sh
slop show <ref>
slop show <ref> --context
slop show <ref> --tree
slop show <ref> --json
```

A ticket's full details: spec, state, edges, sessions, and history. Any
open (unanswered) question is surfaced prominently, right at the top,
before `spec` (G4, t-jggg9) — see `slop ask`/`slop answer`.

| Flag | Meaning |
|---|---|
| `--context` | include the full context pack |
| `--tree` | render the ticket's ancestry/descendant tree |
| `--budget <n>` | caps `--context` output only (see [Budget](#budget)) — a single ticket/tree view is never elided |
| `--json` | machine-readable (ticket, plus `--tree`/`--context` data when given) |

`--json` adds an `awaiting_input: {open: boolean, questions: [{id, text,
options, asked_by, asked_at}]}` object alongside `ticket`/`handle`/`jira_url`
— `questions` is every currently-unanswered question on `<ref>`, oldest
first.

### `list`

```sh
slop list
slop list "widget"                              # free-text match: name/slug/spec.summary
slop list --state open --state in_progress      # OR — either state matches
slop list --label area:auth --label team:infra  # AND — both labels required
slop list --owner priya --priority 0
slop list --parent auth-overhaul                # DIRECT children only
slop list --subtree auth-overhaul                # the whole descendant tree, inclusive
slop list --limit 20 --offset 20                # page 2, 20 per page
slop list --awaiting-input                      # only tickets with an unanswered question
slop list --json --budget 3000
```

Filtered ticket enumeration (t-km7mb) — everything the web UI's
ticket-list filters can express (state/label/owner/priority/parent/
subtree/free-text), from the CLI. Fills the gap between `ready` (a
specific "workable now" query) and `search` (ranked text search): `list`
is plain browsing, no query language, deterministic sort.

| Flag | Meaning |
|---|---|
| `[text]` | positional; free-text, case-insensitive substring match against `name`/`slug`/`spec.summary` |
| `--state <state>` | filter to this state (repeatable; OR — any given state matches); omit for every state, including drafts |
| `--label <label>` | filter to tickets carrying this label (repeatable; AND — every given label must be present) |
| `--owner <name>` | filter to tickets owned by this exact actor name |
| `--priority <0-3>` | filter to tickets at exactly this priority |
| `--parent <ref>` | filter to DIRECT children of this ticket only |
| `--subtree <ref>` | filter to the whole descendant tree rooted at this ticket, INCLUSIVE of the ticket itself |
| `--awaiting-input` | filter to tickets with an unanswered question (G4) — every row still carries an `awaiting_input` badge/field regardless |
| `--limit <n>` | cap the number of tickets returned (after filtering/sorting) |
| `--offset <n>` | skip this many matching tickets before applying `--limit` |
| `--json` | machine-readable output |
| `--budget <n>` | cap output size — see [Budget](#budget) |

**Sort is deterministic**: state (in `draft → open → in_progress → review
→ done → dropped` order), then priority (0 urgent .. 3 low), then age
(oldest first, by id). Every filter composes with AND across filter
kinds (e.g. `--state open --label area:auth --owner priya` requires all
three); `--state`/`--label` each have their own internal semantics (OR
within `--state`, AND within `--label`) documented above.

`--json` returns `{tickets: [...], total, returned, offset, limit,
problems, elided}` — `total` is the match count BEFORE `--limit`/
`--offset` (what pagination is paging over); `returned` is `tickets.length`
in this response (after paging, before any `--budget` elision); each
ticket row is `{id, slug, handle, name, state, priority, labels, owner,
parent, root_id, last_activity_at, awaiting_input}` (G4's `awaiting_input`
boolean badge). `problems` is `{id, path, message}[]` (any ticket file
skipped while listing, almost always `[]`).

### `search`

```sh
slop search "oauth callback"
slop search "reset token" --json --limit 10
```

A naive, case-insensitive scan over ticket names, specs, and progress-note
history — every space-separated word must match somewhere. This is **not**
a query language (no field filters) — that's the parked SlopQL feature.

| Flag | Meaning |
|---|---|
| `--json` | machine-readable |
| `--limit <n>` | cap result count |
| `--budget <n>` | cap output size — see [Budget](#budget) |

### `questions`

```sh
slop questions
slop questions --all
slop questions --ticket <ref>
slop questions --json --budget 3000
```

The elicitations inbox (G4, t-jggg9): every question `slop ask` opened.
Default: unanswered only, oldest first, grouped by ticket (the ticket whose
oldest open question has waited longest sorts first).

| Flag | Meaning |
|---|---|
| `--all` | include already-answered questions too |
| `--ticket <ref>` | scope to one ticket |
| `--json` | machine-readable |
| `--budget <n>` | cap output size — see [Budget](#budget) |

`--json` returns `{groups: [{ticket: {id, slug, handle, name, state},
questions: [{id, text, options, asked_by, asked_at, answer}]}], total_questions,
total_tickets, all, elided}` — `answer` is `null` for an open question, or
`{id, text, by, answered_at}` once answered.

### `events`

```sh
slop events
slop events --ticket <ref>
slop events --since event_01KY… --json
```

Lists immutable events in cursor order — ascending by event id, which
sorts chronologically (oldest first).

| Flag | Meaning |
|---|---|
| `--since <event_id>` | exclusive cursor: only events after this id |
| `--ticket <ref>` | scope to one ticket (id, slug, or short prefix) |
| `--limit <n>` | cap result count |
| `--json` | events plus a `next_cursor` for paging |
| `--budget <n>` | cap output size — see [Budget](#budget); `next_cursor`/`has_more` are recomputed to match what's actually returned |

### `web`

```sh
slop web
slop web --port 0     # pick a free port
```

Serves the read-only local explorer. See [Web UI](web-ui.md) for what's
in it. Default port **4553**; `--port 0` picks a free port. Binds to
`127.0.0.1` only — it is never reachable off-machine.
