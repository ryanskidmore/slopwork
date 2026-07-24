import { describe, expect, it } from "vitest";
import { renderEntriesWithBudget, renderJsonBodyWithBudget } from "./budget.js";

// Format-agnostic renderer used by every test below: JSON-shaped so the
// "never corrupt JSON" assertions can actually parse it, and so text-mode
// assertions can check plain length/content too.
function jsonRender<T>(kept: readonly T[], elisions: readonly string[]): string {
  return `${JSON.stringify({ ids: kept, elided: [...elisions] })}\n`;
}

describe("renderEntriesWithBudget", () => {
  it("returns the full render unchanged when no budget is given", () => {
    const entries = [1, 2, 3];
    const result = renderEntriesWithBudget(entries, jsonRender, undefined);
    expect(result.withinBudget).toBe(true);
    expect(result.elisions).toEqual([]);
    expect(result.text).toBe(jsonRender(entries, []));
  });

  it("returns the full render unchanged when it already fits the budget", () => {
    const entries = [1, 2, 3];
    const full = jsonRender(entries, []);
    const result = renderEntriesWithBudget(entries, jsonRender, full.length);
    expect(result.text).toBe(full);
    expect(result.elisions).toEqual([]);
  });

  it("elides trailing (least important) entries one at a time until it fits", () => {
    const entries = [1, 2, 3, 4, 5];
    const full = jsonRender(entries, []);
    const budget = full.length - 1;
    const result = renderEntriesWithBudget(entries, jsonRender, budget, { noun: "ticket" });
    expect(result.withinBudget).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(budget);
    expect(result.elisions).toHaveLength(1);
    expect(result.elisions[0]).toMatch(/omitted to fit --budget/);
    expect(result.elisions[0]).toMatch(/ticket\(s\)/);
  });

  describe('format: "text" — a raw slice is a safe last resort', () => {
    it("never returns text longer than budgetChars, even for a pathologically tiny budget", () => {
      const entries = [1, 2];
      const result = renderEntriesWithBudget(entries, jsonRender, 1, { format: "text" });
      expect(result.text.length).toBeLessThanOrEqual(1);
      expect(result.withinBudget).toBe(true);
    });

    it("handles budgetChars: 0 by returning an empty string", () => {
      const entries = [1];
      const result = renderEntriesWithBudget(entries, jsonRender, 0, { format: "text" });
      expect(result.text).toBe("");
      expect(result.withinBudget).toBe(true);
    });
  });

  describe('format: "json" — never a corrupt slice, even at budget 0/1', () => {
    // This is the E1 defect fix, generalized: B4 adversarial review found
    // `ready --json --budget <tiny>` could emit invalid JSON on exit 0.
    for (const budget of [0, 1, 2, 5]) {
      it(`budget=${budget}: the floor is the valid empty-entries envelope, never a corrupt slice`, () => {
        const entries = [1, 2, 3, 4, 5];
        const result = renderEntriesWithBudget(entries, jsonRender, budget, { format: "json" });
        // Always parseable — the hard requirement.
        expect(() => JSON.parse(result.text)).not.toThrow();
        const parsed = JSON.parse(result.text) as { ids: number[]; elided: string[] };
        expect(parsed.ids).toEqual([]);
        expect(parsed.elided.length).toBeGreaterThan(0);
        // A budget this tiny can't actually be met by valid JSON — honestly
        // reported as such, not silently violated by corrupting output.
        expect(result.withinBudget).toBe(false);
      });
    }

    it("still fits a real (non-pathological) budget exactly, same as text mode", () => {
      // Entries big enough (fake 26-char-ish ids) that dropping a few
      // meaningfully shrinks the render even after accounting for the
      // elision note's own overhead (with tiny entries like `[1,2,3]`, the
      // note text can outweigh what a single dropped digit saves — a
      // property of THIS render function's verbosity, not of the budget
      // helper itself; see the "elides trailing entries" test above for
      // that shape instead, where it doesn't matter because it's only
      // asserting "some elision happened", not a specific fit).
      const entries = Array.from({ length: 10 }, (_, i) => `ticket_${String(i).padStart(20, "0")}`);
      const full = jsonRender(entries, []);
      expect(full.length).toBe(322); // pinned so `budget` below is a known-achievable fit
      const budget = 300;
      const result = renderEntriesWithBudget(entries, jsonRender, budget, { format: "json" });
      expect(result.withinBudget).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(budget);
      expect(() => JSON.parse(result.text)).not.toThrow();
      const parsed = JSON.parse(result.text) as { ids: string[] };
      expect(parsed.ids.length).toBeLessThan(entries.length);
      expect(parsed.ids.length).toBeGreaterThan(0);
    });

    it("handles an empty entries list with a tiny budget without corrupting anything", () => {
      const result = renderEntriesWithBudget([], jsonRender, 0, { format: "json" });
      expect(() => JSON.parse(result.text)).not.toThrow();
    });
  });

  it("handles an empty entries list with a generous budget (no elision needed)", () => {
    const result = renderEntriesWithBudget([], jsonRender, 100);
    expect(JSON.parse(result.text)).toEqual({ ids: [], elided: [] });
    expect(result.elisions).toEqual([]);
  });
});

describe("renderJsonBodyWithBudget", () => {
  it("returns the first (most-complete) candidate when it already fits", () => {
    const result = renderJsonBodyWithBudget([() => ({ full: true, data: "x".repeat(50) })], 1000);
    expect(result.withinBudget).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ full: true, data: "x".repeat(50) });
  });

  it("falls through the ladder to the first candidate that fits", () => {
    const candidates = [
      () => ({ size: "full", data: "x".repeat(200) }),
      () => ({ size: "medium", data: "x".repeat(50) }),
      () => ({ size: "minimal" }),
    ];
    const full = `${JSON.stringify(candidates[0]?.(), null, 2)}\n`;
    const medium = `${JSON.stringify(candidates[1]?.(), null, 2)}\n`;
    const result = renderJsonBodyWithBudget(candidates, medium.length);
    expect(result.withinBudget).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(medium.length);
    expect(result.text.length).toBeLessThan(full.length);
  });

  it("never returns a corrupt slice: even when EVERY candidate exceeds budget, the last (minimal) candidate's valid JSON is returned as-is", () => {
    const candidates: Array<() => Record<string, unknown>> = [
      () => ({ size: "full", data: "x".repeat(200) }),
      () => ({ id: "ticket_x" }), // the guaranteed-minimal floor
    ];
    for (const budget of [0, 1, 2]) {
      const result = renderJsonBodyWithBudget(candidates, budget);
      expect(() => JSON.parse(result.text)).not.toThrow();
      expect(result.withinBudget).toBe(false);
      expect(result.body).toEqual({ id: "ticket_x" });
    }
  });

  it("with no budget given, returns the first (most-complete) candidate", () => {
    const candidates: Array<() => Record<string, unknown>> = [
      () => ({ full: true }),
      () => ({ minimal: true }),
    ];
    const result = renderJsonBodyWithBudget(candidates, undefined);
    expect(result.body).toEqual({ full: true });
    expect(result.withinBudget).toBe(true);
  });
});
