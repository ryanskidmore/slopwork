/**
 * Derived overlays (design.md §2 / D5): "`blocked`/`stale` derived, never
 * asserted." Pure functions over the entities a {@link WebDataSource}
 * already hands back — no persisted `index.jsonc` involved, deliberately,
 * so D5 doesn't have to wait on B4's reindex logic landing in src/repo/.
 *
 * **E1 fix — web/CLI staleness divergence.** Before this fix,
 * {@link isTicketStale} computed review-staleness anchored on
 * `last_activity_at` for BOTH `in_progress` and `review` states, while
 * `src/tickets/staleness.ts` (the CLI's `ready --resumable`/`status`
 * source of truth, C5) anchors `review` specifically on
 * `review.requested_at` — see that module's doc, "`requested_at` vs
 * `last_activity_at` for review staleness", for why that distinction is
 * load-bearing: a review ticket that sits unreviewed for a week, then gets
 * one unrelated `update --progress` note (bumping `last_activity_at`
 * without addressing the review at all), must still read as review-stale;
 * anchoring on `last_activity_at` incorrectly resets the clock on exactly
 * the case the overlay exists to catch. `slop web`'s stale panel could
 * therefore disagree with `slop status`/`slop ready --resumable` about
 * whether the SAME review ticket was stale. Fixed by delegating
 * {@link isTicketStale} to `tickets/staleness.ts`'s pure
 * `computeStaleAt`/`computeReviewStaleAt` (the deadline) +
 * `isStale`/`isReviewStale` (the live boolean) — the exact same functions
 * the CLI uses — rather than re-deriving the rule a second time here. This
 * function's own signature (`ticket, thresholds, nowMs) => boolean`) is
 * UNCHANGED, so every view file that calls it (`views/stale.ts`,
 * `views/review.ts`, `views/ticket-detail.ts`) needed no edits — web/'s
 * routes/rendering stay exactly as D5 built them, per this work item's
 * ground rules (only `overlays.ts` itself is in scope).
 *
 * ticket_01KY9S0172V8AYCYV9KWS6RC9P — three additions, all still pure
 * functions over entities a {@link WebDataSource} already hands back:
 *
 *  - {@link buildReverseEdgeIndex}: the reverse-edge derivation (who blocks
 *    me / who relates to me / what got discovered here) that
 *    `src/repo/db-index.ts`'s `buildIndex` already does for the real index
 *    — mirrored here (same `outgoingEdges` walk, same grouping) rather than
 *    imported, for the same reason `computeBlockedTicketIds` below already
 *    stands alone: this module doesn't depend on the repo layer's locking/
 *    persisted-index machinery, per the class doc on `FixtureDataSource`.
 *  - {@link liveBlockers} / {@link liveBlockersFromReverseIndex}: the
 *    ticket-detail and summary-list "reason" lists for a `blocked` badge —
 *    which specific non-done/dropped tickets are blocking this one, not just
 *    the boolean {@link computeBlockedTicketIds} already gives.
 *  - {@link computeStaleReason}: the ticket-detail "reason" for a `stale`
 *    badge — which clock (in_progress's `last_activity_at` vs review's
 *    `review.requested_at`) is overdue, and since when — matching exactly
 *    what {@link isTicketStale} above already tests for the boolean.
 *  - {@link deriveEffectiveTickets} / {@link buildReverseEdgeIndex}: as of
 *    G2 (unify-effective-overlay) these live in `src/tickets/overlay.ts`
 *    — the ONE shared, pure derived-overlay module BOTH this web package
 *    and the flatfile driver's index build (`src/repo/db-index.ts`)
 *    consume, ending the era of two independently-drifting copies (E1's
 *    web/CLI review-staleness divergence was exactly that drift). They're
 *    re-exported here so every `src/web/api/*` caller keeps its existing
 *    import path. This module no longer imports from `src/repo/` at all —
 *    the web package depends only on `src/core/` and the pure
 *    `src/tickets/` domain modules.
 *  - {@link computeAwaitingInputByTicket} (G4, t-jggg9): same
 *    one-implementation discipline for the `awaiting_input` overlay —
 *    re-exported from `src/tickets/overlay.ts` for every
 *    `src/web/api/*` caller, exactly like the bullet above.
 */
