/**
 * Canonical agent-onboarding content (design.md §5.1) — the SINGLE source
 * for all three v0 onboarding surfaces (work item D1):
 *
 *   - `slop instructions` (src/cli/commands/instructions.ts) — prints this
 *     to stdout, with project-specific values interpolated.
 *   - `.slop/AGENTS.md` — written by `slop init`, committed to the repo
 *     (design.md §3: "committed — agent onboarding").
 *   - `.claude/skills/slopwork/SKILL.md` — installed by `slop init` only
 *     when a Claude Code setup is detected (src/cli/init/claude-detect.ts).
 *
 * `render.ts` turns the data below into the three documents (all three
 * call the same `renderOnboardingBody`, see that file). Never hand-edit
 * onboarding wording in three places — change it here, once. The D1
 * acceptance test (tests/acceptance/D1.test.ts) and the unit tests in
 * `render.test.ts` both fail loudly if any of the three stops reflecting
 * this module.
 *
 * Base structure, section order, and voice: the pre-v0 skill design draft
 * (superseded, see git history) — the "SKILL.md draft already written"
 * this work item was handed. A few claims were corrected against the
 * shipped CLI; each fix is called out at its own entry below rather than
 * silently, since D1's brief is explicit that a wrong onboarding doc is
 * worse than none.
 */

export const SKILL_NAME = "slopwork";

/**
 * SKILL.md frontmatter `description` — this exact text is how Claude Code
 * decides when to load the skill (the pre-v0 draft's own frontmatter,
 * unchanged: the trigger conditions it lists are still accurate against
 * the shipped CLI, nothing here needed correcting).
 */
export const SKILL_DESCRIPTION =
  'Work tracker for agents. Use whenever (a) the repo contains a .slop/ directory, (b) you are asked to work on a ticket, feature, or "the next thing" — including refs like ticket_01J9X7…, a slug like adding-new-auth-provider, or jira:PROJ-123, (c) you are about to start any non-trivial coding task, (d) you discover new work mid-task (bug, todo, follow-up), or (e) you are finishing, blocked, or handing off. Slopwork is the single source of truth for what to do, what\'s in progress, and what happened — never keep work state in markdown files or your own memory.';

export interface WhenToActRow {
  situation: string;
  action: string;
}

/** "When to act, at a glance" table (the pre-v0 draft's own table, one row corrected — see the `--blocks` note). */
export const WHEN_TO_ACT: readonly WhenToActRow[] = [
  {
    situation: 'Told "work on X" (id, slug, or jira ref)',
    action:
      "`slop show X --context` → if it has open subtickets, pick/start the right one; else `slop start X`",
  },
  {
    situation: 'Told "pick up the next thing"',
    action: "`slop ready --json --budget 3000` → `slop start <top item>`",
  },
  {
    situation: "About to start non-trivial work that has no ticket",
    action: '`slop new "…"` first (ask the human if unsure it\'s wanted), then `start` it',
  },
  {
    situation: "Discover a bug/follow-up mid-task",
    action:
      '`slop new "…" --discovered-from <current>` — never a TODO comment, never "I\'ll mention it later"',
  },
  {
    situation: "Blocked by missing work",
    // FIX against the shipped CLI: the draft read `slop update <current>
    // --state open`, link with `--blocks` — but `update` has no `--blocks`
    // flag (only `new` does; compare src/cli/commands/update.ts and
    // new.ts). The blocker ticket carries the edge at creation time
    // instead: `new --blocks <ref>` marks the ticket being created as
    // blocking `<ref>`, which is exactly the relationship wanted here.
    action:
      '`slop new "<what\'s missing>" --blocks <current>` to file the blocker (it blocks this ticket), tell the human',
  },
  {
    situation: "Need a human decision",
    action:
      'Put the question + options in `slop update <ref> --progress "QUESTION: …"`, then stop or continue on the unblocked parts',
  },
  {
    situation: "Code done, MR opened",
    action: "`slop review <ref> --mr <url>`",
  },
  {
    situation: "MR merged / work verified",
    action: '`slop done <ref> --note "…"`',
  },
  {
    situation: "Stopping without finishing",
    action: '`slop stop <ref> --note "<handoff: state, next step, gotchas>"`',
  },
  {
    situation: 'Asked "what\'s the status?"',
    action: "`slop status`, summarize; don't recite raw output",
  },
] as const;

