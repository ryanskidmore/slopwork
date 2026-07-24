# Slopwork documentation

**Slopwork** (`slop`) is a free, open-source work tracker built for coding
agents. Engineers break work into a dependency graph of tickets; agents pick
tickets up, plan their approach, work through a session, and leave an
auditable trail — progress notes, plan checkpoints, an MR, and a transcript —
ending in `done`.

It's a local-first CLI (binary `slop`, npm package `slopwork`) backed by a
flatfile JSONC database under `.slop/db/` that's designed to merge cleanly
across parallel agent branches, plus a read-only local web explorer
(`slop web`).

This is the **user + operator documentation** — how to install it, how the
model works, every command and flag, the workflow agents follow, the web UI,
configuration, and the concurrency story. For the original design rationale
and the decisions behind it, see [`design.md`](../design.md) and
[`DECISIONS.md`](../DECISIONS.md) in the repo root; this doc set distills
those into what you need to actually use the tool.

## Who this is for

- **Engineers / humans** who want a dependency graph of work instead of a
  flat backlog, and who want to *audit* what an agent actually did — not
  just trust a chat transcript.
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
| [Web UI](web-ui.md) | What `slop web` shows — list, tree, ticket detail, transcripts, review/stale panels |
| [Configuration](configuration.md) | `.slop/config.yaml`, actor/harness identity resolution, environment variables |
| [Concurrency & merging](concurrency-and-merging.md) | Why `.slop/db/` merges cleanly, the multi-file lock, and lock-free progress updates |

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
