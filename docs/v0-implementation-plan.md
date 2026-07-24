# Slopwork v0 — Implementation Plan

> **Historical document.** The implementation plan v0 was actually built from, preserved as
> written. Its work-item ids (A1…E4) are load-bearing: each `tests/acceptance/<ID>.test.ts` file
> is named after one and quotes its acceptance criterion verbatim. The companion spec is
> [`design.md`](design.md); the maintained user docs start at [`README.md`](README.md).

**July 17, 2026 · companion to Spec v0.6 · target: ~2.5 weeks with you + 2 agents**

> **Next action:** run the three spikes (S1–S3, §2) — ~half a day total, they de-risk everything downstream. Then A1.

**Plan in four lines:**

1. Three half-day **spikes** kill the unknowns (harness env vars, transcript paths, JSONC library).
2. A short serial **foundation** (A1–A4, ~2.5 days) unlocks three **parallel lanes** — tickets (B), working loop (C), read surfaces (D) — sized for you + 2 agents.
3. Four **milestones** (M1–M4), each ending in something you can run. The dogfood flip happens at M2, not the end.
4. Critical path: **A → B1 → B3 → B4 → C3 → E2 → E3** (~9 working days). Everything else hangs off it in parallel.

---

## 1. The dependency graph

```
S1 S2 S3 (spikes, parallel, day 0)
    │
    A1 ── A2 ── A3 ── A4          FOUNDATION (serial, ~2.5d)
                 │
   ┌─────────────┼──────────────────┐
   ▼             ▼                  ▼
LANE B        LANE C             LANE D
tickets       working loop       read surfaces
B1→B2         C1 (needs B1)      D1 init+instructions (needs A3)
B1→B3→B4      C2 (needs C1)      D2 search (needs B1)
              C3 (needs C1+B4)   D3 events cmd (needs A4)
              C4 (needs C1,S1,S2) D4 status (needs C1; C5 for stale)
              C5 (needs C1)      D5 web (needs A3; final wiring needs C3/C4)
   └─────────────┼──────────────────┘
                 ▼
E1 polish → E2 concurrency+merge tests → E3 dogfood flip → E4 dogfood week (§4.7 bar)
```

---

## 2. Spikes (day 0 — do these first, ~half day total)

| # | Spike | Question to answer | Time | Output |
|---|---|---|---|---|
| S1 | Harness sniffing | Which env vars do Claude Code / opencode / Codex actually set in a session? | ~1.5h (run each, dump env) | A detection table for C4/C1 |
| S2 | Transcript locations | Exact on-disk transcript path pattern per harness; is the "current session" identifiable while running? | ~1.5h | Locator functions' spec for C4 |
| S3 | JSONC library | `jsonc-parser` edit API: can we preserve human comments through programmatic writes? Fallback: comments read-tolerated, writes canonical | ~1h | The serialization decision for A2 |

*Spikes are throwaway scripts, not code to keep. If S1/S2 come up empty for a harness, `--harness` + `--transcript <path>` manual flags are the documented fallback — don't let a weird harness block the plan.*

---

## 3. Work items

Estimates assume an agent does the typing and you review. **Bold** = critical path. `⛓ = depends on`.

### Foundation (serial — one agent, you reviewing closely; this is the code everything sits on)

| # | Item | ⛓ | Est | Acceptance |
|---|---|---|---|---|
| **A1** | Repo scaffold: TS + Bun build, commander skeleton, vitest, lint/format, CI | — | 0.5d | `slop --help` runs from a compiled binary; tests run in CI |
| **A2** | Core types + serialization: entity schemas (zod), spec JSON (D10), ULID gen with prefixes, JSONC read/write per S3 | A1 | 0.5d | Round-trip property test: parse(write(x)) = x, comments survive per S3 decision |
| **A3** | Flatfile repo layer: atomic write (tmp+rename), `.lock` for multi-file txns, entity CRUD, ref resolution (full id / short prefix / slug), index build + auto-heal + `reindex` | A2 | 1d | Kill -9 mid-write leaves no corrupt files; ambiguous prefix errors git-style; deleted index self-heals |
| **A4** | Event writer: emit-on-mutation hook in the repo layer, event files, ULID cursor ordering | A3 | 0.5d | Every repo mutation in tests produces exactly one ordered event |

