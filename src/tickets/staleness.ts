/**
 * Staleness (design.md §2: "`stale` (in_progress *or review*, no activity
 * past threshold — review staleness catches MRs rotting unreviewed)"; §3's
 * `config.yaml` `defaults.stale_after`/`review_stale_after`; work item C5).
 *
 * ## The design correction this module implements
 *
 * The v0 implementation plan's C5 row says "computed in index", which read
 * literally would mean baking a live `stale: true/false` boolean into
 * `index.jsonc` at build time. That is wrong: staleness is a function of
 * **wall-clock time**, not of ticket content, and `index.jsonc` only
 * rebuilds when ticket *files* change (db-index.ts's content-fingerprint
 * auto-heal) — never merely because time passed with nothing edited. A
 * ticket that goes stale purely because 25 hours elapsed with zero
 * activity would never trigger a reindex, so a baked `stale: false` would
 * silently stay wrong forever. This is exactly the case this work item's
 * acceptance criterion targets: "a stale **review** ticket surfaces" — a
 * ticket whose content hasn't changed, only the clock has.
 *
 * The fix, split across two kinds of function below:
 *
 *  - **`computeStaleAt`/`computeReviewStaleAt`/`computeStalenessDeadlines`**
 *    — a **content-derived deadline timestamp**: `last_activity_at +
 *    stale_after` (in_progress) / `review.requested_at + review_stale_after`
 *    (review). This IS safe to store in the index, because it only changes
 *    when the ticket's own content changes (`last_activity_at`/`review`
 *    moving, or a state transition) — exactly what the content fingerprint
 *    already guards. `db-index.ts`'s `buildIndex` calls these once per
 *    ticket and stores the result as `stale_at`/`review_stale_at`.
 *  - **`isStale`/`isReviewStale`** — the **live boolean**, computed at READ
 *    TIME as `now > deadline`, against an explicitly injected `now: Date`
 *    (never a bare `Date.now()`/`new Date()` — see `core/clock.ts`'s
 *    module doc, "nothing outside this module calls those directly"). This
 *    is what makes the acceptance's "clock-injected tests" both possible
 *    and honest: the same stored deadline yields a different boolean
 *    depending purely on when you ask, which is the actual definition of
 *    staleness.
 *
 * This reconciles the plan's "computed in index" (the *deadline* is
 * computed into the index, and is stable/rebuild-safe — proven by
 * `tests/acceptance/C5.test.ts`'s "rebuild at two different nows, same
 * `stale_at`" case) with correctness (the *boolean* is always live). See
 * `DECISIONS.md`'s C5 entry for the fuller writeup.
 *
 * ## `requested_at` vs `last_activity_at` for review staleness
 *
 * design.md §2 says review staleness "catches MRs rotting unreviewed" —
 * i.e. it measures how long the MR has sat **awaiting a human**, not how
 * long ago the ticket was last touched in general. D15's `review` shape
 * (`{mr, requested_at, by}`) exists precisely to mark the moment review was
 * asked for. So {@link computeReviewStaleAt} anchors on
 * `review.requested_at`, not `last_activity_at` — a ticket that sat in
 * review for a week, then got ONE unrelated `update --progress` note today
 * (bumping `last_activity_at` without addressing the review at all) must
 * still read as review-stale; anchoring on `last_activity_at` would
 * incorrectly reset the clock on exactly the case this overlay exists to
 * catch. `last_activity_at` is used only as a defensive fallback if
 * `review.requested_at` is somehow absent on a `review`-state ticket (the
 * `Ticket` schema's own `refine` should make this unreachable in practice
 * — see core/entities/ticket.ts — but this module takes a narrower
 * structural type than the full `Ticket`, so it stays defensive rather
 * than asserting).
 *
 * (`src/web/overlays.ts`'s D5 stale panel independently anchors review
 * staleness on `last_activity_at` for both in_progress and review — a
 * pre-existing, documented divergence this work item does not touch, D5
 * being out of scope per this work item's ground rules. Unifying the two
 * is an E1 polish opportunity, not C5's job.)
 */
import type { ConfigDefaults, TicketState } from "../core/index.js";
import { isRepresentableDurationMs, parseDurationMs } from "../core/index.js";
import type { IsoTimestamp } from "../core/timestamp.js";

/** The minimal ticket-shaped input {@link computeStaleAt} needs. */
export interface StaleAtSource {
  state: TicketState;
  last_activity_at: string;
}

