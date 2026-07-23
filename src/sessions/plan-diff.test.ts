import { describe, expect, it } from "vitest";
import { planVersionSchema } from "../core/index.js";
import { diffPlanVersions, renderPlanDiffLines, summarizePlanDiff } from "./plan-diff.js";

function version(versionNumber: number, steps: { text: string; checked?: boolean }[]) {
  return planVersionSchema.parse({
    version: versionNumber,
    steps,
    created_at: "2026-07-23T10:00:00.000Z",
  });
}

describe("diffPlanVersions", () => {
  it("reports an unchanged step as kept, not moved, checked-state unchanged", () => {
    const v1 = version(1, [{ text: "step one" }]);
    const v2 = version(2, [{ text: "step one" }]);
    const diff = diffPlanVersions(v1, v2);
    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(2);
    expect(diff.entries).toEqual([
      {
        kind: "kept",
        text: "step one",
        beforeIndex: 0,
        afterIndex: 0,
        moved: false,
        checkedBefore: false,
        checkedAfter: false,
        checkedChanged: false,
      },
    ]);
  });

  it("reports an added step (present in after, not in before)", () => {
    const v1 = version(1, [{ text: "step one" }]);
    const v2 = version(2, [{ text: "step one" }, { text: "step two" }]);
    const diff = diffPlanVersions(v1, v2);
    expect(diff.entries).toContainEqual({ kind: "added", text: "step two", afterIndex: 1 });
  });

  it("reports a removed step (present in before, not in after)", () => {
    const v1 = version(1, [{ text: "step one" }, { text: "step two" }]);
    const v2 = version(2, [{ text: "step one" }]);
    const diff = diffPlanVersions(v1, v2);
    expect(diff.entries).toContainEqual({ kind: "removed", text: "step two", beforeIndex: 1 });
  });

  it("reports a checked-state change on a kept step", () => {
    const v1 = version(1, [{ text: "step one", checked: false }]);
    const v2 = version(2, [{ text: "step one", checked: true }]);
    const diff = diffPlanVersions(v1, v2);
    expect(diff.entries).toEqual([
      {
        kind: "kept",
        text: "step one",
        beforeIndex: 0,
        afterIndex: 0,
        moved: false,
        checkedBefore: false,
        checkedAfter: true,
        checkedChanged: true,
      },
    ]);
  });

  it("reports a reordered step as kept + moved", () => {
    const v1 = version(1, [{ text: "step a" }, { text: "step b" }]);
    const v2 = version(2, [{ text: "step b" }, { text: "step a" }]);
    const diff = diffPlanVersions(v1, v2);
    const a = diff.entries.find((e) => e.kind === "kept" && e.text === "step a");
    const b = diff.entries.find((e) => e.kind === "kept" && e.text === "step b");
    expect(a).toMatchObject({ beforeIndex: 0, afterIndex: 1, moved: true });
    expect(b).toMatchObject({ beforeIndex: 1, afterIndex: 0, moved: true });
  });

  it("matches duplicate step text in order, not fuzzily", () => {
    const v1 = version(1, [
      { text: "dup", checked: true },
      { text: "dup", checked: false },
    ]);
    const v2 = version(2, [{ text: "dup" }, { text: "dup" }, { text: "dup" }]);
    const diff = diffPlanVersions(v1, v2);
    const kept = diff.entries.filter((e) => e.kind === "kept");
    const added = diff.entries.filter((e) => e.kind === "added");
    expect(kept).toHaveLength(2);
    expect(added).toHaveLength(1);
    // First "dup" in after claims the first not-yet-claimed "dup" in
    // before (checked: true), second "dup" claims the second (checked:
    // false) — first-occurrence-order, not similarity-based.
    expect(kept[0]).toMatchObject({ beforeIndex: 0, afterIndex: 0, checkedBefore: true });
    expect(kept[1]).toMatchObject({ beforeIndex: 1, afterIndex: 1, checkedBefore: false });
  });

  it("the full v1->v2 acceptance-style diff: one added, one kept+checked, one unchanged", () => {
    const v1 = version(1, [{ text: "step one" }, { text: "step two" }]);
    const v2 = version(2, [
      { text: "step one", checked: true },
      { text: "step two" },
      { text: "step three" },
    ]);
    const diff = diffPlanVersions(v1, v2);
    expect(diff.entries).toHaveLength(3);
    expect(summarizePlanDiff(diff)).toBe("+1 added, 1 check-state changed");
  });
});

describe("summarizePlanDiff", () => {
  it("reports 'no step changes' when nothing changed", () => {
    const v1 = version(1, [{ text: "a" }]);
    const v2 = version(2, [{ text: "a" }]);
    expect(summarizePlanDiff(diffPlanVersions(v1, v2))).toBe("no step changes");
  });

  it("combines every kind of change into one summary", () => {
    const v1 = version(1, [
      { text: "keep-checked", checked: true },
      { text: "move-me" },
      { text: "gone" },
    ]);
    const v2 = version(2, [
      { text: "new-step" },
      { text: "move-me" },
      { text: "keep-checked", checked: false },
    ]);
    const summary = summarizePlanDiff(diffPlanVersions(v1, v2));
    expect(summary).toContain("added");
    expect(summary).toContain("removed");
    expect(summary).toContain("reordered");
    expect(summary).toContain("check-state changed");
  });
});

describe("renderPlanDiffLines", () => {
  it("renders one line per entry with git-diff-style markers", () => {
    const v1 = version(1, [{ text: "step one" }]);
    const v2 = version(2, [{ text: "step one", checked: true }, { text: "step two" }]);
    const lines = renderPlanDiffLines(diffPlanVersions(v1, v2));
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.startsWith("  ~") && l.includes("step one"))).toBe(true);
    expect(lines.some((l) => l.startsWith("  +") && l.includes("step two"))).toBe(true);
  });
});