import {
  type Config,
  idMatchesRef,
  parseDurationMs,
  type Ticket,
  type TicketId,
} from "../core/index.js";
import { computeBlockedCounts } from "../tickets/overlay.js";
import {
  computeReviewStaleAt,
  computeStaleAt,
  isReviewStale,
  isStale,
} from "../tickets/staleness.js";

// G2 (unify-effective-overlay): shared pure derivations, re-exported for
// every existing `src/web/api/*` import site — see this module's doc.
export {
  buildReverseEdgeIndex,
  // G4 (t-jggg9): the `awaiting_input` overlay — see this module's doc.
  computeAwaitingInputByTicket,
  deriveEffectiveTickets,
  liveBlockersFromReverseIndex,
  type AwaitingInputOverlay,
  type ReverseEdgeIndex,
} from "../tickets/overlay.js";

export interface StaleThresholds {
  staleAfterMs: number;
  reviewStaleAfterMs: number;
}

export function staleThresholdsFromConfig(config: Config): StaleThresholds {
  return {
    staleAfterMs: parseDurationMs(config.defaults.stale_after),
    reviewStaleAfterMs: parseDurationMs(config.defaults.review_stale_after),
  };
}

/**
 * web-every-request-full-rescans: the exact ref-matching rule
 * `WebDataSource.findTicketByRef` uses (exact slug, exact id, unambiguous
 * short id-prefix — core/ids.ts `idMatchesRef`) but over an ALREADY-FETCHED
 * ticket list, for a caller (`handleTicketDetail`) that has to fetch the
 * full list anyway (for the parent/children/blockers/relationships
 * sections) and would otherwise re-scan the entire tickets directory a
 * second time just to resolve `ref`. `FixtureDataSource.findTicketByRef`
 * itself delegates to this function too, so the matching rule is defined in
 * exactly one place — reused, not reimplemented, on both call paths.
 */
export function matchTicketByRef(tickets: readonly Ticket[], ref: string): Ticket | null {
  const bySlug = tickets.find((t) => t.slug === ref);
  if (bySlug) return bySlug;
  const byId = tickets.find((t) => t.id === ref);
  if (byId) return byId;
  const prefixMatches = tickets.filter((t) => idMatchesRef(t.id, ref));
  return prefixMatches.length === 1 ? (prefixMatches[0] ?? null) : null;
}

/**
 * The set of ticket ids with at least one *live* blocker: some other
 * ticket X with this id in `X.blocks`, where X itself hasn't finished
 * (`done`/`dropped`). `X.blocks = [Y]` reads as "X blocks Y" (DECISIONS.md
 * A2, core/entities/edge.ts `outgoingEdges`): the reverse direction is
 * never stored, only derived — this is that derivation, done in memory
 * over every ticket's outgoing `blocks` edges.
 */
export function computeBlockedTicketIds(tickets: readonly Ticket[]): Set<TicketId> {
  // G2 (unify-effective-overlay): derived from the SAME
  // `computeBlockedCounts` the flatfile driver's index build uses
  // (src/tickets/overlay.ts) rather than a second local walk of every
  // ticket's `blocks` array — one live-blocker rule, everywhere.
  const blocked = new Set<TicketId>();
  for (const [id, count] of computeBlockedCounts(tickets)) {
    if (count > 0) blocked.add(id);
  }
  return blocked;
}

