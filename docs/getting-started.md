# Getting started

## Install

Slopwork needs **Bun ≥ 1.3 at runtime**, no matter which install channel you
use — the CLI is Bun-native (`Bun.serve`, `Bun.file`, and
text-imports throughout `src/`), so there is no pure-Node build.

```sh
# Bun (recommended — the tool needs Bun at runtime anyway)
curl -fsSL https://bun.sh/install | bash    # if Bun isn't installed
bun add -g slopwork

# Node users: works too, via a launcher that delegates to Bun
npm i -g slopwork       # still requires Bun installed; prints a clear
                          # message and exits if Bun can't be found
```

Either way you end up with a `slop` binary on your `$PATH`. Confirm it works:

```sh
slop --help
```

## Initialize a repo

Run this once per repo, from anywhere inside it:

```sh
slop init --yes
```

This walks up from your current directory looking for an existing `.slop/`
(same convention as `.git`); if none is found it creates one at your git
repo's top level (or the current directory, if there's no git repo at all).
It writes:

- `.slop/config.yaml` — project name, actor fallback, git remote, Jira base
  URL, staleness thresholds (autodetected where possible;
  see [Configuration](configuration.md))
- `.slop/db/{tickets,sessions,events}/` — the flatfile database, with a
  tracked `.gitkeep` in each so the empty skeleton is committable
- `.slop/AGENTS.md` — this project's onboarding rules, generated from the
  same source `slop instructions` prints
- `.claude/skills/slopwork/SKILL.md` — only if a Claude Code setup is
  detected in this repo
- a managed section in `.gitignore` (the derived index, the lock file,
  and atomic-write temp files)

`--yes` accepts every autodetected default and never prompts (safe for
agents/CI). Interactively, it will also ask whether to add a pointer to an
existing `CLAUDE.md`. Useful flags: `--jira <url>` (pass `""` to explicitly
leave it blank), `--project <name>`, `--user <name>`, `--link-claude-md`.
Re-running `init` on an already-initialized repo never touches
`config.yaml` or `db/` — it only refreshes the generated docs and the
gitignore section.

Full flag reference: [CLI reference → `init`](cli-reference.md#init).

## A first end-to-end walkthrough

The full agent loop is: **ready → start → plan → update --progress → (ask
→ answer, if something needs a human's call) → review --mr → done**. Here
it is end to end.

### 1. File a ticket

```sh
slop new "Add password reset flow" --priority 1
```

```
created ticket_01KYA7TH26K5AY5ACN4RW1ET94  (slug: add-password-reset-flow)
  handle: t-m1k6w
  Add password reset flow
  state: open  priority: 1
```

You now have three ways to refer to this ticket: the full id, the slug
(`add-password-reset-flow`), or the short handle (`t-m1k6w`) — see
[CLI reference → ref resolution](cli-reference.md#ref-resolution).

### 2. Find what's ready

```sh
slop ready
```

```
ready (1):
  [P1] ticket_01KYA7TH26K5AY5ACN4RW1ET94  add-password-reset-flow  "Add password reset flow"  — open, no live blockers, no active session, no nonterminal descendants
```

`ready` returns actionable leaves: open, no live blockers, no active session,
and no nonterminal descendants. Drafts and in-review tickets never show up
here; parents reappear after all of their descendants are done or dropped.

Want to just browse — every ticket, or filtered by state/label/owner,
regardless of whether it's workable right now? That's `slop list`:

```sh
slop list --state open --state in_progress
slop list "password reset"    # free-text match against name/slug/summary
```

`ready` answers "what's workable now"; `list` is plain, deterministic
browsing with no such filter — see [CLI reference →
`list`](cli-reference.md#list).

### 3. Start it

```sh
slop start add-password-reset-flow
```

This creates a session (capturing the detected harness and current git
branch/commit), moves the ticket to `in_progress`, and prints the full
**context pack** — spec, ancestry, blockers, prior sessions — so an agent
never has to go spelunking for background.

### 4. Plan

```sh
slop plan add-password-reset-flow \
  "Add reset token model" "Add email send" "Add reset endpoint"
```

Each call to `plan` with step text registers a brand-new plan **version**
(diffable from the last). Check off steps as you go — this does *not* bump
the version:

```sh
slop plan add-password-reset-flow --check 1
```

### 5. Log progress as you work

```sh
slop update add-password-reset-flow --progress "token model done, writing email send next"
```

A pure `--progress` call is cheap and lock-free — see
[Concurrency & merging](concurrency-and-merging.md) for why that matters
when several agents are working the same repo at once.

### 6. Hit a decision only a human can make? Ask

```sh
slop ask add-password-reset-flow "Should reset links expire in 15 or 30 minutes?" \
  --option 15m --option 30m
```

This records a structured question (optionally multiple-choice via
`--option`) and marks the ticket `awaiting_input` — `slop status`/`slop
ready` surface it so it doesn't get silently picked up again on the same
snag. A human answers with the question id `ask` printed:

```sh
slop answer <question-id> "30 minutes"
```

`slop questions` is the inbox — every open question, oldest first,
across the whole repo:

```sh
slop questions
```

### 7. Open a review

```sh
slop review add-password-reset-flow --mr https://github.com/example/repo/pull/42
```

Moves the ticket `in_progress → review` and records the MR link. This is
the checkpoint a human looks for. (`--mr` is recommended, not required —
see [Concepts → state machine](concepts.md#state-machine).)

### 8. Complete it

```sh
slop done add-password-reset-flow \
  --note "merged and verified in staging" \
  --outcome "Added token-based password reset with 15-minute expiry."
```

`done` finalizes the session (writes an end summary), and cascades: any
other ticket that was blocked *only* by this one flips to unblocked and
is reported.

Closing several tickets at once (a batch of small, already-merged fixes)?
`done`/`drop` accept more than one ref, applied independently — one bad
ref never blocks the rest:

```sh
slop done ticket-a ticket-b ticket-c --note "batch: all merged and verified"
```

### 9. Check the pulse

```sh
slop status
```

```
Slopwork status — 1 ticket(s)

  draft            0
  open             0
  in_progress      0
  review           0
  done             1
  dropped          0
  ------------------
  total            1

  blocked          0
  stale            0
```

Inspect any ticket in depth, including its full ancestry tree:

```sh
slop show add-password-reset-flow --context
slop show add-password-reset-flow --tree
```

Or browse it visually:

```sh
slop web
```

```
slop web serving /path/to/repo/.slop
  http://localhost:4553
```

Open `http://localhost:4553` for a read-only ticket list, tree view, and
per-ticket detail with sessions, plans, and the
review/stale panels — see [Web UI](web-ui.md).

## Where to next

- [Concepts](concepts.md) for the full model (edges, sessions, events, the
  state machine, derived overlays).
- [CLI reference](cli-reference.md) for every command and flag.
- [Agent workflow](agent-workflow.md) for the house rules an agent is
  expected to follow (`slop instructions` prints the same thing, tailored
  to your project's config).
