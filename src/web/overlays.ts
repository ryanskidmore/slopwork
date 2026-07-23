/**
 * Derived overlays (design.md §2 / D5): "`blocked`/`stale` derived, never
 * asserted." Pure functions over the entities a {@link WebDataSource}
 * already hands back — no persisted `index.jsonc` involved, deliberately,
 * so D5 doesn't have to wait on B4's reindex logic landing in src/repo/.
 */
import { type Config, type Ticket, type TicketId, parseDurationMs } from "../core/index.js";

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
 */
export function isTicketStale(ticket: Ticket, thresholds: StaleThresholds, nowMs: number): boolean {
  if (ticket.state !== "in_progress" && ticket.state !== "review") return false;
  const thresholdMs =
    ticket.state === "review" ? thresholds.reviewStaleAfterMs : thresholds.staleAfterMs;
  const lastActivityMs = Date.parse(ticket.last_activity_at);
  return nowMs - lastActivityMs > thresholdMs;
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