/** The minimal ticket-shaped input {@link computeReviewStaleAt} needs. */
export interface ReviewStaleAtSource {
  state: TicketState;
  review?: { requested_at: string } | undefined;
  /** Defensive fallback only — see module doc, "requested_at vs last_activity_at". */
  last_activity_at: string;
}

/**
 * `null` (rather than a throw) for a duration whose magnitude overflows
 * what a `Date` can represent (`core/duration.ts`'s
 * `isRepresentableDurationMs` — e.g. a `stale_after: 99999999999d` in
 * config.yaml) — `computeStaleAt`/`computeReviewStaleAt` already return
 * `IsoTimestamp | null`, so this reads as "no deadline", i.e. staleness
 * disabled for that ticket, exactly the behavior a user setting an absurd
 * duration to mean "never" would want, instead of `Date#toISOString`
 * throwing `RangeError: Invalid time value` and taking down the whole
 * index build (every `status`/`ready`/`reindex` call).
 */
function addMs(iso: string, ms: number): IsoTimestamp | null {
  if (!isRepresentableDurationMs(ms)) return null;
  const date = new Date(Date.parse(iso) + ms);
  // Defensive: a representable ms combined with a malformed iso could
  // still, in principle, produce an Invalid Date — never let
  // toISOString throw regardless of how we got here.
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString() as IsoTimestamp;
}

/**
 * `last_activity_at + staleAfterMs`, for an `in_progress` ticket; `null`
 * for every other state (design.md §2: only in_progress/review carry a
 * staleness overlay at all, and this is specifically the in_progress
 * half). Pure content-derived deadline — no clock involved, see module doc.
 */
export function computeStaleAt(ticket: StaleAtSource, staleAfterMs: number): IsoTimestamp | null {
  if (ticket.state !== "in_progress") return null;
  return addMs(ticket.last_activity_at, staleAfterMs);
}

/**
 * `review.requested_at + reviewStaleAfterMs`, for a `review` ticket; `null`
 * for every other state. See module doc for why `requested_at` (not
 * `last_activity_at`) is the anchor.
 */
export function computeReviewStaleAt(
  ticket: ReviewStaleAtSource,
  reviewStaleAfterMs: number,
): IsoTimestamp | null {
  if (ticket.state !== "review") return null;
  const anchor = ticket.review?.requested_at ?? ticket.last_activity_at;
  return addMs(anchor, reviewStaleAfterMs);
}

export interface StalenessDeadlines {
  stale_at: IsoTimestamp | null;
  review_stale_at: IsoTimestamp | null;
}

/**
 * Both deadlines in one call, parsing `config.yaml`'s duration strings
 * (A2's `parseDurationMs`) internally — the one-stop function
 * `db-index.ts`'s `buildIndex` calls per ticket.
 */
export function computeStalenessDeadlines(
  ticket: StaleAtSource & ReviewStaleAtSource,
  defaults: Pick<ConfigDefaults, "stale_after" | "review_stale_after">,
): StalenessDeadlines {
  const staleAfterMs = parseDurationMs(defaults.stale_after);
  const reviewStaleAfterMs = parseDurationMs(defaults.review_stale_after);
  return {
    stale_at: computeStaleAt(ticket, staleAfterMs),
    review_stale_at: computeReviewStaleAt(ticket, reviewStaleAfterMs),
  };
}

/** Structural — matches `IndexTicketRow` without importing the repo layer,
 * and matches a hand-built test literal just as well. */
export interface StaleAtCarrier {
  stale_at: string | null;
}

/** Structural — see {@link StaleAtCarrier}. */
export interface ReviewStaleAtCarrier {
  review_stale_at: string | null;
}

/**
 * Read-time predicate: is this row/ticket stale **right now**, per an
 * explicitly injected `now`? `now > stale_at`, strictly — a ticket exactly
 * AT its deadline is not yet stale, only the instant after (see
 * `staleness.test.ts`'s boundary cases: exactly-at / just-under /
 * just-over). `stale_at === null` (ticket not in_progress, or a pre-rebuild
 * index row for a ticket that was never in_progress) is never stale.
 */
export function isStale(row: StaleAtCarrier, now: Date): boolean {
  return row.stale_at !== null && now.getTime() > Date.parse(row.stale_at);
}

/** Read-time predicate for review staleness — see {@link isStale}. */
export function isReviewStale(row: ReviewStaleAtCarrier, now: Date): boolean {
  return row.review_stale_at !== null && now.getTime() > Date.parse(row.review_stale_at);
}
