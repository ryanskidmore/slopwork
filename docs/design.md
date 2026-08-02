# Slopwork — Spec

> **Historical document.** This is the internal design spec v0 was built from, preserved as
> written. The maintained, user-facing documentation lives in this directory — start with
> [`README.md`](README.md). Where this spec and the shipped tool disagree,
> [`DECISIONS.md`](DECISIONS.md) records what actually shipped and why.

**v0.6 · July 17, 2026 · slopwork.dev · free OSS**

> **Next action:** build v0 (§4). First milestone: `slop init && slop new "Test feature" && slop ready` against the flatfile db. ~1 day. Full v0: ~2.5 weeks. **v0 exit bar: a full dogfood week (§4.7) with zero fallbacks to markdown TODOs.**

**This spec in five lines:**

1. Slopwork: free OSS work tracker built for agents — engineers break work into a dependency graph; agents pick up tickets, plan, work, and leave an auditable trail ending in an MR and a transcript.
2. Scale target: one engineer (or small team) running 2–3 agents on parallel streams.
3. v0 = local CLI + flatfile JSONC db in `.slop/db/` (git-mergeable) + sessions/plans/transcripts + `review` state linked to MRs + read-only `slop web`.
4. No locks/leases: `start` → `in_progress` under a session; activity timestamps derive `stale`; `review` tracks the MR awaiting human eyes.
5. External parents from day one: `--parent jira:PROJ-123`.

---

## 1. Decisions

| # | Decision | Notes |
|---|---|---|
| D1 | **Human owner at the root**; agent-owned below, any depth | Enforcement = F4 |
| D2 | **TypeScript; binary `slop`** (npm `slopwork`) | |
| D3 | **v0 datastore = flatfile JSONC in `.slop/db/`**, ULID filenames, derived gitignored `index.jsonc` (`slop reindex`). SQL backends return at F8 | |
| D5 | **`blocked`/`stale` derived, never asserted** | |
| D6 | **Full-length prefixed ULIDs** + `root_id` + `path` + short-prefix + slug resolution | |
| D8 | **Agent-embedded UX**; CLI is the driver; MCP on the menu | |
| D9 | **Sessions replace claims** — sessions are real harness sessions (Claude Code / opencode / Codex), with ids, git context, and transcripts | Extended per review |
| D10 | **Specs = structured JSON, markdown inside** | |
| D11 | **No fleet features** | |
| D12 | **Slugs are first-class handles** everywhere ids work — short, branch-style: auto-generated slugs truncate at a word boundary (≈5 words / ≈40 chars, never mid-word); `slop new --slug` accepts an explicit handle, optionally with a single `type/` prefix (`fix/ui-not-showing`, `feat/add-auth`), which resolves as a ref like any other slug. Collisions (either path) still disambiguate git-style (`-2`, `-3`, ...) | Revised: shorter word-boundary auto-slug + explicit `--slug`, for branch-name alignment (F15) |
| D13 | **`draft` + `adhoc` creation affordances**; drafts never `ready` | |
| D14 | **index.jsonc gitignored** (pure derivative, auto-healed) | |
| D15 | **`review` is a stored, OPTIONAL state carrying an MR link.** `slop review <ref> --mr <url>` moves in_progress → review; `done` closes review out — or completes directly from in_progress, skipping review entirely, nagging on stderr for non-`adhoc` tickets that skip it (`adhoc` never nags); changes-requested = `slop start` again (logged as re-entry) | Revised: review made optional, mirroring `--mr`'s own required-with-warning treatment |
| D16 | **Transcripts: stored locally, gitignored by default.** Session end (stop/done/review) attaches the harness transcript to `.slop/transcripts/`; committed only if `transcripts: commit` in config. Session *summaries* are always in the committed db | New per review. Default rationale: transcripts are huge and can contain secrets — see §8.1 |
| D17 | **Actor identity resolution order:** `--as` flag → `SLOP_ACTOR` env → `user:` in config.yaml → `git config user.name`. Harness detection: env sniffing (Claude Code / opencode / Codex set identifiable vars) → `--harness` flag override | New — was ambiguous |

---

## 2. State model

Stored: `draft → open → in_progress → (review) → done`, plus `dropped` (wontdo) from anywhere. `review` is a **checkpoint, not a mandatory step** (D15, revised): `done` closes it out when used, but is equally legal directly from `in_progress` — review is optional, not required.

