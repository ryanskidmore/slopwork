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
 */
import { type Config, type Ticket, type TicketId, parseDurationMs } from "../core/index.js";
import {
  computeReviewStaleAt,
  computeStaleAt,
  isReviewStale,
  isStale,
} from "../tickets/staleness.js";

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
 * The set of ticket ids with at least one *live* blocker: some other
 * ticket X with this id in `X.blocks`, where X itself hasn't finished
 * (`done`/`dropped`). `X.blocks = [Y]` reads as "X blocks Y" (DECISIONS.md
 * A2, core/entities/edge.ts `outgoingEdges`): the reverse direction is
 * never stored, only derived — this is that derivation, done in memory
 * over every ticket's outgoing `blocks` edges.
 */
export function computeBlockedTicketIds(tickets: readonly Ticket[]): Set<TicketId> {
  const blocked = new Set<TicketId>();
  for (const ticket of tickets) {
    if (ticket.state === "done" || ticket.state === "dropped") continue;
    for (const target of ticket.blocks) {
      blocked.add(target);
    }
  }
  return blocked;
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
