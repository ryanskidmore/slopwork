/**
 * `slop ready` (design.md §2, §4.2; work item B4) — pure selection +
 * ordering over already-built `IndexTicketRow`s, plus a generic
 * `--budget` eliding helper. No I/O anywhere in this file: the CLI command
 * (`src/cli/commands/ready.ts`) loads the index and calls into this
 * module; everything below is synchronous and independently unit-tested
 * (`ready.test.ts`).
 *
 * ## The two groups this module produces
 *
 *  - **`ready`** — design.md §2's `ready` query, verbatim: "open ∧ no live
 *    blockers ∧ no active session. Drafts and review items never appear."
 *    Every row's own `ready` column (`db-index.ts`'s `computeReady`,
 *    filled in by `buildIndex`) already carries the per-ticket verdict;
 *    this module's job is filtering to `ready === true` (a `null` — a
 *    pre-B4 index that hasn't been rebuilt yet, see db-index.ts's "Known
 *    limitation" — is treated the same as `false`: "not known ready",
 *    never a crash) plus `--label`, then sorting ({@link
 *    compareReadyOrder}).
 *  - **`resumable`** — only computed when `--resumable` is passed (design.md
 *    §5: "surface work that can be picked back up"). Two cases, both
 *    included:
 *      1. `in_progress`/`review` tickets with NO active session — someone
 *         `stop`ped an in-progress ticket, or a review sat unclaimed, and
 *         nobody is currently working it.
 *      2. **C5**: a ticket whose session is still technically active but
 *         has gone *stale* (`now > stale_at`/`review_stale_at` — no
 *         activity, or no review action, past `stale_after`/
 *         `review_stale_after`) — an agent vanished mid-session, or a
 *         review sat unactioned so long the "active" session watching it
 *         is no longer meaningful. See {@link filterResumableRows}'s `now`
 *         parameter — the clock-injected read-time check, per
 *         `tickets/staleness.ts`'s `isStale`/`isReviewStale` (the row's
 *         `stale_at`/`review_stale_at` are the content-derived deadlines
 *         `db-index.ts`'s `buildIndex` already computed; this module only
 *         asks "has that deadline passed, right now").
 *    The two cases get distinct `ResumableReason`s (`*_no_session` vs.
 *    `*_stale`) so `resumableReasonText` can say which situation applies —
 *    "stopped, resumable" reads very differently from "active session
 *    gone stale."
 *
 * ## Ordering — this work item's acceptance criterion, verbatim: "ready
 * ordering = priority then age"
 *
 * See {@link compareReadyOrder} for the exact rule and its documented
 * tiebreak.
 */
import type { TicketState } from "../core/index.js";
import type { IndexTicketRow } from "../repo/db-index.js";
import { isReviewStale, isStale } from "./staleness.js";

export interface ReadyQueryOptions {
  /** Only rows carrying this exact label (design.md §4.2 `--label x`). */
  label?: string;
}

/**
 * design.md §8.1 item 4: priority 0 = urgent .. 3 = low — so *ascending*
 * priority is "most urgent first". Within a priority, older first ("age").
 *
 * **Age uses the ticket's own `id`, not a `created_at` column** —
 * `IndexTicketRow` has no `created_at` field (deliberately: see below), and
 * a ticket's id is a ULID minted exactly once, at creation, and never
 * touched again (`core/ids.ts`'s `newTicketId`). ULIDs sort chronologically
 * as plain strings — the same property `events.ts`'s cursor ordering
 * leans on — so ascending-id order IS ascending-creation-order, to the
 * millisecond. Because ids are globally unique by construction (A2's
 * shared monotonic ULID factory bumps on same-millisecond collisions
 * rather than colliding), this is ALSO a complete, gap-free tiebreak: two
 * tickets can never tie on `id` the way they could tie on a coarser
 * `created_at` (e.g. two tickets both created within one batch script).
 * This is this function's documented tiebreak, per the work item's brief
 * ("by created_at, or a documented tiebreak") — chosen deliberately over
 * adding a redundant `created_at` column to the index that would need its
 * own secondary tiebreak anyway, and over touching `IndexTicketRow`'s
 * schema at all for something already fully recoverable from `id`.
 */