```
draft ⇄ open ──start──▶ in_progress ──review --mr──▶ review ──done──▶ done
              ▲              │  ▲                       │              ▲
              └────stop──────┘  └──────start (changes requested)──────┘│
                                 └──────────done (review optional)──────┘
```

Derived overlays (D5): `blocked` (live blockers) · `stale` (in_progress *or review*, no activity past threshold — review staleness catches MRs rotting unreviewed).

`ready` = query: `open ∧ no live blockers ∧ no active session ∧ no nonterminal
descendants`. The descendant check is transitive, making the pull queue
leaf-first; `done` and `dropped` descendants do not suppress their parent.
Drafts and review items never appear themselves.

**Working a ticket:** `start` creates a session (harness kind + harness session id + branch/commit captured), sets `in_progress`, prints the context pack. `plan` registers/revises the session's step checklist. `update --progress` logs + bumps activity. `review --mr <url>` records the MR and flips state — the ticket now points at exactly the thing a human needs to look at. `done` completes (cascades unblocks) and finalizes the session: end summary written to the db, transcript captured per D16 — legal from `review` *or* directly from `in_progress` (review is optional, D15 revised); completing a non-`adhoc` ticket that never went through review prints a soft nag on stderr but still succeeds, mirroring `review --mr`'s own required-with-warning treatment of the MR link (§8.1 item 3); `adhoc` tickets (D13) complete directly with no nag at all. `stop` hands off (transcript also captured — a dead session's transcript is often the most valuable one). Takeover of an active ticket: warn + `--takeover`, logged.

---

## 3. The flatfile db

```
.slop/
  config.yaml                 # committed
  AGENTS.md                   # committed — agent onboarding
  db/
    tickets/ticket_<ulid>.jsonc
    sessions/session_<ulid>.jsonc      # plan embedded, versioned
    events/event_<ulid>.jsonc          # immutable, one per event
    index.jsonc                        # derived — GITIGNORED
  transcripts/session_<ulid>.jsonl     # GITIGNORED by default (D16)
```

Merge story: ULID filenames → create-conflicts impossible; events immutable → conflict-free; index gitignored → the always-conflicting file doesn't exist; same-ticket edits → ordinary small JSONC diffs. Atomic writes (tmp+rename) everywhere; `.slop/db/.lock` for multi-file transactions (done-cascade, reparent). Event ordering cursors on the event ULID itself.

**config.yaml:**

```yaml
project: slopwork
user: ryan                    # actor fallback (D17)
remotes:
  repo: https://github.com/ryan/slopwork   # autodetected
  jira: https://yourorg.atlassian.net       # prompted or blank
defaults:
  stale_after: 60m
  review_stale_after: 24h
transcripts: local            # local | commit | off
```

---

## 4. v0 — the dogfood prototype

**Build: ~2.5 weeks. Usable from day 2. Exit bar: §4.7.**

### 4.1 v0 objects (five)

1. **Ticket** — id, name, slug, spec (JSON: `summary`, `details_md`, `acceptance[]`, `context[]`, `meta`, `v`), stored state, **review** (`{mr, requested_at, by}` when in review), priority (0–3, default 2), labels, adhoc, parent (`ticket_…` | `jira:PROJ-123`), `root_id`, `path`, `active_session`, `last_activity_at`, `latest_note`, owner, provenance, timestamps.
2. **Edge** — `blocks` · `parent` · `relates-to` · `discovered-from`; cycle-checked, degree-capped. External parents terminate the local tree (D1 resolves locally).
3. **Session** — id, ticket, actor, **harness** (`{kind: claude-code|opencode|codex|other, session_id}`), **git** (`{branch, commit_at_start}`), started/ended, plan (versioned steps + status), end summary, `transcript_ref`.
4. **Event** — immutable: id, actor, session, verb, entity, payload.
5. **Actor** — name + kind.

### 4.2 v0 command surface

```
# setup & maintenance
slop init | instructions | reindex

# creating & shaping
slop new "Adding new auth provider"
     [--spec -] [--parent <ref>|jira:PROJ-123] [--blocks X] [--discovered-from Y]
     [--label a:b] [--draft] [--adhoc] [--owner ryan] [--priority 1]
slop split <ref> "sub1" "sub2"
slop draft <ref> | undraft <ref>
slop edit <ref>                          # open ticket JSONC in $EDITOR
slop update <ref> [--progress "…"] [--state …] [--priority …] [--label +x -y]
     [--name "…"] [--spec -]             # general mutator; verbs below are sugar

# the agent loop
slop ready [--label x] [--resumable] [--json] [--budget N]
slop start <ref> [--as name] [--harness kind] [--takeover]
slop context <ref>                       # reprint context pack mid-session (no state change)
slop plan <ref> "step 1" "step 2" | --check N | --uncheck N
slop review <ref> --mr <url>             # in_progress → review
slop stop <ref> [--note] | done <ref> [--note] | drop <ref> --reason "…"

# inspecting (the human's daily drivers)
slop status                              # project pulse: counts by state, in-progress w/
                                         # sessions, stale, awaiting review (with MR links)
slop show <ref> [--context] [--tree]
slop search "text"                       # naive scan over names/specs/notes (SlopQL is F6)
slop events [--since event_…] [--ticket <ref>] [--json]
slop web [--port 4553]                   # read-only explorer
```

*(New since v0.5, closing dogfood gaps: `status`, `search`, `edit`, `context`, `review`, `--tree`. Rationale: a dogfood week needs a pulse view, text search, spec editing, mid-session context refresh, and the review flow — without them we'd fall back to grep and markdown within days.)*

### 4.3 Session capture (D9/D16/D17)

`start` sniffs the harness from env (Claude Code, opencode, and Codex each set identifiable variables; `--harness` overrides), records the harness's own session id when exposed, and captures branch + commit. On `stop`/`review`/`done`, slop locates the harness transcript (known per-harness paths, e.g. Claude Code's project JSONL; `--transcript <path>` as manual fallback), copies it to `.slop/transcripts/session_<ulid>.jsonl`, and writes `transcript_ref` + an end summary into the session file. If the transcript can't be found: warn, record `transcript_ref: null`, never block the state change.

### 4.4 `slop web` (read-only)

Ticket list with filters · tree view (external parents as badges → Jira URL from config) · ticket detail: spec, updates timeline, sessions with plan progress, **transcript viewer** (renders the JSONL conversation), **review panel** (tickets in review with MR links + review-staleness) · stale/resumable panel. Mutations arrive with F9.

### 4.5 v0 build checklist

1. Scaffold + flatfile repo layer (atomic writes, lock, reindex) + `init` autodetection. *(~2 days)*
2. Tickets: specs, slugs, drafts, adhoc, external parents, `new/split/draft/undraft/update/edit/show`; ref resolution. *(~2 days)*
3. Graph: edges, cycle check, blocked/ready in index, cascade test. *(~1.5 days)*
4. Sessions: `start/context/plan/stop/done/drop`, harness sniffing, git capture, takeover, staleness. *(~2 days)*
5. **Review flow: `review --mr`, review-staleness, `status`.** *(~1 day)*
6. **Transcript capture (per-harness locators + fallback) + `search`.** *(~1.5 days)*
7. Events + `events --since`. *(~1 day)*
8. `slop web` incl. transcript viewer + review panel. *(~3 days)*
9. Instructions + context packs + polish; **move Slopwork' backlog into Slopwork**. *(~1 day)*

### 4.6 v0 skips (menu)

MCP · elicitations · acceptance-check *execution* · SlopQL · Jira snapshot fetch/rollups (`jira:` links render, nothing syncs) · web mutations · SQL backends · compaction · MR status polling (review state is manual in v0; auto-transition on merge is F11 territory).

### 4.7 The dogfood-ability bar (v0 done =)

A full week of building Slopwork with Slopwork where all of these hold:

1. Every piece of work — including bugs found mid-session — exists as a ticket before it's worked (`discovered-from` chains visible in web).
2. Two agents run in parallel on separate branches; their `.slop/db` merges without manual conflict surgery.
3. Every completed ticket has: a session, a plan with checked steps, an MR it went through `review` with, and a transcript openable in `slop web`.
4. `slop status` + `slop web` fully replace "scroll the terminal to find out what happened."
5. Zero markdown TODO files created all week.

---

## 5. The agent experience (D8)

Target: **"Go work on adding-new-auth-provider"** / **"pick up the next ready ticket under PROJ-123."**

1. `slop init` writes `.slop/AGENTS.md` (+ `CLAUDE.md` link offer): the loop is *ready → start → plan → update --progress → review --mr → done*, house rules ("file discovered work with `--discovered-from`; no TODOs in prose; open an MR and call `review` before claiming done — optional, but skipping it on a non-`adhoc` ticket nags on stderr").
2. `slop start` = one command to full context; `slop context` re-prints it mid-session after compaction.
3. Slugs keep humans out of ULID-land; `--parent` accepts slugs and `jira:` refs.
4. Parallel streams: per-agent sessions, `ready` excludes active work, explicit logged takeovers.
5. The human audits via `status`/`web`: every state change, plan revision, progress note, MR, and transcript — attributed to actor + session + harness.

---

## 6. Feature menu

~~F1 sessions/plans~~ → in v0. ~~F12 fleet scheduler~~ → cut.

| F | Feature | Adds | Needs | Effort |
|---|---|---|---|---|
| F2 | **Elicitations** | Structured "need a human" + `slop questions` inbox + `awaiting_input` overlay | v0 | ~2 days |
| F3 | **Acceptance-check execution** | Run spec `acceptance[]`; `done` refuses until green | v0 | ~3 days |
| F4 | **Root ownership enforcement** | Human owner required on roots | v0 | ~1 day |
| F5 | **MCP server** | Tiered tools (core ≈ 7 / ~5k tokens) | v0 | ~3 days |
| F6 | **SlopQL** | Link-field filters + bounded transitive + real search | v0 | ~1 wk |
| F7 | **Aggregation + more edges** | `group by`; `duplicates`/`supersedes`/temporal | F6 | ~3 days |
| F8 | **Shared mode** | HTTP API, credentials, SQL backend behind repo interface | v0 | ~2–3 wks |
| F9 | **Web v2** | Mutations, review queue, elicitation inbox, session replay | F2 | ~1.5 wks |
| F10 | **Plan gates** | Flagged labels require plan approval; creator ≠ approver | F9 | ~3 days |
| F11 | **Jira/GitHub federation** | Snapshot fetch for `jira:`/`gh:` parents, progress rollups, **MR status polling → auto-close review on merge** | v0 | ~1 wk |
| F13 | **Standing queries** | Saved queries emitting events on change | F6 | ~4 days |
| F14 | **Compaction** | Summarize old closed tickets | v0 | ~1 wk |
| F15 | **Workspace links++** | Worktree provisioning hints, PR back-links | v0 | ~2 days |

---

## 7. Suggested default path

1. **v0** — ~2.5 weeks, dogfood from day 2, exit via §4.7.
2. **F5 MCP + F2 elicitations** — ~1 week.
3. **F11 federation** — `jira:` links + MR polling start earning. ~1 week.
4. **F6 SlopQL** — ~1 week.
5. **F3 + F4** — done-means-done + ownership. ~4 days.

## 8. Resolved ambiguities & remaining questions

### 8.1 Resolved this revision

1. **Transcript policy (D16):** local + gitignored by default (size, secrets); `transcripts: commit` opt-in; summaries always committed; capture on *every* session end, not just `done` — abandoned sessions' transcripts are the most valuable ones.
2. **Actor + harness identity (D17):** explicit resolution orders; no more "how does the CLI know who's acting."
3. **Review transitions (D15):** `review --mr` required-with-warning (can enter review without an MR link, but it nags); changes-requested = re-`start` (logged); no separate `changes_requested` state. **Review itself is optional** (revised): `done` accepts `in_progress → done` directly, applying the identical required-with-warning philosophy one level up — a non-`adhoc` ticket that skips review entirely still nags on stderr, `adhoc` tickets don't, and `review → done` stays exactly as before.
4. **Priority scale:** 0 (urgent) – 3 (low), default 2.
5. **Timestamps:** ISO-8601 UTC everywhere. Short-prefix collisions: git-style "ambiguous ref" error.

### 8.2 Still parked

1. Event-file volume — shard `events/` by month when a dogfood project passes ~5k files.
2. Slug renames — keep old slugs resolving via index history? *Leaning yes.*
3. Transcript redaction (API keys in transcripts even when local) — *revisit before any `transcripts: commit` recommendation.*
4. Multiple MRs per ticket (stacked diffs) — v0 stores one; `meta` holds extras. *Revisit if dogfood hits it weekly.*
5. `jira:` ref validation — warn on format mismatch, don't block.

---

*Evidence base: "Jira for Agents — research report" (July 17, 2026). Superseded: v0.5 (no review state, sessions without harness/transcripts, no status/search/edit/context commands).*
