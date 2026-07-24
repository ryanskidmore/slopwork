import { describe, expect, it } from "vitest";
import {
  computeReviewStaleAt,
  computeStaleAt,
  computeStalenessDeadlines,
  isReviewStale,
  isStale,
} from "./staleness.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

describe("computeStaleAt", () => {
  it("in_progress: last_activity_at + staleAfterMs", () => {
    expect(
      computeStaleAt(
        { state: "in_progress", last_activity_at: "2026-07-23T10:00:00.000Z" },
        HOUR_MS,
      ),
    ).toBe("2026-07-23T11:00:00.000Z");
  });

  it("every other state: null", () => {
    const states = ["draft", "open", "review", "done", "dropped"] as const;
    for (const state of states) {
      expect(
        computeStaleAt({ state, last_activity_at: "2026-07-23T10:00:00.000Z" }, HOUR_MS),
      ).toBeNull();
    }
  });

  it("an absurdly huge staleAfterMs clamps to null instead of throwing (regression: ticket duration-huge-stale-after-overflows)", () => {
    // What `parseDurationMs("99999999999d")` produces — overflows a Date.
    const hugeMs = 99_999_999_999 * 86_400_000;
    expect(() =>
      computeStaleAt(
        { state: "in_progress", last_activity_at: "2026-07-23T10:00:00.000Z" },
        hugeMs,
      ),
    ).not.toThrow();
    expect(
      computeStaleAt(
        { state: "in_progress", last_activity_at: "2026-07-23T10:00:00.000Z" },
        hugeMs,
      ),
    ).toBeNull();
  });
});

describe("computeReviewStaleAt", () => {
  it("review: review.requested_at + reviewStaleAfterMs (NOT last_activity_at)", () => {
    const deadline = computeReviewStaleAt(
      {
        state: "review",
        review: { requested_at: "2026-07-22T10:00:00.000Z" },
        last_activity_at: "2026-07-23T09:00:00.000Z", // a later, unrelated activity bump
      },
      DAY_MS,
    );
    expect(deadline).toBe("2026-07-23T10:00:00.000Z"); // anchored on requested_at, not the later last_activity_at
  });

  it("falls back to last_activity_at defensively when review.requested_at is absent", () => {
    const deadline = computeReviewStaleAt(
      { state: "review", review: undefined, last_activity_at: "2026-07-23T09:00:00.000Z" },
      HOUR_MS,
    );
    expect(deadline).toBe("2026-07-23T10:00:00.000Z");
  });

  it("every other state: null", () => {
    const states = ["draft", "open", "in_progress", "done", "dropped"] as const;
    for (const state of states) {
      expect(
        computeReviewStaleAt(
          {
            state,
            review: { requested_at: "2026-07-23T10:00:00.000Z" },
            last_activity_at: "2026-07-23T10:00:00.000Z",
          },
          DAY_MS,
        ),
      ).toBeNull();
    }
  });

  it("an absurdly huge reviewStaleAfterMs clamps to null instead of throwing (regression: ticket duration-huge-stale-after-overflows)", () => {
    const hugeMs = 99_999_999_999 * 86_400_000;
    expect(() =>
      computeReviewStaleAt(
        {
          state: "review",
          review: { requested_at: "2026-07-22T10:00:00.000Z" },
          last_activity_at: "2026-07-23T10:00:00.000Z",
        },
        hugeMs,
      ),
    ).not.toThrow();
    expect(
      computeReviewStaleAt(
        {
          state: "review",
          review: { requested_at: "2026-07-22T10:00:00.000Z" },
          last_activity_at: "2026-07-23T10:00:00.000Z",
        },
        hugeMs,
      ),
    ).toBeNull();
  });
});

describe("computeStalenessDeadlines", () => {
  it("parses config.yaml-shaped duration strings and computes both deadlines in one call", () => {
    const inProgress = computeStalenessDeadlines(
      { state: "in_progress", last_activity_at: "2026-07-23T10:00:00.000Z", review: undefined },
      { stale_after: "60m", review_stale_after: "24h" },
    );
    expect(inProgress).toEqual({ stale_at: "2026-07-23T11:00:00.000Z", review_stale_at: null });

    const review = computeStalenessDeadlines(
      {
        state: "review",
        last_activity_at: "2026-07-23T10:00:00.000Z",
        review: { requested_at: "2026-07-22T10:00:00.000Z" },
      },
      { stale_after: "60m", review_stale_after: "24h" },
    );
    expect(review).toEqual({ stale_at: null, review_stale_at: "2026-07-23T10:00:00.000Z" });
  });

  it("an absurd duration STRING (e.g. config.yaml's stale_after: 99999999999d) never throws end to end (regression: ticket duration-huge-stale-after-overflows)", () => {
    expect(() =>
      computeStalenessDeadlines(
        { state: "in_progress", last_activity_at: "2026-07-23T10:00:00.000Z", review: undefined },
        { stale_after: "99999999999d", review_stale_after: "99999999999d" },
      ),
    ).not.toThrow();
    const deadlines = computeStalenessDeadlines(
      { state: "in_progress", last_activity_at: "2026-07-23T10:00:00.000Z", review: undefined },
      { stale_after: "99999999999d", review_stale_after: "24h" },
    );
    expect(deadlines.stale_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Read-time booleans — the clock-injected seam. Boundary coverage: exactly
// at the deadline, just under, just over — for both stale_after and
// review_stale_after.
// ---------------------------------------------------------------------------

describe("isStale", () => {
  const staleAt = "2026-07-23T11:00:00.000Z";

  it("exactly at the deadline: NOT yet stale (now > stale_at is strict)", () => {
    expect(isStale({ stale_at: staleAt }, new Date(staleAt))).toBe(false);
  });

  it("1ms before the deadline: not stale", () => {
    expect(isStale({ stale_at: staleAt }, new Date(Date.parse(staleAt) - 1))).toBe(false);
  });

  it("1ms after the deadline: stale", () => {
    expect(isStale({ stale_at: staleAt }, new Date(Date.parse(staleAt) + 1))).toBe(true);
  });

  it("well before: not stale; well after: stale", () => {
    expect(isStale({ stale_at: staleAt }, new Date(Date.parse(staleAt) - HOUR_MS))).toBe(false);
    expect(isStale({ stale_at: staleAt }, new Date(Date.parse(staleAt) + HOUR_MS))).toBe(true);
  });

  it("stale_at: null (not applicable) is never stale, regardless of now", () => {
    expect(isStale({ stale_at: null }, new Date("2100-01-01T00:00:00.000Z"))).toBe(false);
  });
});

describe("isReviewStale", () => {
  const reviewStaleAt = "2026-07-24T10:00:00.000Z";

  it("exactly at the deadline: NOT yet stale", () => {
    expect(isReviewStale({ review_stale_at: reviewStaleAt }, new Date(reviewStaleAt))).toBe(false);
  });

  it("1ms before: not stale; 1ms after: stale", () => {
    expect(
      isReviewStale({ review_stale_at: reviewStaleAt }, new Date(Date.parse(reviewStaleAt) - 1)),
    ).toBe(false);
    expect(
      isReviewStale({ review_stale_at: reviewStaleAt }, new Date(Date.parse(reviewStaleAt) + 1)),
    ).toBe(true);
  });

  it("review_stale_at: null is never review-stale", () => {
    expect(isReviewStale({ review_stale_at: null }, new Date("2100-01-01T00:00:00.000Z"))).toBe(
      false,
    );
  });
});
