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
import type { RenderFormat, TicketState } from "../core/index.js";
import { renderEntriesWithBudget } from "../core/index.js";
import type { IndexTicketRow } from "../repo/db-index.js";
import { isReviewStale, isStale } from "./staleness.js";

/**
 * t-175oq: `ready`'s filter set, widened from a single `--label` to
 * `--label` (repeatable, AND — every given label must be present, matching
 * `slop list`'s own `--label` semantics, `tickets/list.ts`), plus `--owner`
 * and `--priority`, so multiple actors/queues can scope their own pull
 * request without a separate `slop list --state open` roundtrip. All three
 * are optional and compose with AND: a row must satisfy every filter given
 * to be kept. Preserves `ready`'s existing ordering
 * ({@link compareReadyOrder}) and `--resumable` semantics untouched — this
 * is purely an additional filter stage before that ordering runs.
 */
export interface ReadyQueryOptions {
  /** Every label here must be present on the row (AND, not OR) — `[]`/`undefined` means no label filter. */
  labels?: readonly string[];
  /** Only rows owned by an actor with exactly this name (matches `slop list --owner`/the web UI's owner filter — name only, `kind` ignored, same as `sessionOwnershipWarning`'s identity axis). `IndexTicketRow.owner` (added alongside this ticket) carries the row's owner, so this needs no extra ticket read. */
  owner?: string;
  /** Only rows at exactly this priority (0..3). */
  priority?: number;
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

/** t-175oq: AND semantics — every one of `labels` must be present on `row.labels`; `[]`/`undefined` never filters anything out. */
function matchesLabels(row: IndexTicketRow, labels: readonly string[] | undefined): boolean {
  return labels === undefined || labels.every((label) => row.labels.includes(label));
}

/** Name-only comparison, matching `slop list --owner`/the web UI's owner filter and `sessionOwnershipWarning`'s identity axis — `kind` is never part of the match. */
function matchesOwner(row: IndexTicketRow, owner: string | undefined): boolean {
  return owner === undefined || row.owner?.name === owner;
}

function matchesPriority(row: IndexTicketRow, priority: number | undefined): boolean {
  return priority === undefined || row.priority === priority;
}

function matchesReadyOptions(row: IndexTicketRow, options: ReadyQueryOptions): boolean {
  return (
    matchesLabels(row, options.labels) &&
    matchesOwner(row, options.owner) &&
    matchesPriority(row, options.priority)
  );
}

/** design.md §2's `ready` query — filter + sort. See module doc for the
 * `null`-is-treated-as-not-ready handling. */
export function filterReadyRows(
  rows: readonly IndexTicketRow[],
  options: ReadyQueryOptions = {},
): IndexTicketRow[] {
  return rows
    .filter((row) => row.ready === true && matchesReadyOptions(row, options))
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
  if (state === "in_progress")
    return hasActiveSession ? "in_progress_stale" : "in_progress_no_session";
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
    if (!matchesReadyOptions(row, options)) continue;
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
 * item's brief: "Reconcile with C1's unit (characters)"). `entries` must
 * already be in elision-priority order (see {@link buildReadyEntries}) —
 * least important last. `render(kept, elisionNotes)` re-renders the FULL
 * output (text or JSON — this function is format-agnostic) for a candidate
 * prefix of `entries`.
 *
 * A thin, ready-flavored wrapper over `core/budget.ts`'s
 * {@link renderEntriesWithBudget} — E1's generalisation of this exact
 * mechanism across every command that pairs `--json` with `--budget`
 * (`search`, `events`, `status`, this one). **`format` matters**: for
 * `"json"`, the fallback when even zero entries doesn't fit is the
 * already-valid empty-list envelope returned AS-IS, never a raw slice of
 * it — B4 adversarial review found `ready --json --budget <tiny>` used to
 * emit invalid, truncated-mid-structure JSON on exit 0 via exactly that
 * raw-slice fallback; see `core/budget.ts`'s module doc for the full
 * writeup. `format` defaults to `"text"` (a raw slice is always safe for
 * plain text) for any caller that hasn't been updated to pass it.
 */
export function renderReadyWithBudget(
  entries: readonly ReadyEntry[],
  render: (kept: readonly ReadyEntry[], elisions: readonly string[]) => string,
  budgetChars?: number,
  format: RenderFormat = "text",
): BudgetedReadyRender {
  return renderEntriesWithBudget(entries, render, budgetChars, { format, noun: "ticket" });
}
