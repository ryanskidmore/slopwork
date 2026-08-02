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

## Architecture

The UI is a React + Tailwind v4 + shadcn/ui-style single-page app
(`src/web/frontend/`), fetching from a read-only JSON API (`src/web/api/`)
built on the same `WebDataSource` seam the tool has always used
(`src/web/data-source.ts` / `fixture-data-source.ts`). One `Bun.serve`
instance serves all three of: the API (`/api/*`), the compiled SPA's
static assets (`/assets/app.js`, `/assets/app.css`), and the SPA's own
`index.html` shell for every other path (so a deep link like
`/tickets/<id>` or a hard refresh on any client-routed page works, not
just `/`).

**Fully offline, same-origin, single binary.** The whole SPA — JS, CSS,
and its one bundled webfont (JetBrains Mono, base64-inlined into the CSS
for monospace identifiers/ids/code — see `src/web/frontend/index.css`) —
is bundled at build time (`bun run build:web`) and embedded into the
compiled `dist/slop` executable exactly the way every other static asset
here always has been (Bun's `with { type: "text" }` import). Nothing is
fetched from a CDN, a font service, or any other external host, at build
time or run time. See the README's "Web UI development" section for the
build/dev-loop details.

## Design

- **The audit spine.** Ticket detail's Timeline tab is the tool's
  signature view: every event on a ticket AND its sessions — created,
  session started, plan set/revised, checkpoint ticks, progress notes,
  review requested, done — as one continuous, chronological thread. A
  filled circle marks a human-authored event, a diamond marks an
  agent-authored one (shape, not just color, so authorship reads under
  any color vision), strung along a rail in the one accent color this UI
  spends its boldness on.
- **State is consistent everywhere.** `draft`/`open`/`in_progress`/
  `review`/`done`/`dropped` each get one fixed color, used identically in
  the ticket list, tree, review/stale/questions panels, and ticket detail.
  `blocked`/`stale`/`awaiting_input` (G4, t-jggg9) are separate, lower-key
  OVERLAY badges (an icon + outline treatment) layered on top — attention
  states, not a seventh "state".
- **Identifiers are real monospace and copy-on-click.** Ticket ids,
  `t-<code>` handles, slugs, session ids, and git SHAs render in a
  bundled monospace font; clicking one copies it.
- **Dark and light are both first-class**, following
  `prefers-color-scheme` by default with an explicit toggle (topbar, top
  right) that persists across visits.
- **Cmd/Ctrl-K** opens a command palette to jump straight to any ticket
  by name, slug, or `t-<code>` handle.

## Pages

### Ticket list (`/tickets`)

Every ticket, filterable by **state**, **label**, **priority**, and
**owner** (as `<select>`s, populated from the real facets in the current
db), plus a free-text search box — all reflected in the URL's query
string, so a filtered view is bookmarkable/shareable. Shows state,
priority, name, slug, labels, owner, and last activity for each row, with
`blocked`/`stale`/`awaiting_input` badges where they apply.

### Tree view (`/tree`)

The parent/child hierarchy. An external parent (`jira:PROJ-123`) renders
as a **badge linking out to the Jira URL** built from `remotes.jira` in
`config.yaml` — external parents terminate the local tree (they're a leaf
-upward badge, never a traversable node), matching
[Concepts → Edge](concepts.md#edge).

### Ticket detail (`/tickets/:ref`)

Everything about one ticket, across four tabs:

- **Timeline** (default tab) — the audit spine described above, including
  `question.asked`/`question.answered` events (G4, t-jggg9): a question's
  detail shows its multiple-choice options (if any), and an answer's own
  entry visually pairs with the question it closes (a `re: "<question
  text>"` line under the answer).
- **Spec** — `summary`, `details_md` rendered as markdown, `acceptance[]`,
  `context[]`, `meta`, and the long-form `--outcome` resolution writeup
  (also markdown), when set.
- **Sessions** — one card per session, oldest-first (a session history
  reads as a narrative): actor, harness kind, git branch/commit,
  start/end times, every plan version with its checked steps, and the end
  summary.
- **Relationships** — outgoing `blocks`/`relates_to`/`discovered_from`,
  and the reverse (who blocks this ticket, what relates back to it, what
  was discovered from it) — the reverse direction is derived, never
  stored (see [Concepts](concepts.md#edge)).

Above the tabs: the `blocked`/`stale`/`awaiting_input` overlay badges
(hover for the reason — which live tickets are blocking it, which clock is
overdue and since when, or how many open questions and how long the
oldest has waited), the meta grid (owner, labels, parent, latest note,
last activity, provenance, …), and — when the ticket is in review — its MR
link and review-staleness.

### Review panel (`/review`)

Every ticket currently in `review`, with its MR link and how long it's
been waiting — sorted **longest-awaiting-first**, the order a human
triaging reviews actually wants.

### Questions panel (`/questions`)

G4 (t-jggg9) — every unanswered question across the project, oldest first,
grouped by ticket (the ticket whose oldest open question has waited
longest sorts first), same "who's waited longest" ordering the review
panel uses. Each question shows its text, who asked it and when, and its
multiple-choice options (if any) — the web counterpart of `slop questions`.

### Stale panel (`/stale`)

In-progress or review tickets with no activity past the configured
threshold (`defaults.stale_after` / `defaults.review_stale_after` in
`config.yaml` — see
[Configuration](configuration.md#staleness-thresholds)).

## The JSON API

Every page above is a thin client over `/api/*`, which any other tool can
also call directly (still strictly read-only — GET/HEAD only, same
405-on-write contract as the rest of `slop web`):

| Route | Returns |
|---|---|
| `GET /api/config` | project name, remotes, staleness thresholds, and a `warning` when `config.yaml` couldn't be read/parsed/validated |
| `GET /api/tickets` | ticket list; accepts `state`/`label`/`priority`/`owner`/`q` query params, same semantics as the `/tickets` page's filters |
| `GET /api/tree` | the parent/child hierarchy, nested, with external-parent badges resolved |
| `GET /api/tickets/:ref` | one ticket: spec (markdown pre-rendered to sanitized HTML), relationships, overlays, events, sessions |
| `GET /api/review` | tickets in review, longest-awaiting-first |
| `GET /api/questions` | unanswered questions across the project, oldest first, grouped by ticket (G4) |
| `GET /api/stale` | stale tickets, longest-idle-first |

`:ref` accepts the same forms as everywhere else in the CLI: a full
ticket id, an exact slug, or an unambiguous short id-prefix. Markdown
fields (`spec.details_html`, `resolution_html`)
are rendered and XSS-sanitized server-side (`src/web/markdown.ts` +
`src/web/url-safety.ts` — the same guard used for `remotes.jira`/MR
links, which come back as `{ url, safe_url }` so a client never has to
re-implement scheme-checking): a `javascript:`/`data:` link never reaches
the wire as a live `href`/`src`. See `src/web/api/types.ts` for the full
response shapes.

## Staying in sync with the CLI

The web UI computes `blocked`/`stale`/`awaiting_input` itself, in memory,
straight from the entity files and `config.yaml` on every request — it
does not read `index.jsonc` and never needs `slop reindex`. It also folds
in lock-free `update --progress` events the same way the CLI's derived
index does, so a progress note posted by an agent seconds ago already
shows up in `latest_note`/`last_activity_at` and any staleness it resets —
see
[Concurrency & merging](concurrency-and-merging.md#lock-free-progress-updates).
`awaiting_input` (G4) is derived the same shared way (`slop ask`/`slop
answer` are themselves lock-free event appends, same as `update
--progress`): a question posted by an agent shows up on `/questions` and
the ticket's overlay immediately, with no reindex needed there either.

## Debugging

`SLOP_WEB_DEBUG=1 slop web` switches Bun's error handling to its verbose
development mode (full stack traces in the HTTP response instead of a
terse generic error body) — an escape hatch for local debugging, not
something to leave set day-to-day, since it can leak server-side detail
into a response body.
