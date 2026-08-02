# Slopwork

Project: **slopwork**

Slopwork (`slop`) tracks work as a dependency graph of tickets. You read it to know what to do, you write to it as you work, and humans audit your trail (sessions, plans, progress, MRs). Run `slop instructions` anytime for this project's local copy of these rules.

## When to act, at a glance

| Situation | Do this |
|---|---|
| Told "work on X" (id, slug, or jira ref) | `slop show X --context` → if it has open subtickets, pick/start the right one; else `slop start X` |
| Told "pick up the next thing" | `slop ready --json --budget 3000` (actionable leaves only) → `slop start <top item>` |
| About to start non-trivial work that has no ticket | `slop new "…"` first (ask the human if unsure it's wanted), then `start` it |
| Discover a bug/follow-up mid-task | `slop new "…" --discovered-from <current>` — never a TODO comment, never "I'll mention it later" |
| Blocked by missing work | `slop new "<what's missing>" --blocks <current>` to file the blocker (it blocks this ticket), tell the human |
| Need a human decision | Put the question + options in `slop update <ref> --progress "QUESTION: …"`, then stop or continue on the unblocked parts |
| Code done, MR opened | `slop review <ref> --mr <url>` |
| MR merged / work verified | `slop done <ref> --note "…"` |
| Stopping without finishing | `slop stop <ref> --note "<handoff: state, next step, gotchas>"` |
| Asked "what's the status?" | `slop status`, summarize; don't recite raw output |

## The loop (default for every ticket)

1. `slop start <ref>` — moves the ticket to in_progress, creates your session, and prints the context pack (spec, ancestry, blockers, prior sessions). Read it fully before coding.
2. `slop plan <ref> "step 1" "step 2" …` — always plan before multi-step work. Revise the plan if the approach changes; don't silently diverge from it.
3. Work. At each meaningful checkpoint (step done, decision made, surprise found): `slop plan <ref> --check N` and `slop update <ref> --progress "one-line note"`. Checkpoint-level, not keystroke-level.
4. File everything you discover: `slop new "…" --discovered-from <ref>`.
5. Open an MR, then `slop review <ref> --mr <url>`. Only `slop done` after merge/verification — done means done.

## Rules

1. **The tracker is the truth.** No TODO comments, no NOTES.md, no work state in prose. If it's work, it's a ticket.
2. **Never fake state.** Don't `done` unverified work, don't `--check` unfinished steps, don't skip `review` because the change "is small."
3. **Don't takeover.** If `start` warns that another session is active, stop and tell the human. Use `--takeover` only when explicitly instructed.
4. **Stopping requires a handoff note.** The next session (probably another amnesiac you) starts from your `--note`. Write what you'd want to read: current state, next step, traps.
5. **Prefer structured spec fields.** When creating or updating tickets, put acceptance criteria in `acceptance[]` and file/URL pointers in `context[]`, not buried in prose — use `new`/`update`'s own `--acceptance`/`--context`/`--summary`/`--details` flags (repeatable, plain text) rather than hand-assembling `--spec <json>`; it sidesteps shell-quoting hazards and the unknown-key/malformed-JSON errors `--spec` now raises.
6. **Budget your reads.** `ready`, `status`, `search`, `events`, and `context` all take `--json --budget N` to cap output (`show --context` too); use `slop context <ref>` to re-load your bearings after compaction instead of re-exploring the repo.

## Reference resolution

Anywhere a `<ref>` is accepted: full id (`ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1`), unique short prefix (`01KY9R`), short `t-<code>` handle (`t-wi5fe`), slug (`adding-new-auth-provider`), and for parents also external refs (`jira:PROJ-123`). Ambiguous prefix or handle → the CLI errors and lists candidates; pick explicitly.

## Edge cases

- **No `.slop/` in the repo:** slopwork isn't set up. Ask the human before running `slop init` — never initialize on your own.
- **Draft tickets** (`state: draft`) are not workable — they're being defined. Don't start them; ask if one looks like it should be yours.
- **`ready` returns nothing:** check `slop status` for blocked/stale items and report what's gating progress rather than inventing work.