/** "The loop" — the default per-ticket sequence (the pre-v0 draft, unchanged: every command/flag named here exists on the shipped CLI). */
export const LOOP_STEPS: readonly string[] = [
  "`slop start <ref>` — moves the ticket to in_progress, creates your session, and prints the context pack (spec, ancestry, blockers, prior sessions). Read it fully before coding.",
  '`slop plan <ref> "step 1" "step 2" …` — always plan before multi-step work. Revise the plan if the approach changes; don\'t silently diverge from it.',
  'Work. At each meaningful checkpoint (step done, decision made, surprise found): `slop plan <ref> --check N` and `slop update <ref> --progress "one-line note"`. Checkpoint-level, not keystroke-level.',
  'File everything you discover: `slop new "…" --discovered-from <ref>`.',
  "Open an MR, then `slop review <ref> --mr <url>`. Only `slop done` after merge/verification — done means done.",
] as const;

/** House rules (the pre-v0 draft, one entry corrected — see the `--budget`/`--json` note). */
export const HOUSE_RULES: readonly string[] = [
  "**The tracker is the truth.** No TODO comments, no NOTES.md, no work state in prose. If it's work, it's a ticket.",
  "**Never fake state.** Don't `done` unverified work, don't `--check` unfinished steps, don't skip `review` because the change \"is small.\"",
  "**Don't takeover.** If `start` warns that another session is active, stop and tell the human. Use `--takeover` only when explicitly instructed.",
  "**Stopping requires a handoff note.** The next session (probably another amnesiac you) starts from your `--note`. Write what you'd want to read: current state, next step, traps.",
  "**Prefer structured spec fields.** When creating or updating tickets, put acceptance criteria in `acceptance[]` and file/URL pointers in `context[]`, not buried in prose — use `new`/`update`'s own `--acceptance`/`--context`/`--summary`/`--details` flags (repeatable, plain text) rather than hand-assembling `--spec <json>`; it sidesteps shell-quoting hazards and the unknown-key/malformed-JSON errors `--spec` now raises.",
  // Originally FIXED against the shipped CLI (the draft read "Use `--json
  // --budget N` on `ready`/`show`", back when `show` had neither flag —
  // only `ready` did). E1 then genuinely landed `--json`/`--budget`
  // across every read command (`ready`, `status`, `search`, `events`,
  // `context`, and `show --context`), so the rule is updated again here to
  // match the NOW-shipped CLI, not reverted to the original draft's wrong
  // claim — see src/cli/commands/*.ts's own `--budget`/`--json` help text
  // for the authoritative per-command shape (`show`'s plain-ticket output
  // has a documented floor: `--budget` only bounds its `--context` output).
  "**Budget your reads.** `ready`, `status`, `search`, `events`, and `context` all take `--json --budget N` to cap output (`show --context` too); use `slop context <ref>` to re-load your bearings after compaction instead of re-exploring the repo.",
] as const;

/** Reference resolution rule (the pre-v0 draft, unchanged). */
export const REF_RESOLUTION =
  "Anywhere a `<ref>` is accepted: full id (`ticket_01J9X7M3E8W2`), unique short prefix (`01J9X7`), slug (`adding-new-auth-provider`), and for parents also external refs (`jira:PROJ-123`). Ambiguous prefix → the CLI errors and lists candidates; pick explicitly.";

/** Edge cases (the pre-v0 draft, unchanged). */
export const EDGE_CASES: readonly string[] = [
  "**No `.slop/` in the repo:** slopwork isn't set up. Ask the human before running `slop init` — never initialize on your own.",
  "**Transcript warnings** on `stop`/`done`: report the warning to the human; never block or retry-loop on it.",
  "**Draft tickets** (`state: draft`) are not workable — they're being defined. Don't start them; ask if one looks like it should be yours.",
  "**`ready` returns nothing:** check `slop status` for blocked/stale items and report what's gating progress rather than inventing work.",
] as const;
