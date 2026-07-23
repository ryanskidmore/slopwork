import { describe, expect, it } from "vitest";
import { newTicketId, ticketSchema } from "../core/index.js";
import type { Ticket } from "../core/index.js";
import {
  computeBlockedTicketIds,
  formatDurationShort,
  formatRelative,
  isTicketStale,
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
