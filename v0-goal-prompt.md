# Slopworks v0 — /goal setup

Two parts: **Part 1** is the condition for `/goal` (transcript-verifiable, ~1.7k chars, under the 4k limit). **Part 2** is the kickoff message carrying the orchestration rules — `/goal` only holds the done condition; the *how* has to travel in a normal prompt.

**Usage** (Claude Code ≥ 2.1.139, Opus as session model):

1. Switch to auto mode (a goal doesn't change permissions — without auto mode it will stop to ask).
2. Send Part 2 as your first message.
3. Set the goal: `/goal` + the Part 1 text.
4. Walk away. Check progress anytime with `/goal`.

---

## Part 1 — the `/goal` condition (paste verbatim)

Slopworks v0 (spec: design.md §4; plan: v0-implementation-plan.md) is fully implemented, and the FINAL message contains a verification report with ALL of the following, freshly run, with real output shown: (1) full test suite passes, exit 0, including an acceptance test for every plan §3 work item (A1–A4, B1–B4, C1–C5, D1–D5, E1, E2); (2) lint/format check exits 0; (3) `slop --help` output from the built binary listing every spec §4.2 command: init, instructions, reindex, new, split, draft, undraft, edit, update, ready, start, context, plan, review, stop, done, drop, status, show, search, events, web; (4) an end-to-end smoke transcript in this repo: init → new → ready → start → plan → update --progress → review --mr → done → status → show --tree → search → events, each command with its actual output; (5) E2 merge-simulation output: two divergent clones (create/edit/close on both) git-merged with zero manual conflicts except same-ticket edits, reindex rebuilds clean, script exits 0; (6) evidence that `slop web` serves all spec §4.4 views against real data (HTTP status/route checks or equivalent); (7) `slop status` output showing the remaining backlog filed as Slopworks tickets in .slop/db (the E3 dogfood flip); (8) `git status` clean on main plus a `git log --oneline` excerpt showing one commit per work item. Constraints that must hold throughout: all code was written by Sonnet subagents, never the coordinator; commits go directly to main with no branches; spec §4.6 skips stay skipped; E4 (human dogfood week) is out of scope and NOT required. The goal is NOT met if any numbered item is missing from the transcript, stale (not re-run after the last code change), or failing. Or stop after 150 turns.

---

## Part 2 — the kickoff message (paste verbatim)

You are the **coordinator** for building Slopworks v0 in this repo, end to end, in one continuous run. Your job is orchestration, review, verification, and git — **you never write or edit source code yourself**. All implementation happens through subagents. A `/goal` is set with the completion condition; your final verification report must surface every piece of evidence it names.

**Sources of truth**: `design.md` (spec v0.6 — what to build: state model, flatfile db, commands §4.2, web views §4.4, skips §4.6) and `v0-implementation-plan.md` (how — work items S1–S3, A1–A4, B1–B4, C1–C5, D1–D5, E1–E3, dependency graph, per-item acceptance criteria). Read both fully first. Conflicts: spec wins on behavior, plan wins on sequencing.

**Hard rules**

1. **Coordinator never implements.** Every code/test/config change is done by a subagent: `Agent` tool, `subagent_type: "general-purpose"`, `model: "sonnet"` (Sonnet 5). You may read files, run verification commands (tests, build, CLI smoke checks), manage git, and track progress — nothing else.
2. **Commit directly to `main`.** One commit per completed work item, message prefixed with its id (e.g. `A3: flatfile repo layer`). No branches, no PRs.
3. **Never stop, never ask.** When something is ambiguous or an approach fails, pick the option the spec/plan already sanctions (fallbacks are documented — e.g. `--harness`/`--transcript` manual flags), log one line in `DECISIONS.md`, keep moving.
4. **Nothing lands without its acceptance test.** Each work item's plan-table acceptance criterion must exist as a passing automated test before you commit it.

**Execution order**: S1–S3 spikes → A1→A2→A3→A4 → lanes B/C/D per the dependency graph → E1 → E2 → E3. Spike adaptations (you're headless in Claude Code): S1/S2 — dump this session's env to identify Claude Code's vars and transcript path empirically; research opencode/Codex from docs; where unverifiable, best-effort detection plus the documented `--harness`/`--transcript` fallbacks. S3 — scratch-test `jsonc-parser`'s edit API. Write findings to `spikes/findings.md`; feed it to the C1/C4 subagents.

**Parallelism**: dispatch subagents concurrently only when file footprints are disjoint (the big win: D5's web SPA on fixture data alongside lanes B/C). Shared-module work runs serially; when in doubt, serialize.

**Dispatch protocol** — every subagent prompt is self-contained: the work item id + exact acceptance criteria copied from the plan table; which doc sections to read (+ `spikes/findings.md` when relevant); current repo state and conventions; deliverable = implementation + tests + short report; run the full test suite before finishing and report honestly; do NOT commit — the coordinator commits after independent verification.

**Verify → commit loop**: subagent reports → you independently run full tests, build, and a CLI smoke check → for keystones A3, B4, C3, E2, additionally dispatch a fresh Sonnet reviewer to adversarially review the diff against the acceptance criteria → failures go to a fix subagent with the exact failing output (never patch it yourself) → green → commit → next unblocked item.

**Dogfood flip (M2)**: the moment B1–B4 + C1–C3 + D1 have landed, run `slop init` here and file every remaining work item as a real Slopworks ticket with proper edges (E3, pulled early). From then on, `slop ready` picks the next dispatch; `start`/`done` tickets as subagents complete them; file discoveries with `--discovered-from`. Before the flip, use your todo list.

**Scope**: E4 (human dogfood week) is out of scope. §4.6 skips are binding (no MCP, SlopQL, Jira sync, web mutations, SQL). D5's §4.4 view list is closed — read-only, those views, nothing more. `.gitignore` must cover `index.jsonc` and transcripts per D14/D16.

**Finish**: when everything is built, produce the final verification report the goal condition demands — every numbered item, freshly run, real output — plus a copy-pasteable quickstart for the human.
