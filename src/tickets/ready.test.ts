import { describe, expect, it } from "vitest";
import { newSessionId, newTicketId } from "../core/index.js";
import type { TicketId } from "../core/index.js";
import type { IndexTicketRow } from "../repo/db-index.js";
import {
  READY_WHY,
  buildReadyEntries,
  compareReadyOrder,
  filterReadyRows,
  filterResumableRows,
  renderReadyWithBudget,
  resumableReasonText,
} from "./ready.js";
import type { ReadyEntry } from "./ready.js";

function makeRow(overrides: Partial<IndexTicketRow> = {}): IndexTicketRow {
  const id = overrides.id ?? newTicketId();
  return {
    id,
    slug: overrides.slug ?? `t-${id.slice(-10).toLowerCase()}`,
    name: "Ticket",
    state: "open",
    priority: 2,
    parent: null,
    root_id: id,
    path: [],
    labels: [],
    owner: null,
    latest_note: null,
    last_activity_at: "2026-07-23T10:00:00.000Z",
    active_session: null,
    blocked_by: [],
    related_from: [],
    discovered: [],
    blocked_count: 0,
    ready: true,
    stale_at: null,
    review_stale_at: null,
    awaiting_input: false,
    open_question_count: 0,
    oldest_open_question_at: null,
    ...overrides,
  };
}

function makeDescendantRow(
  ancestors: readonly TicketId[],
  overrides: Partial<IndexTicketRow> = {},
): IndexTicketRow {
  const id = overrides.id ?? newTicketId();
  const rootId = ancestors[0] ?? id;
  return makeRow({
    id,
    parent: ancestors[ancestors.length - 1] ?? null,
    root_id: rootId,
    path: [...ancestors],
    ...overrides,
  });
}

// Deterministically ordered ids, oldest first — real ULIDs sort
// chronologically, so this mirrors "create ticket A, then B, then C".
function idsInOrder(n: number): TicketId[] {
  const ids: TicketId[] = [];
  for (let i = 0; i < n; i++) ids.push(newTicketId());
  return ids.sort(); // newTicketId() is already monotonic, but be explicit
}

describe("compareReadyOrder", () => {
  it("orders by priority ascending (0 = urgent first)", () => {
    const [olderId, newerId] = idsInOrder(2) as [TicketId, TicketId];
    const urgent = makeRow({ id: newerId, priority: 0 });
    const low = makeRow({ id: olderId, priority: 3 });
    expect(compareReadyOrder(urgent, low)).toBeLessThan(0);
    expect(compareReadyOrder(low, urgent)).toBeGreaterThan(0);
  });

  it("within the same priority, older (smaller id) sorts first", () => {
    const [olderId, newerId] = idsInOrder(2) as [TicketId, TicketId];
    const older = makeRow({ id: olderId, priority: 1 });
    const newer = makeRow({ id: newerId, priority: 1 });
    expect(compareReadyOrder(older, newer)).toBeLessThan(0);
    expect(compareReadyOrder(newer, older)).toBeGreaterThan(0);
  });

  it("is a total order with no ties: sorting a mixed fixture is deterministic and exact", () => {
    const ids = idsInOrder(6) as [TicketId, TicketId, TicketId, TicketId, TicketId, TicketId];
    // Two at priority 0 (ids[0] older, ids[1] newer), two at priority 1
    // (ids[2] older, ids[3] newer), two at priority 3 (ids[4] older,
    // ids[5] newer) — deliberately inserted out of order.
    const rows = [
      makeRow({ id: ids[5], priority: 3 }),
      makeRow({ id: ids[1], priority: 0 }),
      makeRow({ id: ids[3], priority: 1 }),
      makeRow({ id: ids[0], priority: 0 }),
      makeRow({ id: ids[4], priority: 3 }),
      makeRow({ id: ids[2], priority: 1 }),
    ];
    const sorted = rows
      .slice()
      .sort(compareReadyOrder)
      .map((r) => r.id);
    expect(sorted).toEqual([ids[0], ids[1], ids[2], ids[3], ids[4], ids[5]]);
  });
});

