# Configuration

## `.slop/config.yaml`

Written by `slop init` (autodetected where possible), committed to git.
Full shape (`src/core/entities/config.ts`):

```yaml
project: slopwork
user: ryan                    # actor fallback, D17 — optional
remotes:
  repo: https://github.com/ryan/slopwork   # autodetected from git remote
  jira: https://yourorg.atlassian.net       # prompted or blank
defaults:
  stale_after: 60m
  review_stale_after: 24h
transcripts: local            # local | commit | off
```

| Field | Meaning | Default |
|---|---|---|
| `project` | project name, shown in `slop instructions`/generated docs | required (autodetected from the directory name at `init`) |
| `user` | actor-name fallback, checked after `--as`/`SLOP_ACTOR`, before `git config user.name` | none |
| `remotes.repo` | this repo's remote URL | autodetected from `git remote` at `init`; absent if detection failed |
| `remotes.jira` | Jira base URL, used to build ticket-detail links for `jira:` parents in `slop web`/`slop show` | absent (never prompted) or `""` (prompted, explicitly declined) |
| `defaults.stale_after` | how long an `in_progress` ticket can sit with no activity before it's `stale` | `60m` |
| `defaults.review_stale_after` | how long a `review` ticket can sit unactioned (from `review.requested_at`, not general activity) before it's `stale` | `24h` |
| `transcripts` | `local` (captured, gitignored), `commit` (captured, tracked in git), or `off` (never captured) | `local` |

### Staleness thresholds

`defaults.stale_after` and `defaults.review_stale_after` are what
[the `stale` overlay](concepts.md#derived-overlays-blocked-stale-ready) is
computed against — `stale_after` for `in_progress` tickets,
`review_stale_after` for `review` tickets (anchored on when review was
*requested*, not general activity). Both are duration strings —
`<number><unit>` with unit `ms|s|m|h|d`, e.g. `500ms`, `90s`, `60m`, `24h`,
`3d`.

Editing `config.yaml` by hand is fine — it invalidates the derived index
(so the next command that needs it rebuilds automatically) exactly like
editing a ticket file does.

## Actor & harness identity (D17)

Every mutating command needs to know **who** is acting (for the event
audit trail) and, on `slop start`, **what harness** is driving it.

### Actor name resolution order

1. `--as <name>` (only on commands that register it, e.g. `slop start`)
2. `SLOP_ACTOR` environment variable
3. `user:` in `.slop/config.yaml`
4. `git config user.name` (repo-local, falling back to global — git's own
   resolution)

If none of the four resolve to a non-empty name, the command fails with a
`USAGE_ERROR` (exit `2`) naming all four ways to fix it — an unresolvable
actor is never silently defaulted to a placeholder, since that would
quietly break the audit trail every event depends on.

### Actor kind (`human` vs `agent`)

Derived from harness detection: if a known agent harness is detected in
the environment (see below), the actor's `kind` is `"agent"`; otherwise
`"human"`.

### Harness detection

Precedence:

1. `--harness <kind>` flag (only `slop start` registers one) — always
   wins, no exceptions.
2. Otherwise, sniff environment variables, first match wins:
   - `CLAUDECODE === "1"` → `claude-code`
   - `OPENCODE === "1"` → `opencode`
   - `CODEX_SANDBOX_NETWORK_DISABLED` or `CODEX_SANDBOX` set (either) →
     `codex`
3. No match → `other` — a legitimate result, not an error; a plain shell
   invocation with no detectable harness is the "human at the CLI" case.

Detection never throws or blocks `start`; a miss just means a thinner
captured session (`harness.kind: "other"`, `harness.session_id: null`)
plus a warning.

When the harness is `claude-code`, its own session id is captured from
`CLAUDE_CODE_SESSION_ID` if that variable is set and non-empty; no other
harness exposes a session id to the environment today.

## Environment variables

| Variable | Used by | Effect |
|---|---|---|
| `SLOP_ACTOR` | every mutating command | actor-name fallback, rung 2 of the D17 order above |
| `CLAUDECODE`, `OPENCODE`, `CODEX_SANDBOX_NETWORK_DISABLED`, `CODEX_SANDBOX` | `slop start` (and the actor-kind heuristic on every mutating command) | harness auto-detection, see above |
| `CLAUDE_CODE_SESSION_ID` | `slop start` | Claude Code's own session id, captured into `session.harness.session_id` |
| `CODEX_HOME` | transcript capture | overrides where Codex's own transcript files are looked for (defaults to `~/.codex`) |
| `EDITOR`, `VISUAL` | `slop edit` | which editor to open the ticket's JSONC file in (`VISUAL` wins if both are set) |
| `SLOP_WEB_DEBUG` | `slop web` | `1` (or any truthy value) switches to Bun's verbose dev error pages — see [Web UI → Debugging](web-ui.md#debugging) |

None of these need to be set for normal use — `git config user.name` and
plain harness auto-detection (falling back to `other`) already cover the
common cases; `SLOP_ACTOR` and `--harness`/`--as` exist for CI, scripted
agents, and overriding a misdetection.

## Transcripts

Controlled by `transcripts:` in `config.yaml`:

- **`local`** (default) — captured to `.slop/transcripts/session_<ulid>.jsonl`
  whenever a session ends (`stop`/`done`/`drop`) and also, as a snapshot,
  on `review` (which does *not* end the session — see
  [Concepts → Session](concepts.md#session)); gitignored by `slop init`.
- **`commit`** — same capture, but `slop init` does **not** add
  `.slop/transcripts/` to `.gitignore`, so transcripts land in git history.
  Only turn this on if you've thought about what might be in a transcript
  (see the caution below).
- **`off`** — never captured; `session.transcript_ref` stays `null`.

A transcript that can't be located (unsupported harness, harness didn't
write one, etc.) never blocks the underlying command — it warns on stderr
and records `transcript_ref: null`.

**Caution:** transcripts can be large and can contain anything the
session's conversation contained, including secrets pasted into a prompt
or tool output. `local` (gitignored) is the default specifically because
of this; think before switching a project to `commit`.

## See also

- [Concurrency & merging](concurrency-and-merging.md) for why the db
  layout and locking design make config edits and ticket edits safe to
  merge across branches.
- [CLI reference → `init`](cli-reference.md#init) for how `config.yaml`
  first gets written.