export function compareReadyOrder(a: IndexTicketRow, b: IndexTicketRow): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function matchesLabel(row: IndexTicketRow, label: string | undefined): boolean {
  return label === undefined || row.labels.includes(label);
}

/** design.md §2's `ready` query — filter + sort. See module doc for the
 * `null`-is-treated-as-not-ready handling. */
export function filterReadyRows(
  rows: readonly IndexTicketRow[],
  options: ReadyQueryOptions = {},
): IndexTicketRow[] {
  return rows
    .filter((row) => row.ready === true && matchesLabel(row, options.label))
    .slice()
    .sort(compareReadyOrder);
}

export const RESUMABLE_REASONS = [
  "in_progress_no_session",
  "review_no_session",
  "in_progress_stale",
  "review_stale",
] as const;
export type ResumableReason = (typeof RESUMABLE_REASONS)[number];

export interface ResumableRow {
  row: IndexTicketRow;
  reason: ResumableReason;
}

function resumableReasonFor(state: TicketState, hasActiveSession: boolean): ResumableReason | null {
  if (state === "in_progress") return hasActiveSession ? "in_progress_stale" : "in_progress_no_session";
  if (state === "review") return hasActiveSession ? "review_stale" : "review_no_session";
  return null;
}

/**
 * A row is a resumable CANDIDATE if either: it has no active session at
 * all (stopped work), or it does have one but has gone stale (C5) — see
 * module doc, "resumable". `now` is the caller's injected clock's current
 * time (never a bare `Date.now()`/`new Date()` — see core/clock.ts).
 */
function isResumableCandidate(row: IndexTicketRow, now: Date): boolean {
  if (row.active_session === null) return true;
  return isStale(row, now) || isReviewStale(row, now);
}

/** See module doc, "resumable" — the two cases (`*_no_session` /
 * `*_stale`), and `now`, the clock-injected read-time boundary for the
 * staleness half (C5's acceptance criterion, "clock-injected tests"). */
export function filterResumableRows(
  rows: readonly IndexTicketRow[],
  now: Date,
  options: ReadyQueryOptions = {},
): ResumableRow[] {
  const matched: ResumableRow[] = [];
  for (const row of rows) {
    if (!isResumableCandidate(row, now)) continue;
    const reason = resumableReasonFor(row.state, row.active_session !== null);
    if (reason === null) continue;
    if (!matchesLabel(row, options.label)) continue;
    matched.push({ row, reason });
  }
  return matched.sort((a, b) => compareReadyOrder(a.row, b.row));
}

export function resumableReasonText(reason: ResumableReason): string {
  switch (reason) {
    case "in_progress_no_session":
      return "in_progress with no active session (stopped; resumable)";
    case "review_no_session":
      return "in review with no active session (resumable)";
    case "in_progress_stale":
      return "in_progress, active session gone stale (resumable)";
    case "review_stale":
      return "in review, active session gone stale — MR awaiting review (resumable)";
  }
}

/** Human/JSON "why" text for a strictly-`ready` row — design.md §2, verbatim intent. */
export const READY_WHY = "open, no live blockers, no active session";

export type ReadySection = "ready" | "resumable";

/** One row of `slop ready`'s combined output — carries everything `slop
 * start` needs next (id/slug/name/priority/labels live on `row`) plus
 * `why` this row is included, per this work item's brief. */
export interface ReadyEntry {
  section: ReadySection;
  row: IndexTicketRow;
  why: string;
}