**Milestone M1 (day ~3): the engine exists.** Entities round-trip, index rebuilds, events flow. Nothing user-facing yet — this is the only milestone without a demo.

### Lane B — tickets & graph (agent 1)

| # | Item | ⛓ | Est | Acceptance |
|---|---|---|---|---|
| **B1** | `new` / `show` / `edit` / `update`: spec parsing (bare markdown → `details_md`), slugs (+collision suffix), drafts, adhoc, external `jira:` parents, priority, labels | A3 | 1.5d | All §4.2 creation flags work; slug + prefix resolution; `jira:` parent renders in `show` |
| B2 | `split` + `draft`/`undraft` sugar + provenance stamps | B1 | 0.5d | Split children carry parent + `discovered-from` correctly |
| **B3** | Edges: `blocks`/`relates-to`/`discovered-from`, write-time cycle check (bounded BFS), degree caps | B1 | 1d | Cycle rejected with clear error; cap rejected at 500; property test on random DAGs |
| **B4** | Derivations: `blocked_count` in index, `ready` query (+`--resumable`, `--budget`, `--json`), done-cascade (decrement + emit `ticket.ready`) | B3 | 1d | Cascade test: close 1, verify N flip + events; ready ordering = priority then age |

### Lane C — the working loop (agent 2; starts when B1 lands, ~day 4)

| # | Item | ⛓ | Est | Acceptance |
|---|---|---|---|---|
| **C1** | Sessions: `start` (session entity, actor D17, harness sniff S1, git branch/commit, takeover warn), `stop`, `context` | B1, S1 | 1d | Two concurrent `start`s: second warns; `--takeover` logs event; context pack under budget |
| C2 | Plans: `plan` set/revise (versioned), `--check/--uncheck` | C1 | 0.5d | Plan v2 diffable from v1; step status in `show` |
| **C3** | Lifecycle: `review --mr` (D15), `done` (finalize session + cascade via B4), `drop`, re-`start` from review | C1, B4 | 1d | State machine property test: only legal transitions; review without `--mr` nags |
| C4 | Transcript capture: per-harness locators (S2), copy on every session end, `transcript_ref`, `--transcript` fallback, gitignore handling (D16) | C1, S2 | 1d | End a real Claude Code session → transcript lands in `.slop/transcripts/`; missing transcript warns, never blocks |
| C5 | Staleness: `stale_after` / `review_stale_after` computed in index; feeds `ready --resumable` | C1 | 0.5d | Clock-injected tests; stale review ticket surfaces with MR link |

### Lane D — read surfaces (agent 3 / you between reviews)

| # | Item | ⛓ | Est | Acceptance |
|---|---|---|---|---|
| D1 | `init` (dirs, config.yaml with repo autodetect + jira prompt, gitignore entries) + agent onboarding: `instructions`, `.slop/AGENTS.md`, and **SKILL.md** installed to `.claude/skills/slopwork/` when a Claude Code setup is detected (all three generated from one source; SKILL.md draft already written — see deliverable `slopwork-SKILL.md`) | A3 | 1d | Fresh repo → `init` → a real agent follows the skill unaided through one full ready→start→plan→review→done loop |
| D2 | `search`: scan names/specs/notes, ranked-ish output | B1 | 0.5d | Finds text in `details_md` and progress notes |
| D3 | `events` command: `--since`, `--ticket`, `--json` | A4 | 0.5d | Cursor pagination stable across reindex |
| D4 | `status`: counts by state, in-progress w/ sessions+age, stale, awaiting review w/ MR links | C1 (full value after C5) | 0.5d | One screen, < 1s on 1k tickets |
| D5 | `slop web`: local server + SPA — list/filters, tree (jira badges), detail (spec/timeline/sessions/plans), transcript viewer, review panel, stale panel | A3 (shapes); final wiring C3, C4 | 3d | All §4.4 views against a seeded fixture db; transcript JSONL renders readably |

*D5 note: start against fixture data immediately after A3 so the SPA doesn't wait on lanes B/C — wire real data last. It's the biggest parallel win in the plan.*