/**
 * The `blocked` overlay's REASON list (this ticket's brief: "blocked (list
 * which non-done tickets block it)") — every OTHER ticket that currently,
 * live-ly, blocks `ticketId`: not yet `done`/`dropped`, and names
 * `ticketId` in its own `blocks` array. `computeBlockedTicketIds` above
 * answers the boolean ("is anything blocked") for a whole ticket set in one
 * pass; this answers "blocked by WHAT, specifically" for one ticket at a
 * time. Callers rendering more than one ticket use
 * {@link liveBlockersFromReverseIndex} with one snapshot-scoped reverse index
 * instead of repeating this O(tickets) scan for every row.
 */
export function liveBlockers(ticketId: TicketId, tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter(
    (t) =>
      t.id !== ticketId &&
      t.blocks.includes(ticketId) &&
      t.state !== "done" &&
      t.state !== "dropped",
  );
}

/**
 * design.md §2: "`stale` (in_progress *or review*, no activity past
 * threshold — review staleness catches MRs rotting unreviewed)." Every
 * other state is never stale. The threshold is `stale_after` for
 * `in_progress`, `review_stale_after` for `review` — two different clocks
 * for two different kinds of waiting.
 *
 * Delegates to `tickets/staleness.ts`'s pure deadline + live-boolean
 * functions (module doc, "E1 fix") — this is now the SAME rule the CLI
 * uses, not a second, independently-drifting implementation of it.
 */
export function isTicketStale(ticket: Ticket, thresholds: StaleThresholds, nowMs: number): boolean {
  const staleAt = computeStaleAt(ticket, thresholds.staleAfterMs);
  const reviewStaleAt = computeReviewStaleAt(ticket, thresholds.reviewStaleAfterMs);
  const now = new Date(nowMs);
  return (
    isStale({ stale_at: staleAt }, now) || isReviewStale({ review_stale_at: reviewStaleAt }, now)
  );
}

/** The `stale` overlay's REASON — which of the two clocks (in_progress's
 * `last_activity_at`, review's `review.requested_at`) is overdue, and the
 * anchor timestamp it's overdue relative to ("since when" — this ticket's
 * brief). `null` when {@link isTicketStale} would also be `false`. A
 * `review` ticket is checked first: a ticket can only be in one state at a
 * time, so at most one branch can ever actually apply — the order is
 * arbitrary between the two, not a priority rule. */
export interface StaleReason {
  state: "in_progress" | "review";
  /** ISO timestamp the relevant threshold is measured from — `last_activity_at` for in_progress, `review.requested_at` (falling back to `last_activity_at` only in the schema-should-make-this-unreachable case `computeReviewStaleAt` itself documents) for review. */
  since: string;
}

export function computeStaleReason(
  ticket: Ticket,
  thresholds: StaleThresholds,
  nowMs: number,
): StaleReason | null {
  const now = new Date(nowMs);
  const reviewStaleAt = computeReviewStaleAt(ticket, thresholds.reviewStaleAfterMs);
  if (isReviewStale({ review_stale_at: reviewStaleAt }, now)) {
    return { state: "review", since: ticket.review?.requested_at ?? ticket.last_activity_at };
  }
  const staleAt = computeStaleAt(ticket, thresholds.staleAfterMs);
  if (isStale({ stale_at: staleAt }, now)) {
    return { state: "in_progress", since: ticket.last_activity_at };
  }
  return null;
}

/** Milliseconds since an ISO timestamp, floored at 0 (clock skew / future timestamps never go negative in the UI). */
export function msSince(iso: string, nowMs: number): number {
  return Math.max(0, nowMs - Date.parse(iso));
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** "3m", "5h", "2d 4h" — compact, for badges and table cells. */
export function formatDurationShort(ms: number): string {
  if (ms < MINUTE) return "<1m";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.floor((ms % HOUR) / MINUTE);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/** "3m ago", "2d ago" — for activity timestamps. */
export function formatRelative(iso: string, nowMs: number): string {
  const ms = msSince(iso, nowMs);
  if (ms < MINUTE) return "just now";
  return `${formatDurationShort(ms)} ago`;
}
