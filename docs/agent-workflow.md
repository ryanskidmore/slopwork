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
| Stopping without finishing | `slop stop <ref> --note "<handoff: state, next step, gotchas>"` |
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
6. **Budget your reads.** `ready`, `status`, `search`, `events`, and
   `context` all take `--json --budget N` to cap output (`show --context`
   too); use `slop context <ref>` to reload your bearings after
   compaction instead of re-exploring the repo from scratch.

## Reference resolution

Anywhere a `<ref>` is accepted: a full id (`ticket_01J9X7M3E8W2`), a unique
short prefix (`01J9X7`), a slug (`adding-new-auth-provider`), a short
`t-<code>` handle, and — for `--parent` only — an external ref
(`jira:PROJ-123`). An ambiguous prefix makes the CLI error and list every
candidate; pick explicitly. Full rules:
[CLI reference → ref resolution](cli-reference.md#ref-resolution).

## Edge cases

- **No `.slop/` in the repo:** slopwork isn't set up. Ask the human before
  running `slop init` — never initialize on your own.
- **Transcript warnings** on `stop`/`done`/`review`: report the warning to
  the human; never block or retry-loop on it — a missing transcript never
  blocks the underlying state change.
- **Draft tickets** (`state: draft`) are not workable — they're still
  being defined. Don't start them; ask if one looks like it should be
  yours.
- **`ready` returns nothing:** check `slop status` for blocked/stale items
  and report what's gating progress rather than inventing work.

## Why this loop, not something looser

Every step above writes an immutable [event](concepts.md#event) — this is
what lets a human run `slop status`/`slop show`/`slop web` and reconstruct
exactly what happened, when, and by whom, instead of trusting a chat
transcript or a commit message written after the fact. See
[Concepts](concepts.md) for the full data model this loop is built on, and
[Web UI](web-ui.md) for how a human audits it.