**Milestone M2 (day ~7): the dogfood flip.** B1–B4 + C1–C3 + D1 landed → `init`, file the remaining plan items as real tickets (E3 starts early), and from here on **all remaining v0 work is tracked in Slopwork itself**.

### Integration & hardening (whoever's free; E2 pairs well with you personally)

| # | Item | ⛓ | Est | Acceptance |
|---|---|---|---|---|
| E1 | Polish: `--json`/`--budget` everywhere, exit codes, error copy, `--tree`, help text | B*, C* | 1d | An agent can branch on exit codes; every read respects budget |
| **E2** | Concurrency + merge hardening: parallel-start races, lock contention, and the **merge simulation**: two clones diverge (create/edit/close on both), merge, `reindex`, verify graph integrity | C3, B4 | 1d | Scripted git merge of divergent `.slop/db` → zero manual conflicts except same-ticket edits; index rebuilds clean |
| **E3** | Seed the real backlog: every remaining item + known F-menu candidates filed as tickets with edges | M2 | 0.5d | `slop ready` drives the rest of the project |
| E4 | **Dogfood week**: build F-menu candidates or fixes purely through the tool; keep a friction log as `discovered-from` tickets | E3 | 5d (calendar) | §4.7 bar: all five conditions hold for one full week |

**Milestone M3 (day ~10): v0 feature-complete.** All commands + web work; hardening done.
**Milestone M4 (day ~12 + dogfood week): v0 done** per the §4.7 bar. Friction log = the post-v0 roadmap.

---

## 4. Who does what (you + 2 agents)

| Stream | Assignee | Why |
|---|---|---|
| Foundation A1–A4, then Lane B | **Agent 1** (your strongest harness), with close human review on A3 | The repo layer is the one piece where a subtle bug (partial writes, lock races) poisons everything above it |
| Lane C | **Agent 2**, starting at B1-landed (~day 4); C4 needs S1/S2 results in its context | State machine is well-specified = good agent work; transcript locators are fiddly — expect one revision round |
| Lane D | **Agent 3 or you between reviews**; D5 kicked off early against fixtures | Web SPA is self-contained, visually verifiable, low blast-radius — ideal third stream |
| Spikes S1–S3, reviews, E2 | **You** | S1/S2 need your real harness setups; E2 (merge semantics) is judgment-heavy |

Sequencing rule: **nothing merges to main without its acceptance test**, and lanes rebase daily — the flatfile layer's whole merge story gets exercised by the plan itself.

## 5. Day-by-day sketch (working days)

| Day | Critical path | Parallel |
|---|---|---|
| 0 | S1–S3 spikes | — |
| 1–2.5 | A1→A4 | D5 SPA skeleton on fixtures (after A3) |
| 3–4.5 | B1→B2 | D1 init/instructions; D5 continues |
| 4–6 | B3→B4 | C1→C2 (from day 4); D2/D3 |
| 6–7 | C3 → **M2 dogfood flip + E3 seed** | C4, C5, D4 |
| 8–9 | E1 polish | D5 real-data wiring |
| 9–10 | E2 hardening → **M3** | — |
| 11+ | E4 dogfood week → **M4** | friction-log tickets |

Slack built in: estimates sum to ~13.5 agent-days across ~10 calendar days with 2–3 workers — roughly 30% buffer for review rounds and the inevitable S2 surprise.

## 6. Risks in this plan (3)

1. **A3 is the keystone** — if atomic-write/lock/reindex is flaky, every lane wobbles. Mitigation: property tests + kill-tests in its acceptance, land it before lanes fan out, you review it line-by-line.
2. **Transcript capture (C4) is the least specifiable item** — harness internals are undocumented and shift. Mitigation: S2 first; manual `--transcript` fallback is a documented, acceptable v0 answer for any harness that resists.
3. **D5 scope creep** — web UIs eat time. Mitigation: fixture-first build, read-only hard line, and the §4.4 view list is closed — anything else is F9.

---

*Working through this plan: file A1–E4 as the first tickets the moment M2 lands (E3 does it formally — earlier if you like the recursion). The plan is designed to be eaten by its own product.*
