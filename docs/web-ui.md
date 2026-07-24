# Web UI

```sh
slop web              # http://localhost:4553
slop web --port 0      # let the OS pick a free port
```

`slop web` serves a **read-only** local explorer over whatever `.slop/`
directory it finds by walking up from your current directory (same
convention as `.git`/`.slop` discovery elsewhere in the CLI) — the same
db your `slop` commands write to, no separate sync step. It binds to
`127.0.0.1` only; there is no route, anywhere, that accepts anything but
`GET`/`HEAD` — a `POST`/`PUT`/`DELETE`/`PATCH` to any path gets a
`405`. There are no web mutations in this version of slopwork; every
write still goes through the CLI.

Default port is **4553**. `--port 0` picks a free port instead.

## Pages

### Ticket list (`/tickets`)

Every ticket, filterable by **state**, **label**, **priority**, and
**owner**, plus a free-text filter box. Shows state, priority, name, slug,
labels, owner, and last activity for each row, with `blocked`/`stale`
badges where they apply. The filter is a plain GET form (works with
JavaScript disabled); a client-side instant filter layers on top as
progressive enhancement.

### Tree view (`/tree`)

The parent/child hierarchy. An external parent (`jira:PROJ-123`) renders as
a **badge linking out to the Jira URL** built from `remotes.jira` in
`config.yaml` — external parents terminate the local tree (they're a leaf
-upward badge, never a traversable node), matching
[Concepts → Edge](concepts.md#edge).

### Ticket detail (`/tickets/:ref`)

Everything about one ticket:

- **Spec** — `summary`, `details_md` rendered as markdown, `acceptance[]`,
  `context[]`, `meta`.
- **Relationships, both directions** — outgoing `parent`/`blocks`/
  `relates_to`/`discovered_from`, and the reverse (who blocks this ticket,
  what relates back to it, what was discovered from it) — the reverse
  direction is derived, never stored (see
  [Concepts](concepts.md#edge)).
- **Overlays with reasons** — a `blocked` badge lists exactly which live
  tickets are blocking it; a `stale` badge names which clock is overdue
  (in-progress activity, or review-request age) and since when.
- **Updates timeline** — every event for this ticket, **newest-first**
  (like a GitHub issue's activity feed).
- **Sessions** — one section per session, **oldest-first** (a session
  history reads as a narrative): actor, harness kind, git branch/commit,
  start/end times, every plan version with its checked steps, end summary,
  and a link into the transcript viewer.
- **Review panel data** — MR link (if any) and review-staleness, when the
  ticket is/was in review.
- **Resolution** — the long-form `--outcome` writeup, when set, rendered
  as markdown.

### Transcript viewer (`/tickets/:ref/sessions/:sessionId/transcript`)

Renders a session's captured `.jsonl` transcript as readable HTML, never
raw JSON: user/assistant turns as distinct blocks, prose rendered as
markdown, `thinking` blocks de-emphasized and collapsible, `tool_use`
collapsed behind the tool's name, `tool_result` collapsed with an expand
affordance (very long tool output is truncated with a note), and
non-conversational record types hidden by default. Paginated so a
multi-megabyte transcript stays responsive.

### Review panel (`/review`)

Every ticket currently in `review`, with its MR link and how long it's
been waiting — sorted **longest-awaiting-first**, the order a human
triaging reviews actually wants.

### Stale panel (`/stale`)

In-progress or review tickets with no activity past the configured
threshold (`defaults.stale_after` / `defaults.review_stale_after` in
`config.yaml` — see
[Configuration](configuration.md#staleness-thresholds)).

## Staying in sync with the CLI

The web UI computes `blocked`/`stale` itself, in memory, straight from the
entity files and `config.yaml` on every request — it does not read
`index.jsonc` and never needs `slop reindex`. It also folds in
lock-free `update --progress` events the same way the CLI's derived index
does, so a progress note posted by an agent seconds ago already shows up
in `latest_note`/`last_activity_at` and any staleness it resets — see
[Concurrency & merging](concurrency-and-merging.md#lock-free-progress-updates).

## Debugging

`SLOP_WEB_DEBUG=1 slop web` switches Bun's error handling to its verbose
development mode (full stack traces in the HTTP response instead of a
terse generic error body) — an escape hatch for local debugging, not
something to leave set day-to-day, since it can leak server-side detail
into a response body.
