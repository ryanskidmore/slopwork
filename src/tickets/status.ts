/**
 * `slop status` (design.md §4.2: "project pulse: counts by state,
 * in-progress w/ sessions, stale, awaiting review (with MR links)");
 * work item D4 — pure aggregation/sorting/formatting-support logic, no
 * file I/O. `src/cli/commands/status.ts` gathers the data (the index, plus
 * a session-per-in-progress-ticket and a ticket-read-per-review-ticket —
 * see that file's module doc for why those two are the only per-entity
 * reads this command ever performs) and calls into this module, mirroring
 * the split between `src/tickets/search.ts` (pure) and
 * `src/cli/commands/search.ts` (I/O + rendering).
 *
 * `StatusTicketRow` is deliberately NOT `repo/db-index.ts`'s
 * `IndexTicketRow` — same reasoning as `tickets/search.ts`'s
 * `RankableTicket`: this module stays a pure function of plain data,
 * independent of the repo layer's zod-branded types, so it's trivial to
 * unit test with hand-built literals and can't be broken by an unrelated
 * change to the index's on-disk shape. The CLI layer maps
 * `IndexTicketRow` -> `StatusTicketRow` field-for-field.
 *
 * ## Reading B4/C5's derived fields generically
 *
 * `blockedCount`/`stale`/`reviewStale` are `<T> | null` — `null` means
 * "not computed yet" (B4/C5 haven't landed), a real value means it has.
 * {@link aggregateDerivedCounts} treats "every row's field is still null"
 * as the whole signal being unknown (`null` in the result — rendered as
 * "—", never `0`, so a human/agent can tell "nothing is blocked" apart
 * from "this repo doesn't know yet"), and otherwise counts normally. This
 * is the mechanism that makes `status` "read generically": nothing here
 * assumes B4/C5 are absent, so the moment a real index row shows up with
 * non-null fields, the counts and the stale section start rendering real
 * data with no code change required here.
 *
 * **Assumption this module is built against** (documented for C5, which
 * owns actually computing these fields): `stale` applies to `in_progress`
 * rows (checked against `config.defaults.stale_after`) and `reviewStale`
 * applies to `review` rows (checked against
 * `config.defaults.review_stale_after`) — matching the two distinct
 * fields db-index.ts's schema already carries and design.md §2's "stale
 * (in_progress *or review* ...)" overlay, split by state. A row's
 * "other" field (e.g. `reviewStale` on an `in_progress` row) is never
 * read. See DECISIONS.md's D4 entry for the full rationale.
 */
import type { TicketState } from "../core/index.js";
import { TICKET_STATES } from "../core/index.js";

/** The minimal per-ticket shape this module needs — see the module doc
 * for why this isn't `repo/db-index.ts`'s `IndexTicketRow` directly. */
export interface StatusTicketRow {
  id: string;
  slug: string;
  name: string;
  state: TicketState;
  /** B4's derived overlay (index.jsonc's `blocked_count`). `null` until B4 populates it. */
  blockedCount: number | null;
  /** C5's derived overlay for `in_progress` rows (index.jsonc's `stale`). `null` until C5 populates it. */
  stale: boolean | null;
  /** C5's derived overlay for `review` rows (index.jsonc's `review_stale`). `null` until C5 populates it. */
  reviewStale: boolean | null;
}

// ---------------------------------------------------------------------------
// Counts by state
// ---------------------------------------------------------------------------

export type StateCounts = Record<TicketState, number> & { total: number };

/** Counts by state (design.md §4.1's six stored states), plus a total.
 * Every state is always present in the result, even at zero — a fresh
 * repo or a repo with no tickets in some state should still show that
 * state's row rather than omitting it. */
export function aggregateStateCounts(rows: readonly StatusTicketRow[]): StateCounts {
  const counts = Object.fromEntries(TICKET_STATES.map((state) => [state, 0])) as Record<
    TicketState,
    number
  >;
  for (const row of rows) {
    counts[row.state] += 1;
  }
  return { ...counts, total: rows.length };
}

// ---------------------------------------------------------------------------
// Derived overlays: blocked / stale counts
// ---------------------------------------------------------------------------

export interface DerivedOverlayCounts {
  /** Tickets with a live `blocked_count` > 0. `null` when B4 hasn't populated the index yet (every row's `blockedCount` is still null). */
  blocked: number | null;
  /** Tickets currently stale (in_progress via `stale`, review via `reviewStale`). `null` when C5 hasn't populated the index yet. */
  stale: number | null;
}

export function aggregateDerivedCounts(rows: readonly StatusTicketRow[]): DerivedOverlayCounts {
  const blockedKnown = rows.some((row) => row.blockedCount !== null);
  const blocked = blockedKnown ? rows.filter((row) => (row.blockedCount ?? 0) > 0).length : null;

  const staleKnown = rows.some((row) => row.stale !== null || row.reviewStale !== null);
  const stale = staleKnown ? staleTicketRows(rows).length : null;

  return { blocked, stale };
}

