import { describe, expect, it } from "vitest";
import type { Event, Ticket } from "../core/index.js";
import { newEventId, newSessionId, newTicketId, ticketSchema } from "../core/index.js";
import {
  buildReverseEdgeIndex,
  computeBlockedTicketIds,
  computeStaleReason,
  deriveEffectiveTickets,
  formatDurationShort,
  formatRelative,
  isTicketStale,
  liveBlockers,
  msSince,
  staleThresholdsFromConfig,
} from "./overlays.js";

function ticket(overrides: Record<string, unknown> = {}): Ticket {
  const id = (overrides.id as string | undefined) ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: "a-ticket",
    spec: { summary: "summary" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

describe("computeBlockedTicketIds", () => {
  it("marks a ticket blocked when a non-finished ticket lists it in `blocks`", () => {
    const target = ticket();
    const blocker = ticket({ state: "in_progress", blocks: [target.id] });
    const blocked = computeBlockedTicketIds([target, blocker]);
    expect(blocked.has(target.id)).toBe(true);
  });

  it("does not count a done or dropped ticket as a live blocker", () => {
    const target = ticket();
    const doneBlocker = ticket({ state: "done", blocks: [target.id] });
    const droppedBlocker = ticket({ state: "dropped", blocks: [target.id] });
    const blocked = computeBlockedTicketIds([target, doneBlocker, droppedBlocker]);
    expect(blocked.has(target.id)).toBe(false);
  });

  it("returns an empty set when nothing blocks anything", () => {
    const a = ticket();
    const b = ticket();
    expect(computeBlockedTicketIds([a, b]).size).toBe(0);
  });
});

describe("isTicketStale", () => {
  const thresholds = staleThresholdsFromConfig({
    project: "x",
    remotes: {},
    defaults: { stale_after: "60m", review_stale_after: "24h" },
    transcripts: "local",
  });
  const now = Date.parse("2026-07-23T12:00:00.000Z");

  it("is never stale for draft/open/done/dropped, regardless of activity age", () => {
    for (const state of ["draft", "open", "done", "dropped"] as const) {
      const t = ticket({ state, last_activity_at: "2020-01-01T00:00:00.000Z" });
      expect(isTicketStale(t, thresholds, now)).toBe(false);
    }
  });

  it("in_progress is stale past stale_after, fresh within it", () => {
    const fresh = ticket({ state: "in_progress", last_activity_at: "2026-07-23T11:30:00.000Z" }); // 30m ago
    const stale = ticket({ state: "in_progress", last_activity_at: "2026-07-23T10:00:00.000Z" }); // 2h ago
    expect(isTicketStale(fresh, thresholds, now)).toBe(false);
    expect(isTicketStale(stale, thresholds, now)).toBe(true);
  });

  it("review uses the longer review_stale_after threshold, not stale_after", () => {
    const twoHoursAgo = ticket({
      state: "review",
      last_activity_at: "2026-07-23T10:00:00.000Z",
      review: { requested_at: "2026-07-23T10:00:00.000Z", by: { name: "ryan", kind: "human" } },
    });
    // 2h > stale_after(60m) but well within review_stale_after(24h).
    expect(isTicketStale(twoHoursAgo, thresholds, now)).toBe(false);

    const twoDaysAgo = ticket({
      state: "review",
      last_activity_at: "2026-07-21T12:00:00.000Z",
      review: { requested_at: "2026-07-21T12:00:00.000Z", by: { name: "ryan", kind: "human" } },
    });
    expect(isTicketStale(twoDaysAgo, thresholds, now)).toBe(true);
  });

  // E1: web's stale panel used to anchor review-staleness on
  // `last_activity_at` (unlike the CLI's `tickets/staleness.ts`, which
  // anchors on `review.requested_at` — DECISIONS.md's C5 entry, "requested_at
  // vs last_activity_at"). Unified onto the same shared functions; this is
  // the case that used to disagree between web and the CLI.
  it('review staleness is anchored on "requested_at", not a fresher unrelated "last_activity_at" — matches tickets/staleness.ts', () => {
    // The MR has sat for review_stale_after (24h) worth of time — but an
    // UNRELATED progress note bumped last_activity_at to just now. Anchoring
    // on last_activity_at (the old web-only bug) would incorrectly read this
    // as fresh; anchoring on requested_at (the fix) correctly reads it as
    // stale — this is the exact case the review-staleness overlay exists to
    // catch (design.md §2: "catches MRs rotting unreviewed").
    const stillRotting = ticket({
      state: "review",
      last_activity_at: "2026-07-23T11:59:00.000Z", // 1 minute ago — looks fresh
      review: {
        requested_at: "2026-07-21T12:00:00.000Z", // 2 days ago — actually stale
        by: { name: "ryan", kind: "human" },
      },
    });
    expect(isTicketStale(stillRotting, thresholds, now)).toBe(true);
  });
});

describe("formatDurationShort / formatRelative", () => {
  it("formats sub-minute durations as <1m", () => {
    expect(formatDurationShort(30_000)).toBe("<1m");
  });

  it("formats minutes, hours, and days", () => {
    expect(formatDurationShort(5 * 60_000)).toBe("5m");
    expect(formatDurationShort(90 * 60_000)).toBe("1h 30m");
    expect(formatDurationShort(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 3h");
  });

  it("formatRelative appends 'ago' and floors at 'just now'", () => {
    const now = Date.parse("2026-07-23T12:00:00.000Z");
    expect(formatRelative("2026-07-23T11:59:45.000Z", now)).toBe("just now");
    expect(formatRelative("2026-07-23T10:00:00.000Z", now)).toBe("2h ago");
  });

  it("msSince never goes negative even for a future timestamp", () => {
    const now = Date.parse("2026-07-23T12:00:00.000Z");
    expect(msSince("2026-07-24T00:00:00.000Z", now)).toBe(0);
  });
});

// ticket_01KY9S0172V8AYCYV9KWS6RC9P: the ticket-detail "reason" list for a
// `blocked` badge — WHICH tickets, not just whether any do.
describe("liveBlockers", () => {
  it("returns every non-done/dropped ticket that names the target in its own `blocks`", () => {
    const target = ticket();
    const openBlocker = ticket({ state: "open", blocks: [target.id] });
    const inProgressBlocker = ticket({ state: "in_progress", blocks: [target.id] });
    const doneBlocker = ticket({ state: "done", blocks: [target.id] });
    const unrelated = ticket();
    const blockers = liveBlockers(target.id, [
      target,
      openBlocker,
      inProgressBlocker,
      doneBlocker,
      unrelated,
    ]);
    expect(blockers.map((b) => b.id).sort()).toEqual([openBlocker.id, inProgressBlocker.id].sort());
  });

  it("returns an empty array when nothing blocks the target", () => {
    const target = ticket();
    expect(liveBlockers(target.id, [target])).toEqual([]);
  });
});

// ticket_01KY9S0172V8AYCYV9KWS6RC9P: the ticket-detail "reason" for a
// `stale` badge — which clock, and since when.
describe("computeStaleReason", () => {
  const thresholds = staleThresholdsFromConfig({
    project: "x",
    remotes: {},
    defaults: { stale_after: "60m", review_stale_after: "24h" },
    transcripts: "local",
  });
  const now = Date.parse("2026-07-23T12:00:00.000Z");

  it("is null whenever isTicketStale is false", () => {
    const fresh = ticket({ state: "in_progress", last_activity_at: "2026-07-23T11:30:00.000Z" });
    expect(isTicketStale(fresh, thresholds, now)).toBe(false);
    expect(computeStaleReason(fresh, thresholds, now)).toBeNull();
  });

  it("reports state in_progress, anchored on last_activity_at, when in_progress is stale", () => {
    const stale = ticket({ state: "in_progress", last_activity_at: "2026-07-23T10:00:00.000Z" });
    expect(computeStaleReason(stale, thresholds, now)).toEqual({
      state: "in_progress",
      since: "2026-07-23T10:00:00.000Z",
    });
  });

  it("reports state review, anchored on review.requested_at (not last_activity_at), when review is stale", () => {
    const stillRotting = ticket({
      state: "review",
      last_activity_at: "2026-07-23T11:59:00.000Z", // fresh-looking, but irrelevant to review staleness
      review: {
        requested_at: "2026-07-21T12:00:00.000Z", // 2 days ago — actually stale
        by: { name: "ryan", kind: "human" },
      },
    });
    expect(computeStaleReason(stillRotting, thresholds, now)).toEqual({
      state: "review",
      since: "2026-07-21T12:00:00.000Z",
    });
  });
});

// ticket_01KY9S0172V8AYCYV9KWS6RC9P: reverse-edge derivation — "who blocks
// me" / "who relates to me" / "what got discovered here" — mirrors
// src/repo/db-index.ts's buildIndex reverse-edge computation.
describe("buildReverseEdgeIndex", () => {
  it("derives blockedBy from every OTHER ticket's outgoing `blocks`, regardless of state", () => {
    const target = ticket();
    const liveBlocker = ticket({ state: "open", blocks: [target.id] });
    const doneBlocker = ticket({ state: "done", blocks: [target.id] });
    const index = buildReverseEdgeIndex([target, liveBlocker, doneBlocker]);
    // Unlike liveBlockers, this includes the done blocker too — it's a
    // structural edge, not a live-overlay reason.
    expect(index.blockedBy.get(target.id)?.sort()).toEqual([liveBlocker.id, doneBlocker.id].sort());
  });

  it("derives relatedFrom from every OTHER ticket's outgoing `relates_to`", () => {
    const a = ticket();
    const b = ticket({ relates_to: [a.id] });
    const index = buildReverseEdgeIndex([a, b]);
    expect(index.relatedFrom.get(a.id)).toEqual([b.id]);
    expect(index.relatedFrom.get(b.id) ?? []).toEqual([]);
  });

  it('derives "discovered" (discovered-from reverse) from every OTHER ticket\'s outgoing `discovered_from`', () => {
    const workedTicket = ticket();
    const foundWhileWorkingIt = ticket({ discovered_from: [workedTicket.id] });
    const index = buildReverseEdgeIndex([workedTicket, foundWhileWorkingIt]);
    expect(index.discovered.get(workedTicket.id)).toEqual([foundWhileWorkingIt.id]);
  });

  it("returns empty arrays (via ?? []) for a ticket nothing points at", () => {
    const lonely = ticket();
    const index = buildReverseEdgeIndex([lonely]);
    expect(index.blockedBy.get(lonely.id) ?? []).toEqual([]);
    expect(index.relatedFrom.get(lonely.id) ?? []).toEqual([]);
    expect(index.discovered.get(lonely.id) ?? []).toEqual([]);
  });
});

// ticket_01KY9S0172V8AYCYV9KWS6RC9P: applying src/repo/db-index.ts's
// deriveEffectiveOverlay across a whole ticket list — the same EFFECTIVE
// latest_note/last_activity_at `slop show` renders, not the possibly-stale
// verbatim ticket-file value.
describe("deriveEffectiveTickets", () => {
  function progressEvent(ticketId: string, at: string, progress: string): Event {
    return {
      id: newEventId(),
      actor: { name: "agent", kind: "agent" },
      session: null,
      verb: "ticket.updated",
      entity: { kind: "ticket", id: ticketId },
      payload: { progress },
      at,
    };
  }

  it("folds a lock-free progress event newer than the stored baseline into latest_note/last_activity_at", () => {
    const t = ticket({ last_activity_at: "2026-07-23T10:00:00.000Z", latest_note: null });
    const events = [progressEvent(t.id, "2026-07-23T11:00:00.000Z", "still going")];
    const [effective] = deriveEffectiveTickets([t], events);
    expect(effective?.latest_note).toBe("still going");
    expect(effective?.last_activity_at).toBe("2026-07-23T11:00:00.000Z");
    // The original ticket object is untouched (a new object is returned).
    expect(t.latest_note).toBeNull();
  });

  it("returns the SAME object reference when no event is newer than the stored baseline (no-op case)", () => {
    const t = ticket({ last_activity_at: "2026-07-23T10:00:00.000Z", latest_note: "already this" });
    const olderEvent = progressEvent(t.id, "2026-07-23T09:00:00.000Z", "stale note");
    const [effective] = deriveEffectiveTickets([t], [olderEvent]);
    expect(effective).toBe(t);
  });

  it("ignores events for other tickets and non-ticket-kind events", () => {
    const t = ticket({ last_activity_at: "2026-07-23T10:00:00.000Z" });
    const other = ticket();
    const sessionId = newSessionId();
    const events: Event[] = [
      progressEvent(other.id, "2026-07-23T12:00:00.000Z", "not mine"),
      {
        id: newEventId(),
        actor: { name: "agent", kind: "agent" },
        session: sessionId,
        verb: "session.started",
        entity: { kind: "session", id: sessionId },
        payload: {},
        at: "2026-07-23T12:00:00.000Z",
      },
    ];
    const [effective] = deriveEffectiveTickets([t], events);
    expect(effective).toBe(t);
  });
});
