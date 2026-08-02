import { describe, expect, it } from "vitest";
import type { StatusTicketRow } from "./status.js";
import {
  aggregateDerivedCounts,
  aggregateStateCounts,
  capRows,
  humanizeAge,
  msSince,
  sortInProgressRows,
  sortReviewRows,
  staleTicketRows,
} from "./status.js";

function row(
  overrides: Partial<StatusTicketRow> & { id: string; state: StatusTicketRow["state"] },
): StatusTicketRow {
  return {
    slug: overrides.id,
    name: overrides.id,
    blockedCount: null,
    stale: false,
    reviewStale: false,
    awaitingInputCount: 0,
    oldestOpenQuestionAt: null,
    ...overrides,
  };
}

describe("aggregateStateCounts", () => {
  it("counts every state, including zero-count states, plus a total", () => {
    const rows = [
      row({ id: "a", state: "open" }),
      row({ id: "b", state: "open" }),
      row({ id: "c", state: "in_progress" }),
      row({ id: "d", state: "done" }),
    ];
    expect(aggregateStateCounts(rows)).toEqual({
      draft: 0,
      open: 2,
      in_progress: 1,
      review: 0,
      done: 1,
      dropped: 0,
      total: 4,
    });
  });

  it("an empty repo yields all zeros", () => {
    expect(aggregateStateCounts([])).toEqual({
      draft: 0,
      open: 0,
      in_progress: 0,
      review: 0,
      done: 0,
      dropped: 0,
      total: 0,
    });
  });
});

describe("aggregateDerivedCounts", () => {
  it("blocked is null when every row's blockedCount is still null (pre-B4 index)", () => {
    const rows = [row({ id: "a", state: "in_progress" }), row({ id: "b", state: "review" })];
    expect(aggregateDerivedCounts(rows)).toEqual({ blocked: null, stale: 0 });
  });

  it("blocked becomes a real count once ANY row's blockedCount is non-null (B4 has populated the index)", () => {
    const rows = [
      row({ id: "a", state: "open", blockedCount: 2 }),
      row({ id: "b", state: "open", blockedCount: 0 }),
    ];
    expect(aggregateDerivedCounts(rows).blocked).toBe(1);
  });

  it("blocked is a real 0 (not null) once B4 has populated the index and found nothing blocked", () => {
    const rows = [row({ id: "a", state: "open", blockedCount: 0 })];
    expect(aggregateDerivedCounts(rows).blocked).toBe(0);
  });

  it("stale (C5) is ALWAYS a real count — never null, counts in_progress rows via `stale` and review rows via `reviewStale`", () => {
    const rows = [
      row({ id: "a", state: "in_progress", stale: true }),
      row({ id: "b", state: "in_progress", stale: false }),
      row({ id: "c", state: "review", reviewStale: true }),
      row({ id: "d", state: "done" }), // never counted regardless of state
    ];
    expect(aggregateDerivedCounts(rows).stale).toBe(2);
  });

  it("stale is a real 0 (not null) when nothing is stale", () => {
    const rows = [row({ id: "a", state: "in_progress", stale: false })];
    expect(aggregateDerivedCounts(rows).stale).toBe(0);
  });
});

