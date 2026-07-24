# CLI reference

Every `slop` command below was verified against `./dist/slop <command>
--help` and the command's implementation in `src/cli/commands/`. Commands
are grouped exactly as `slop --help` groups them.

A note on two flags that show up on most read commands: `--json` switches
to machine-readable output, and `--budget <n>` caps output to roughly `n`
characters, eliding the least-important entries first (the exact elision
order — lowest-priority tickets, stale rows before review rows before
in-progress rows, oldest sessions before long spec prose, etc. — is
documented per-command below and in each command's own `--help`). With
`--json`, hitting the budget never produces truncated/invalid JSON — it
degrades to a smaller, still-valid envelope instead.

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

## Exit codes

Every command exits with exactly one of these (`src/core/exit-codes.ts`),
so a driving agent can branch on `$?` instead of scraping output:

| Code | Name | Meaning |
|---|---|---|
| 0 | `SUCCESS` | Command completed successfully. |
| 1 | `GENERIC_ERROR` | Unexpected runtime error (I/O failure, bug, etc). |
| 2 | `USAGE_ERROR` | Bad invocation — missing/invalid arguments or flags. |
| 3 | `NOT_IMPLEMENTED` | Command is registered but its body isn't built yet. |
| 4 | `NOT_FOUND` | A `<ref>` did not resolve to any entity, or no `.slop/` repo was found. |
| 5 | `AMBIGUOUS_REF` | A short-prefix or slug `<ref>` matched more than one entity. |
| 6 | `CONFLICT` | Illegal state transition or other conflicting operation. |

`NOT_FOUND` (4) is also what every command throws when it can't find a `.slop/` repo — walking up
from the cwd the same way `git` looks for `.git/` (`requireRepoRoot`, `src/repo/paths.ts`). This
includes `slop web`, which used to run its own separate discovery and exit `1` instead; it now
shares the same discovery and exit code as every other command.

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
slop reindex --strict   # fail on the first unreadable file instead of skipping it
slop reindex --heal     # also close out any orphaned active sessions found
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
| `--owner <actor>` | owning actor, stored as a human actor |
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
```

### `edit`

```sh
slop edit <ref>
```

Opens `<ref>`'s ticket JSONC file in `$VISUAL`/`$EDITOR` for direct
hand-editing.

### `update`

The general mutator — every dedicated verb command above is sugar over
this for the one edge it can perform (`draft ⇄ open`); everything else
(state transitions with side effects) needs its own command, see
[Concepts → state machine](concepts.md#state-machine).

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

Unlike `--spec` (which replaces the entire spec blob — an omitted key
resets to its schema default), `--summary`/`--details`/`--acceptance`/
`--context` follow `update`'s usual "say what changes, the rest stays"
convention: each touches only its own field, on top of the ticket's
CURRENT spec. `--acceptance`/`--context` replace their whole array when
given at all (no per-entry add/remove sigil, unlike `--label`); omitted
entirely, the current array is untouched. Combining `--spec` with any of
the four is a `USAGE_ERROR` (exit 2) — two different ways to say what the
spec is.

`--relates-to` is the one edge `update` can touch — `parent`/`blocks`/
`discovered-from` still can't be changed after creation (aside from
`--blocks` at `new` time; hand-edit via `edit` for those). It uses the
same `+`/`-` sigil convention as `--label` (rather than a separate
`--unrelate` flag) because that's the established `update` convention for
"add or remove, repeatable, one flag"; `new --relates-to <ref>` above
stays bare (no sigil) because `new` only ever adds, same as `--blocks`.
Each ref is resolved and re-validated the same way `new`'s edge flags are
(existence, the per-edge-kind degree cap); a redundant add/remove (e.g.
`+already-related`, or `-` on a target that isn't related) is a no-op, not
an error.

A **pure `--progress`-only call** (nothing else on the command line) is
lock-free — see
[Concurrency & merging](concurrency-and-merging.md#lock-free-progress-updates).
Any call that touches `--relates-to` always takes the locked read-modify
-write path (same as `--label`/`--priority`/etc.) — never the lock-free
`--progress`-only path.

---

## The agent loop

### `ready`

```sh
slop ready
slop ready --label area:auth
slop ready --resumable
slop ready --json --budget 3000
```

Lists tickets that are `open`, have no live blockers, and no active
session — ordered by priority then age (oldest first). Drafts and
in-review tickets never appear.

| Flag | Meaning |
|---|---|
| `--label <label>` | filter to tickets carrying this label |
| `--resumable` | also list stopped or gone-stale in_progress/review tickets worth resuming |
| `--json` | machine-readable |
| `--budget <n>` | cap output size, eliding lowest-priority/least-relevant tickets first |

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
| `--budget <n>` | cap output; elides oldest sessions, then long `spec.details_md`, before ever hard-truncating |
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

### `review`

```sh
slop review <ref> --mr https://github.com/org/repo/pull/42
slop review <ref>                       # legal, but nags on stderr
```

Moves `in_progress → review`. `--mr` is recommended, not required (D15):
omitting it still moves the ticket, but nags on stderr and leaves
`review.mr` absent. `--transcript <path>` overrides transcript
auto-detection for this call.

### `stop`

```sh
slop stop <ref> --note "state: X done, next: Y, gotcha: Z"
```

Ends the current session without completing the ticket: hands it back to
`open`, records the handoff note, captures the harness transcript. Never
blocks if the transcript can't be found — warns instead. `--transcript
<path>` is a manual override.

### `done`

```sh
slop done <ref> --note "merged and verified"
slop done <ref> --note "…" --outcome "Long-form writeup of what changed and why."
slop done <ref> --outcome - < outcome.md
```

Completes `<ref>` — legal from `review` **or** directly from
`in_progress` (review is optional). Finalizes the session (end summary +
transcript), then runs the done-cascade exactly once, reporting any
ticket this one was blocking that just became unblocked.

| Flag | Meaning |
|---|---|
| `--note <text>` | completion note (also becomes the session's end summary and the ticket's `latest_note`) |
| `--outcome <text>` | long-form resolution writeup stored on the ticket; `-` reads stdin |
| `--transcript <path>` | manual transcript path override |

Completing a non-`adhoc` ticket directly from `in_progress` (never went
through `review`) still succeeds but nags on stderr; `adhoc` tickets and
the `review → done` path never nag.

### `drop`

```sh
slop drop <ref> --reason "superseded by ticket_01…"
```

Marks `<ref>` `dropped` (wontdo) from any non-terminal state. `--reason`
is **required**. Finalizes an active session if one exists, and runs the
same done-cascade `done` does — a dropped ticket also stops blocking its
dependents. `--transcript <path>` only matters if there's an active
session to finalize.

---

## Inspecting

### `status`

```sh
slop status
slop status --json --budget 2000
```

Project pulse: counts by state, in-progress tickets with sessions, stale
items, and tickets awaiting review with their MR links.

| Flag | Meaning |
|---|---|
| `--json` | machine-readable |
| `--budget <n>` | elides stale rows, then review rows, then in-progress rows, least-important-first; the counts/derived totals are always kept in full |

### `show`

```sh
slop show <ref>
slop show <ref> --context
slop show <ref> --tree
slop show <ref> --json
```

A ticket's full details: spec, state, edges, sessions, and history.

| Flag | Meaning |
|---|---|
| `--context` | include the full context pack |
| `--tree` | render the ticket's ancestry/descendant tree |
| `--budget <n>` | caps `--context` output only — a single ticket/tree view is never elided |
| `--json` | machine-readable (ticket, plus `--tree`/`--context` data when given) |

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
| `--budget <n>` | elides lowest-ranked results first |

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
| `--budget <n>` | elides the newest trailing events first, adjusting `next_cursor`/`has_more` to match what's actually returned |

### `web`

```sh
slop web
slop web --port 0     # pick a free port
```

Serves the read-only local explorer. See [Web UI](web-ui.md) for what's
in it. Default port **4553**; `--port 0` picks a free port. Binds to
`127.0.0.1` only — it is never reachable off-machine.
