# Agent workflow

This is the loop an agent (Claude Code, opencode, Codex, or a human at the
CLI) is expected to follow in a slopwork-tracked repo, and the house rules
behind it. It mirrors what `slop instructions` prints for a given
project — run that command for the live, project-specific version (it
interpolates your `config.yaml`'s project name and Jira URL); this doc is
the durable, cross-project explanation of *why*.

## When to act, at a glance

| Situation | Do this |
|---|---|
| Told "work on X" (id, slug, or jira ref) | `slop show X --context` → if it has open subtickets, pick/start the right one; else `slop start X` |
| Told "pick up the next thing" | `slop ready --json --budget 3000` → `slop start <top item>` |
| About to start non-trivial work with no ticket | `slop new "…"` first (ask the human if unsure it's wanted), then start it |
| Discover a bug/follow-up mid-task | `slop new "…" --discovered-from <current>` — never a TODO comment, never "I'll mention it later" |
| Blocked by missing work | `slop new "<what's missing>" --blocks <current>` to file the blocker, tell the human |
| Need a human decision | `slop update <ref> --progress "QUESTION: …"`, then stop or keep going on unblocked parts |
| Code done, MR opened | `slop review <ref> --mr <url>` |
| MR merged / work verified | `slop done <ref> --note "…"` |
| Closing several tickets at once (batch-close) | `slop done <ref> <ref> … --note "…"` (or `drop`/`update`) — never one process per ticket |
| Stopping without finishing | `slop stop <ref> --note "<handoff: state, next step, gotchas>"` |
| Need to browse/filter tickets beyond ready (state/label/owner/parent) | `slop list --state open --label area:auth --json` |
| Asked "what's the status?" | `slop status`, summarize — don't recite raw output |

## The loop

1. **`slop start <ref>`** — moves the ticket to `in_progress`, creates a
   session, prints the context pack (spec, ancestry, blockers, prior
   sessions). Read it fully before writing any code.
2. **`slop plan <ref> "step 1" "step 2" …`** — plan before multi-step
   work. Revise the plan (a new call with new step text) if the approach
   changes; don't silently diverge from what's written down.
3. **Work.** At each meaningful checkpoint — a step done, a decision made,
   a surprise found — `slop plan <ref> --check N` and
   `slop update <ref> --progress "one-line note"`. Checkpoint-level, not
   keystroke-level.
4. **File everything you discover:** `slop new "…" --discovered-from <ref>`.
5. **Open an MR, then `slop review <ref> --mr <url>`.** Only run `slop done`
   after the change is merged or otherwise verified — done means done.

## House rules

1. **The tracker is the truth.** No TODO comments, no `NOTES.md`, no work
   state kept in prose. If it's work, it's a ticket.
2. **Never fake state.** Don't `done` unverified work, don't `--check`
   unfinished plan steps, don't skip `review` just because a change "is
   small." (Note: `review` is *mechanically* optional as of the current
   state machine — `slop done` will let a non-`adhoc` ticket through
   directly from `in_progress` — but skipping it prints a nag, and this
   house rule asks you not to lean on that escape hatch as a matter of
   habit. See [Concepts → state machine](concepts.md#state-machine).)
3. **Don't take over.** If `start` warns that another session is active on
   a ticket, stop and tell the human. Use `--takeover` only when explicitly
   instructed to.
4. **Stopping requires a handoff note.** The next session — probably
   another instance of you, with no memory of this one — starts from your
   `--note`. Write what you'd want to read: current state, next step,
   traps.
5. **Prefer structured spec fields.** Put acceptance criteria in
   `spec.acceptance[]` and file/URL pointers in `spec.context[]`, not
   buried in prose.
6. **Budget your reads.** `ready`, `list`, `status`, `search`, `events`, and
   `context` all take `--json --budget N` to cap output (`show --context`
   too); use `slop context <ref>` to reload your bearings after
   compaction instead of re-exploring the repo from scratch.
7. **Bulk-close, don't loop.** `slop done`/`drop`/`update` accept multiple
   refs (`slop done a b c --note "…"`) or `-` for stdin, applying per-ref
   with per-ref outcomes — never spawn one process per ticket to close
   out a batch (see "Session ownership" above for the fuller writeup).

## Session ownership

`start` gates a ticket's active session behind house rule 3 above
(`--takeover` required to seize one) — but `plan` (incl. `--check`/
`--uncheck`), `stop`, `done`, and `drop` do not: each acts on whatever
session is currently active on the ticket, resolved from the ticket
itself, regardless of whether the acting actor is the one who started it.

This is a deliberate decision, not an oversight. The coordinator pattern
(one human, or one lead agent, running or reviewing several other agents'
sessions) routinely needs to check off plan steps, hand off a stalled
session, or close one out on someone else's behalf — requiring
`--takeover`-style ceremony on four more commands would make that pattern
unworkable, for a scenario (a legitimate coordinator acting on a session
another actor started) that isn't actually misuse.

What IS enforced: every mutation already records the *acting* actor in
its own event (see [Concepts → event](concepts.md#event)) — the audit
trail is never silent about who really did it, even when they aren't who
started the session. On top of that, `plan`/`stop`/`done`/`drop` print a
`warning:` line on stderr whenever the acting actor's name differs from
the session's own recorded actor, e.g.:

```
warning: acting as "coordinator" (agent), but session session_01ABC... was
started by "worker-3" (agent) — proceeding anyway (session ownership is
not enforced by design; see docs/agent-workflow.md, "Session ownership").
```

This is informational, never a block — the command underneath it always
still succeeds. If you see it and you're *not* deliberately coordinating
another actor's session, that's worth a second look: it usually means
you're operating on the wrong ticket, or a stale `<ref>`.

**Closing several tickets at once** (t-mmngo) is exactly this coordinator
pattern's other common need: `slop done a b c --note "…"` (or `drop`/
`update`) applies to every ref independently — one bad ref never blocks
the rest — and reports each ref's own outcome, so a coordinator batch
-closing 40 stale tickets does it in one invocation instead of 40 process
spawns. Refs can also come from stdin (`slop done - --note "…" < refs.txt`,
one ref per line) for scripting. See
[CLI reference → `done`](cli-reference.md#done) for the full contract
(text/`--json` shapes, exit-code rule).

## Reference resolution

Anywhere a `<ref>` is accepted: a full id (`ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1`),
a unique short prefix (`01KY9R`), a slug (`adding-new-auth-provider`), a short
`t-<code>` handle, and — for `--parent` only — an external ref
(`jira:PROJ-123`). An ambiguous prefix makes the CLI error and list every
candidate; pick explicitly. Full rules:
[CLI reference → ref resolution](cli-reference.md#ref-resolution).

## Edge cases

- **No `.slop/` in the repo:** slopwork isn't set up. Ask the human before
  running `slop init` — never initialize on your own.
- **Draft tickets** (`state: draft`) are not workable — they're still
  being defined. Don't start them; ask if one looks like it should be
  yours.
- **`ready` returns nothing:** check `slop status` for blocked/stale items
  and report what's gating progress rather than inventing work.

## Why this loop, not something looser

Every step above writes an immutable [event](concepts.md#event) — this is
what lets a human run `slop status`/`slop show`/`slop web` and reconstruct
exactly what happened, when, and by whom, instead of trusting a chat
log or a commit message written after the fact. See
[Concepts](concepts.md) for the full data model this loop is built on, and
[Web UI](web-ui.md) for how a human audits it.