describe("filterReadyRows", () => {
  it("keeps only rows with ready === true", () => {
    const readyRow = makeRow({ ready: true });
    const notReady = makeRow({ ready: false });
    const unknown = makeRow({ ready: null }); // pre-B4 index — see db-index.ts's "Known limitation"
    const result = filterReadyRows([readyRow, notReady, unknown]);
    expect(result.map((r) => r.id)).toEqual([readyRow.id]);
  });

  it("orders the result by compareReadyOrder", () => {
    const [olderId, newerId] = idsInOrder(2) as [TicketId, TicketId];
    const older = makeRow({ id: olderId, priority: 1, ready: true });
    const newer = makeRow({ id: newerId, priority: 0, ready: true });
    const result = filterReadyRows([older, newer]);
    expect(result.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it("keeps only the deepest actionable leaf when direct and transitive descendants are nonterminal", () => {
    const root = makeRow({ name: "Umbrella", priority: 0 });
    const child = makeDescendantRow([root.id], { name: "Child", priority: 1 });
    const grandchild = makeDescendantRow([root.id, child.id], {
      name: "Grandchild",
      priority: 2,
    });

    expect(filterReadyRows([root, child, grandchild]).map((row) => row.id)).toEqual([
      grandchild.id,
    ]);
  });

  it("done and dropped descendants do not suppress an otherwise ready ancestor", () => {
    const root = makeRow({ name: "Finished umbrella" });
    const doneChild = makeDescendantRow([root.id], { state: "done", ready: false });
    const droppedChild = makeDescendantRow([root.id], { state: "dropped", ready: false });

    expect(filterReadyRows([root, doneChild, droppedChild]).map((row) => row.id)).toEqual([
      root.id,
    ]);
  });

  it("blocked and awaiting-input descendants still suppress their ancestors", () => {
    const blockedRoot = makeRow({ name: "Blocked-child umbrella" });
    const blockedChild = makeDescendantRow([blockedRoot.id], {
      ready: false,
      blocked_count: 1,
    });
    const awaitingRoot = makeRow({ name: "Awaiting-child umbrella" });
    const awaitingChild = makeDescendantRow([awaitingRoot.id], {
      awaiting_input: true,
      open_question_count: 1,
      oldest_open_question_at: "2026-07-23T10:00:00.000Z",
    });

    expect(filterReadyRows([blockedRoot, blockedChild, awaitingRoot, awaitingChild])).toEqual([]);
    expect(
      filterReadyRows([blockedRoot, blockedChild, awaitingRoot, awaitingChild], {
        includeAwaiting: true,
      }).map((row) => row.id),
    ).toEqual([awaitingChild.id]);
  });

  it("--label filters to rows carrying the exact label", () => {
    const withLabel = makeRow({ labels: ["area:auth"], ready: true });
    const withoutLabel = makeRow({ labels: ["area:web"], ready: true });
    const result = filterReadyRows([withLabel, withoutLabel], { labels: ["area:auth"] });
    expect(result.map((r) => r.id)).toEqual([withLabel.id]);
  });

  it("does not mutate the input array", () => {
    const rows = [makeRow({ priority: 3 }), makeRow({ priority: 0 })];
    const copy = [...rows];
    filterReadyRows(rows);
    expect(rows).toEqual(copy);
  });
});

const NOW = new Date("2026-07-23T12:00:00.000Z");

describe("filterResumableRows", () => {
  it("includes in_progress with no active session", () => {
    const row = makeRow({ state: "in_progress", active_session: null, ready: false });
    const result = filterResumableRows([row], NOW);
    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toBe("in_progress_no_session");
  });

  it("includes review with no active session", () => {
    const row = makeRow({ state: "review", active_session: null, ready: false });
    const result = filterResumableRows([row], NOW);
    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toBe("review_no_session");
  });

  it("excludes in_progress/review WITH an active session that is NOT stale", () => {
    const row = makeRow({
      state: "in_progress",
      active_session: newSessionId(),
      ready: false,
      stale_at: "2026-07-23T13:00:00.000Z", // in the future relative to NOW — not stale yet
    });
    expect(filterResumableRows([row], NOW)).toEqual([]);
  });

  // C5: a ticket whose session is still technically active but has gone
  // stale (an agent vanished mid-session) is resumable too — module doc,
  // "resumable".
  describe("C5: widened to include a stale ticket that still has an active session", () => {
    it("includes an in_progress ticket with an active session once stale_at is in the past", () => {
      const row = makeRow({
        state: "in_progress",
        active_session: newSessionId(),
        ready: false,
        stale_at: "2026-07-23T11:00:00.000Z", // before NOW — past the deadline
      });
      const result = filterResumableRows([row], NOW);
      expect(result).toHaveLength(1);
      expect(result[0]?.reason).toBe("in_progress_stale");
    });

    it("includes a review ticket with an active session once review_stale_at is in the past", () => {
      const row = makeRow({
        state: "review",
        active_session: newSessionId(),
        ready: false,
        review_stale_at: "2026-07-23T11:00:00.000Z", // before NOW
      });
      const result = filterResumableRows([row], NOW);
      expect(result).toHaveLength(1);
      expect(result[0]?.reason).toBe("review_stale");
    });

    it("does NOT include an in_progress ticket with an active session whose stale_at is still in the future", () => {
      const row = makeRow({
        state: "in_progress",
        active_session: newSessionId(),
        stale_at: "2026-07-23T12:00:00.001Z", // 1ms after NOW — not yet stale
      });
      expect(filterResumableRows([row], NOW)).toEqual([]);
    });

    it("an active-session ticket with stale_at EXACTLY at now is not yet stale (boundary, now > deadline is strict)", () => {
      const row = makeRow({
        state: "in_progress",
        active_session: newSessionId(),
        stale_at: NOW.toISOString(),
      });
      expect(filterResumableRows([row], NOW)).toEqual([]);
    });
  });

  it("excludes open/draft/done/dropped regardless of active_session", () => {
    const states = ["draft", "open", "done", "dropped"] as const;
    const rows = states.map((state) => makeRow({ state, active_session: null }));
    expect(filterResumableRows(rows, NOW)).toEqual([]);
  });

  it("applies --label", () => {
    const matches = makeRow({ state: "in_progress", active_session: null, labels: ["x"] });
    const noMatch = makeRow({ state: "in_progress", active_session: null, labels: ["y"] });
    const result = filterResumableRows([matches, noMatch], NOW, { labels: ["x"] });
    expect(result.map((r) => r.row.id)).toEqual([matches.id]);
  });

  it("orders by compareReadyOrder", () => {
    const [olderId, newerId] = idsInOrder(2) as [TicketId, TicketId];
    const older = makeRow({ id: olderId, priority: 1, state: "review", active_session: null });
    const newer = makeRow({ id: newerId, priority: 0, state: "in_progress", active_session: null });
    const result = filterResumableRows([older, newer], NOW);
    expect(result.map((r) => r.row.id)).toEqual([newer.id, older.id]);
  });

  it("excludes stopped and stale resumable umbrellas while they have nonterminal descendants", () => {
    const stopped = makeRow({ state: "in_progress", active_session: null, ready: false });
    const stoppedChild = makeDescendantRow([stopped.id]);
    const stale = makeRow({
      state: "in_progress",
      active_session: newSessionId(),
      ready: false,
      stale_at: "2026-07-23T11:00:00.000Z",
    });
    const staleGrandchild = makeDescendantRow([stale.id, newTicketId()]);

    expect(filterResumableRows([stopped, stoppedChild, stale, staleGrandchild], NOW)).toEqual([]);
  });
});

describe("resumableReasonText", () => {
  it("gives a distinct, human-readable string per reason", () => {
    expect(resumableReasonText("in_progress_no_session")).toMatch(/in_progress/);
    expect(resumableReasonText("review_no_session")).toMatch(/review/);
    expect(resumableReasonText("in_progress_stale")).toMatch(/stale/);
    expect(resumableReasonText("review_stale")).toMatch(/stale/);
    expect(resumableReasonText("review_stale")).toMatch(/no nonterminal descendants/);
    const texts = new Set([
      resumableReasonText("in_progress_no_session"),
      resumableReasonText("review_no_session"),
      resumableReasonText("in_progress_stale"),
      resumableReasonText("review_stale"),
    ]);
    expect(texts.size).toBe(4); // all distinct
  });
});

describe("buildReadyEntries", () => {
  it("puts every ready entry before every resumable entry", () => {
    const readyRow = makeRow({ priority: 3 }); // low priority ready ticket
    const resumableRow = makeRow({ priority: 0, state: "in_progress", active_session: null }); // urgent resumable
    const entries = buildReadyEntries(
      [readyRow],
      [{ row: resumableRow, reason: "in_progress_no_session" }],
    );
    expect(entries.map((e) => e.section)).toEqual(["ready", "resumable"]);
  });

  it("tags every entry with its `why`", () => {
    const readyRow = makeRow();
    const resumableRow = makeRow({ state: "review", active_session: null });
    const entries = buildReadyEntries(
      [readyRow],
      [{ row: resumableRow, reason: "review_no_session" }],
    );
    expect(entries[0]?.why).toBe(READY_WHY);
    expect(entries[1]?.why).toBe(resumableReasonText("review_no_session"));
  });
});

describe("renderReadyWithBudget", () => {
  const render = (kept: readonly ReadyEntry[], elisions: readonly string[]): string => {
    const body = kept.map((e) => e.row.id).join(",");
    const noteBlock = elisions.length > 0 ? `|NOTES:${elisions.join(";")}` : "";
    return `[${body}]${noteBlock}`;
  };

  function entriesFor(count: number): ReadyEntry[] {
    return buildReadyEntries(
      Array.from({ length: count }, () => makeRow()),
      [],
    );
  }

  it("returns the full render unchanged when no budget is given", () => {
    const entries = entriesFor(1);
    const result = renderReadyWithBudget(entries, render);
    expect(result.elisions).toEqual([]);
    expect(result.withinBudget).toBe(true);
    expect(result.text).toBe(render(entries, []));
  });

  it("returns the full render unchanged when it already fits the budget", () => {
    const entries = entriesFor(1);
    const full = render(entries, []);
    const result = renderReadyWithBudget(entries, render, full.length);
    expect(result.text).toBe(full);
    expect(result.elisions).toEqual([]);
  });

  it("elides trailing (least important) entries one at a time until it fits, and says what was elided", () => {
    const entries = entriesFor(3);
    const full = render(entries, []);
    // Force elision by budgeting for less than the full render.
    const budget = full.length - 1;
    const result = renderReadyWithBudget(entries, render, budget);
    expect(result.withinBudget).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(budget);
    expect(result.elisions).toHaveLength(1);
    expect(result.elisions[0]).toMatch(/omitted to fit --budget/);
  });

  it("never returns text longer than budgetChars, even for a pathologically tiny budget", () => {
    const entries = entriesFor(2);
    const result = renderReadyWithBudget(entries, render, 1);
    expect(result.text.length).toBeLessThanOrEqual(1);
  });

  it("handles budgetChars: 0", () => {
    const entries = entriesFor(1);
    const result = renderReadyWithBudget(entries, render, 0);
    expect(result.text).toBe("");
    expect(result.text.length).toBeLessThanOrEqual(0);
  });

  it("handles an empty entries list with a budget", () => {
    const result = renderReadyWithBudget([], render, 100);
    expect(result.text).toBe("[]");
    expect(result.elisions).toEqual([]);
  });

  // E1 defect fix (B4 adversarial review): `ready --json --budget <tiny>`
  // used to emit invalid, truncated-mid-structure JSON on exit 0, because
  // the last-resort fallback was a raw string slice — fine for text, fatal
  // for JSON. `format: "json"` must never do that: the floor is the
  // already-valid empty-entries envelope, returned as-is.
  describe('format: "json" never corrupts the JSON, even at a pathologically tiny budget', () => {
    const jsonRender = (kept: readonly ReadyEntry[], elisions: readonly string[]): string =>
      `${JSON.stringify({ ready: kept.map((e) => e.row.id), elided: [...elisions] })}\n`;

    for (const budget of [0, 1, 2, 5]) {
      it(`budget=${budget}: stays parseable`, () => {
        const entries = entriesFor(5);
        const result = renderReadyWithBudget(entries, jsonRender, budget, "json");
        expect(() => JSON.parse(result.text)).not.toThrow();
        const parsed = JSON.parse(result.text) as { ready: string[]; elided: string[] };
        expect(parsed.ready).toEqual([]);
        expect(parsed.elided.length).toBeGreaterThan(0);
      });
    }

    it("defaults to text-mode (raw-slice) behavior when format is omitted, for backward compatibility", () => {
      const entries = entriesFor(2);
      const result = renderReadyWithBudget(entries, jsonRender, 1);
      expect(result.text.length).toBeLessThanOrEqual(1);
    });
  });
});
