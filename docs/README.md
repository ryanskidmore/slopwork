# Slopwork documentation

**Slopwork** (`slop`) is a free, open-source work tracker built for coding
agents. Engineers break work into a dependency graph of tickets; agents pick
tickets up, plan their approach, work through a session, and leave an
auditable trail — progress notes, plan checkpoints, and an MR —
ending in `done`.

It's a local-first CLI (binary `slop`, npm package `slopwork`) backed by a
flatfile JSONC database under `.slop/db/` that's designed to merge cleanly
across parallel agent branches, plus a read-only local web explorer
(`slop web`).

This is the **user + operator documentation** — how to install it, how the
model works, every command and flag, the workflow agents follow, the web UI,
configuration, and the concurrency story. For the original design rationale
and the decisions behind it, see the history section below; this doc set
distills those into what you need to actually use the tool.

## Who this is for

- **Engineers / humans** who want a dependency graph of work instead of a
  flat backlog, and who want to *audit* what an agent actually did — not
  just trust a chat log.
- **Coding agents** (Claude Code, opencode, Codex, or a plain human at the
  CLI) that need a single source of truth for "what should I work on" and
  "how do I record what I did."

## Contents

| Doc | Covers |
|---|---|
| [Getting started](getting-started.md) | Install, `slop init`, a full walkthrough: new → ready → start → plan → update → review → done |
| [Concepts](concepts.md) | The five entities (Ticket, Edge, Session, Event, Actor), the state machine, derived overlays (`blocked`/`stale`/`ready`), the flatfile db layout |
| [CLI reference](cli-reference.md) | Every command, every flag, ref resolution, exit codes |
| [Agent workflow](agent-workflow.md) | The loop agents follow and the house rules (mirrors `slop instructions`) |
| [Web UI](web-ui.md) | What `slop web` shows — list, tree, ticket detail, review/stale panels |
| [Configuration](configuration.md) | `.slop/config.yaml`, actor/harness identity resolution, environment variables |
| [Concurrency & merging](concurrency-and-merging.md) | Why `.slop/db/` merges cleanly, the write-path lock, and lock-free progress updates |
| [Storage backends](storage-backends.md) | The pluggable `StorageBackend` interface, selecting flatfile vs. remote, and the remote wire contract |
| [Benchmarks](benchmarks.md) | Measured scaling limits: where the flatfile store stops being fast, and how it behaves under heavy concurrency |

## History & internals

How v0 came to be, preserved as written — read these for the *why* behind a
design choice, the docs above for how to use the tool:

| Doc | Covers |
|---|---|
| [Design spec](design.md) | The internal spec v0 was built from (v0.6): decisions D1–D17, the state model, the flatfile db, the feature menu |
| [Engineering decisions](DECISIONS.md) | Append-only decision log written during the build; cited from code comments by work-item id |
| [v0 implementation plan](v0-implementation-plan.md) | The plan v0 was built from; its work-item ids (A1…E4) name the acceptance tests |
| [Spike findings](spikes/findings.md) | Day-0 research: harness env vars and per-harness session-log locations |
| [JSONC spike](spikes/jsonc.md) | The serialization spike behind the comment-preserving JSONC write path |

## The one-paragraph version

An engineer runs `slop init` in a repo, then `slop new "…"` to file tickets
into a dependency graph (`--parent`, `--blocks`, `--discovered-from`,
external `jira:` parents). An agent runs `slop ready` to find unblocked
work, `slop start <ref>` to claim a ticket (this creates a session and
prints full context), `slop plan`/`slop update --progress` while working,
`slop review --mr <url>` when a merge/pull request is open, and `slop done`
once it's verified. Every one of those actions is an immutable event on
disk; `slop status`, `slop show`, and `slop web` let a human see exactly
what happened, when, and by whom — without scrolling a terminal.