describe("staleTicketRows", () => {
  it("only in_progress rows with stale===true and review rows with reviewStale===true match", () => {
    const rows = [
      row({ id: "a", state: "in_progress", stale: true }),
      row({ id: "b", state: "in_progress", stale: false }),
      row({ id: "c", state: "review", reviewStale: true }),
      row({ id: "d", state: "review", reviewStale: false }),
      // Cross-wired fields never apply to the "wrong" state:
      row({ id: "e", state: "in_progress", reviewStale: true }),
      row({ id: "f", state: "review", stale: true }),
      row({ id: "g", state: "open", stale: true, reviewStale: true }),
    ];
    expect(staleTicketRows(rows).map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("returns [] (not throw) when nothing is stale", () => {
    const rows = [row({ id: "a", state: "in_progress" }), row({ id: "b", state: "review" })];
    expect(staleTicketRows(rows)).toEqual([]);
  });

  it("sorts by id for determinism", () => {
    const rows = [
      row({ id: "b", state: "in_progress", stale: true }),
      row({ id: "a", state: "review", reviewStale: true }),
    ];
    expect(staleTicketRows(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("humanizeAge", () => {
  it("under a minute is <1m", () => {
    expect(humanizeAge(0)).toBe("<1m");
    expect(humanizeAge(59_999)).toBe("<1m");
  });

  it("minutes", () => {
    expect(humanizeAge(60_000)).toBe("1m");
    expect(humanizeAge(3 * 60_000)).toBe("3m");
    expect(humanizeAge(59 * 60_000)).toBe("59m");
  });

  it("hours", () => {
    expect(humanizeAge(60 * 60_000)).toBe("1h");
    expect(humanizeAge(2 * 3_600_000)).toBe("2h");
    expect(humanizeAge(23 * 3_600_000)).toBe("23h");
  });

  it("days", () => {
    expect(humanizeAge(24 * 3_600_000)).toBe("1d");
    expect(humanizeAge(4 * 86_400_000)).toBe("4d");
  });

  it("a negative (clock-skewed/future) value never goes negative", () => {
    expect(humanizeAge(-1000)).toBe("<1m");
  });
});

describe("msSince", () => {
  it("computes elapsed ms between an ISO timestamp and now", () => {
    const iso = "2026-07-23T10:00:00.000Z";
    const nowMs = Date.parse("2026-07-23T12:00:00.000Z");
    expect(msSince(iso, nowMs)).toBe(2 * 3_600_000);
  });

  it("floors at 0 for a future timestamp", () => {
    const iso = "2026-07-23T12:00:00.000Z";
    const nowMs = Date.parse("2026-07-23T10:00:00.000Z");
    expect(msSince(iso, nowMs)).toBe(0);
  });
});

describe("sortInProgressRows — oldest session first", () => {
  it("sorts descending by session age", () => {
    const rows = [
      {
        id: "a",
        slug: "a",
        name: "a",
        priority: 2,
        session: { id: "s1", actor: "x", harness: "claude-code", startedAt: "t", ageMs: 1000 },
      },
      {
        id: "b",
        slug: "b",
        name: "b",
        priority: 2,
        session: { id: "s2", actor: "x", harness: "claude-code", startedAt: "t", ageMs: 5000 },
      },
      {
        id: "c",
        slug: "c",
        name: "c",
        priority: 2,
        session: { id: "s3", actor: "x", harness: "claude-code", startedAt: "t", ageMs: 2000 },
      },
    ];
    expect(sortInProgressRows(rows).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("rows with an unresolvable session (null) sort last, but are still present", () => {
    const rows = [
      {
        id: "a",
        slug: "a",
        name: "a",
        priority: 2,
        session: { id: "s1", actor: "x", harness: "claude-code", startedAt: "t", ageMs: 1000 },
      },
      { id: "b", slug: "b", name: "b", priority: 2, session: null },
    ];
    expect(sortInProgressRows(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("ties break by id for determinism", () => {
    const rows = [
      {
        id: "z",
        slug: "z",
        name: "z",
        priority: 2,
        session: { id: "s1", actor: "x", harness: "claude-code", startedAt: "t", ageMs: 1000 },
      },
      {
        id: "a",
        slug: "a",
        name: "a",
        priority: 2,
        session: { id: "s2", actor: "x", harness: "claude-code", startedAt: "t", ageMs: 1000 },
      },
    ];
    expect(sortInProgressRows(rows).map((r) => r.id)).toEqual(["a", "z"]);
  });
});

describe("sortReviewRows — longest-waiting first", () => {
  it("sorts descending by age", () => {
    const rows = [
      {
        id: "a",
        slug: "a",
        name: "a",
        mr: null,
        requestedAt: "t",
        by: "x",
        ageMs: 1000,
        reviewStale: false,
      },
      {
        id: "b",
        slug: "b",
        name: "b",
        mr: null,
        requestedAt: "t",
        by: "x",
        ageMs: 9000,
        reviewStale: false,
      },
    ];
    expect(sortReviewRows(rows).map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("capRows", () => {
  it("caps to max and reports how many were omitted", () => {
    const rows = [1, 2, 3, 4, 5];
    expect(capRows(rows, 3)).toEqual({ shown: [1, 2, 3], omitted: 2 });
  });

  it("omitted is 0 when nothing was truncated", () => {
    expect(capRows([1, 2], 10)).toEqual({ shown: [1, 2], omitted: 0 });
  });
});