// ---------------------------------------------------------------------------
// Stale section
// ---------------------------------------------------------------------------

export interface StaleTicketRow {
  id: string;
  slug: string;
  name: string;
  state: "in_progress" | "review";
}

/** in_progress-or-review tickets flagged stale by C5 — see the module
 * doc's "Assumption" for which field applies to which state. Never
 * throws/degrades specially for the pre-C5 case: every row's `stale`/
 * `reviewStale` being `null` just means nothing matches the `=== true`
 * checks below, so this naturally returns `[]` — the caller distinguishes
 * "known empty" from "not computed yet" via {@link aggregateDerivedCounts}'s
 * `stale` field, not via this array. */
export function staleTicketRows(rows: readonly StatusTicketRow[]): StaleTicketRow[] {
  const out: StaleTicketRow[] = [];
  for (const row of rows) {
    if (row.state === "in_progress" && row.stale === true) {
      out.push({ id: row.id, slug: row.slug, name: row.name, state: "in_progress" });
    } else if (row.state === "review" && row.reviewStale === true) {
      out.push({ id: row.id, slug: row.slug, name: row.name, state: "review" });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Age humanising
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Milliseconds since an ISO timestamp, floored at 0 (a clock-skewed or
 * future timestamp never goes negative here). */
export function msSince(iso: string, nowMs: number): number {
  return Math.max(0, nowMs - Date.parse(iso));
}

/** "<1m", "3m", "2h", "4d" — single coarsest-unit, for a scannable pulse
 * view (not the compound "1h 30m" style — that's a different module's
 * call for a different UI; this one stays to the single-unit style
 * design.md/this work item's brief actually shows). */
export function humanizeAge(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < MINUTE_MS) return "<1m";
  if (clamped < HOUR_MS) return `${Math.floor(clamped / MINUTE_MS)}m`;
  if (clamped < DAY_MS) return `${Math.floor(clamped / HOUR_MS)}h`;
  return `${Math.floor(clamped / DAY_MS)}d`;
}

// ---------------------------------------------------------------------------
// In-progress section
// ---------------------------------------------------------------------------

export interface InProgressSessionInfo {
  id: string;
  actor: string;
  /** `session.harness.kind` — kept as a plain string (rather than importing `HarnessKind`) for the same core-independence reasons as the rest of this module. */
  harness: string;
  startedAt: string;
  ageMs: number;
}

export interface InProgressTicketRow {
  id: string;
  slug: string;
  name: string;
  priority: number;
  /** `null` when the ticket's `active_session` is unset, or its session file couldn't be read — the ticket still renders, just without session detail (never crashes the whole command over one bad session file). */
  session: InProgressSessionInfo | null;
}

/**
 * Sort in-progress tickets oldest-session-first — the longest-running
 * session is the most worrying one for a human doing a daily pulse check
 * (most likely to be stuck, forgotten, or quietly blocked), so it belongs
 * at the top rather than the bottom of a "one screen" view. Tickets whose
 * session info couldn't be determined (`session: null`) sort last: their
 * age is literally unknown, so they can't be ranked by it, but they still
 * appear at all rather than being silently dropped from the section.
 */
export function sortInProgressRows(rows: readonly InProgressTicketRow[]): InProgressTicketRow[] {
  return [...rows].sort((a, b) => {
    const ageA = a.session?.ageMs ?? -1;
    const ageB = b.session?.ageMs ?? -1;
    if (ageA !== ageB) return ageB - ageA;
    return a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------
// Awaiting-review section
// ---------------------------------------------------------------------------

export interface ReviewTicketRow {
  id: string;
  slug: string;
  name: string;
  /** `ticket.review.mr` — optional even within `review` state (D15: "review --mr required-with-warning"). */
  mr: string | null;
  requestedAt: string;
  by: string;
  ageMs: number;
}

/** Longest-waiting-first — the MR that's been sitting the longest is the
 * one most worth a human's attention. */
export function sortReviewRows(rows: readonly ReviewTicketRow[]): ReviewTicketRow[] {
  return [...rows].sort((a, b) => {
    if (a.ageMs !== b.ageMs) return b.ageMs - a.ageMs;
    return a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------
// One-screen capping
// ---------------------------------------------------------------------------

/** How many rows any one section of the human-readable view will list
 * before truncating — the mechanism that keeps `status` "one screen"
 * (this work item's acceptance criterion) true by construction, not just
 * true because a particular fixture happens to have few in-progress/
 * review/stale tickets. `--json` is never capped — it's the agent path,
 * where a truncated list would just be a worse API. */
export const STATUS_LIST_CAP = 10;

export interface CappedRows<T> {
  shown: T[];
  omitted: number;
}

export function capRows<T>(rows: readonly T[], max: number = STATUS_LIST_CAP): CappedRows<T> {
  return { shown: rows.slice(0, max), omitted: Math.max(0, rows.length - max) };
}
