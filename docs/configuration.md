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
  lock_timeout: 5s
backend: flatfile              # optional — see "Storage backend" below
```

| Field | Meaning | Default |
|---|---|---|
| `project` | project name, shown in `slop instructions`/generated docs | required (autodetected from the directory name at `init`) |
| `user` | actor-name fallback, checked after `--as`/`SLOP_ACTOR`, before `git config user.name` | none |
| `remotes.repo` | this repo's remote URL | autodetected from `git remote` at `init`; absent if detection failed |
| `remotes.jira` | Jira base URL, used to build ticket-detail links for `jira:` parents in `slop web`/`slop show` | absent (never prompted) or `""` (prompted, explicitly declined) |
| `defaults.stale_after` | how long an `in_progress` ticket can sit with no activity before it's `stale` | `60m` |
| `defaults.review_stale_after` | how long a `review` ticket can sit unactioned (from `review.requested_at`, not general activity) before it's `stale` | `24h` |
| `defaults.lock_timeout` | how long a mutating command waits to acquire `.slop/db/.lock` before giving up with `CONFLICT` (exit `6`) — see [Concurrency & merging](concurrency-and-merging.md#the-db-lock-serializing-the-write-path) | `5s` |
| `backend` | which storage backend this repo uses — see "Storage backend" below | `flatfile` (same as the key being absent) |

Unknown keys (e.g. one left behind by an older slopwork version) are
ignored; commands warn on stderr about a known-legacy key and keep
working — delete the stale line to silence the warning.

## Storage backend

`backend:` (G2) selects which [storage backend](storage-backends.md) this
repo reads and writes through — every command and `slop web` construct
one via `openStorage()` and go through it exclusively, never touching
`.slop/db/` files directly outside the backend implementation itself.
Accepted forms, all equivalent to their normalized shape:

```yaml
backend: flatfile              # explicit default — same as the key being absent
```

```yaml
backend: remote                # shorthand for {kind: remote} with no url configured yet
```

```yaml
backend:                       # structured form
  kind: remote
  url: https://slop.example.workers.dev
```

A bare `backend:` line (real-YAML `null`) means the same as the key being
entirely absent: `flatfile`. The flatfile backend — `.slop/db/{tickets,
sessions,events}/` on disk, as described throughout
[Concepts](concepts.md) — needs no configuration at all and remains the
default for every repo.

`backend: remote` (or the structured form) selects a remote backend —
today, a **stub**: every operation fails immediately with a clear "remote
backend not implemented" error (exit `1`) naming
[docs/storage-backends.md](storage-backends.md), the JSON-over-HTTP wire
contract a real remote implementation (e.g. a Cloudflare worker) will
speak once one exists. Configuring this today is still useful for staging
a repo's config ahead of a real server, or for testing the error path
itself — it never silently falls back to the flatfile db.

A remote backend's auth token is deliberately **not** configured in
`config.yaml` (a committed, git-mergeable file) — it comes from the
`SLOP_REMOTE_TOKEN` environment variable instead. See
[storage-backends.md](storage-backends.md#authentication) for the exact
header this becomes on the wire.

`slop edit` requires the flatfile backend's local-file capability ($EDITOR
opens a real file on disk); against a remote backend it refuses cleanly
with a `USAGE_ERROR` naming `slop update`'s non-interactive flags as the
alternative, rather than trying and failing to locate a file that doesn't
exist locally.

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
| `EDITOR`, `VISUAL` | `slop edit` | which editor to open the ticket's JSONC file in (`VISUAL` wins if both are set) |
| `SLOP_WEB_DEBUG` | `slop web` | `1` (or any truthy value) switches to Bun's verbose dev error pages — see [Web UI → Debugging](web-ui.md#debugging) |
| `SLOP_REMOTE_TOKEN` | every command, when `backend: {kind: remote, ...}` | bearer token for the remote backend's `Authorization` header — see [Storage backend](#storage-backend) and [storage-backends.md](storage-backends.md#authentication) |

None of these need to be set for normal use — `git config user.name` and
plain harness auto-detection (falling back to `other`) already cover the
common cases; `SLOP_ACTOR` and `--harness`/`--as` exist for CI, scripted
agents, and overriding a misdetection.

## See also

- [Concurrency & merging](concurrency-and-merging.md) for why the db
  layout and locking design make config edits and ticket edits safe to
  merge across branches.
- [CLI reference → `init`](cli-reference.md#init) for how `config.yaml`
  first gets written.
