# Changelog

Notable changes to `slopwork`. Format loosely follows [Keep a Changelog]; this
project uses [semantic versioning], and while it is `0.x` the minor version is
where breaking changes land.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[semantic versioning]: https://semver.org/

## Unreleased

Nothing yet.

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