/**
 * Combine `ready` + (if requested) `resumable` into ONE ordered list, in
 * *elision priority* order — most important first, least important last —
 * which is what `--budget` (see {@link renderReadyWithBudget}) elides from
 * the tail of. Every `ready` row sorts before every `resumable` row
 * (resumable work is secondary/optional by definition — picking up
 * someone else's stopped work, not claiming fresh work), each group
 * internally ordered by {@link compareReadyOrder}.
 */
export function buildReadyEntries(
  ready: readonly IndexTicketRow[],
  resumable: readonly ResumableRow[],
): ReadyEntry[] {
  return [
    ...ready.map((row): ReadyEntry => ({ section: "ready", row, why: READY_WHY })),
    ...resumable.map(
      ({ row, reason }): ReadyEntry => ({
        section: "resumable",
        row,
        why: resumableReasonText(reason),
      }),
    ),
  ];
}

export interface BudgetedReadyRender {
  text: string;
  elisions: string[];
  /** `true` iff `text.length <= budgetChars` — always `true` when
   * `budgetChars` is `undefined`, and (by construction) always `true` even
   * when a real budget forced elision all the way to zero entries. */
  withinBudget: boolean;
}

/**
 * Bound a rendering of `entries` to `budgetChars` characters — C1's unit
 * (`sessions/context-budget.ts`'s `CONTEXT_PACK_BUDGET_UNIT`; this work
 * item's brief: "Reconcile with C1's unit (characters)"). Reuses that
 * module's elision *philosophy* — drop the least important content first,
 * one step at a time, and say what was dropped — rather than its exact
 * function, which is specific to a single ticket's `ContextPackData`: a
 * `ready` response is a LIST of tickets, so what gets elided is whole list
 * entries, not prose within one. `entries` must already be in
 * elision-priority order (see {@link buildReadyEntries}) — least important
 * last.
 *
 * `render(kept, elisionNotes)` re-renders the FULL output (text or JSON —
 * this function is format-agnostic) for a candidate prefix of `entries`;
 * called repeatedly, dropping one more trailing entry each time, until the
 * result fits. Always genuinely respects `budgetChars` (never returns text
 * longer than requested, for any `budgetChars >= 0`) — the same guarantee
 * `renderContextPackWithBudget` documents, and for the same reason: the
 * final fallback is a raw slice of our own already-shortest rendering, not
 * a fixed-length note that could itself exceed a tiny budget.
 */
export function renderReadyWithBudget(
  entries: readonly ReadyEntry[],
  render: (kept: readonly ReadyEntry[], elisions: readonly string[]) => string,
  budgetChars?: number,
): BudgetedReadyRender {
  const full = render(entries, []);
  if (budgetChars === undefined || full.length <= budgetChars) {
    return { text: full, elisions: [], withinBudget: true };
  }

  for (let keep = entries.length - 1; keep >= 0; keep--) {
    const dropped = entries.length - keep;
    const notes = [
      `${dropped} lower-priority/less-relevant ticket(s) omitted to fit --budget (kept ${keep} of ${entries.length})`,
    ];
    const candidate = render(entries.slice(0, keep), notes);
    if (candidate.length <= budgetChars) {
      return { text: candidate, elisions: notes, withinBudget: true };
    }
  }

  // Even zero entries doesn't fit (a pathologically tiny budget, or fixed
  // wrapper text alone exceeds it) — raw-slice our own shortest rendering,
  // the same last-resort `renderContextPackWithBudget` takes and for the
  // same reason: a plain string slice can never itself exceed the budget.
  const finalNotes =
    entries.length > 0 ? [`all ${entries.length} ticket(s) omitted to fit --budget`] : [];
  const zero = render([], finalNotes);
  if (zero.length <= budgetChars) {
    return { text: zero, elisions: finalNotes, withinBudget: true };
  }
  const rawSlice = budgetChars <= 0 ? "" : zero.slice(0, budgetChars);
  return { text: rawSlice, elisions: finalNotes, withinBudget: rawSlice.length <= budgetChars };
}
