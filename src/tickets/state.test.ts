import { describe, expect, it } from "vitest";
import { checkStateTransition } from "./state.js";

describe("checkStateTransition (design.md §2's state diagram)", () => {
  it("same-state is always a legal no-op", () => {
    for (const s of ["draft", "open", "in_progress", "review", "done", "dropped"] as const) {
      expect(checkStateTransition(s, s)).toEqual({ ok: true });
    }
  });

  it("allows the diagram's simple edges", () => {
    expect(checkStateTransition("draft", "open")).toEqual({ ok: true });
    expect(checkStateTransition("open", "draft")).toEqual({ ok: true });
    expect(checkStateTransition("open", "in_progress")).toEqual({ ok: true });
    expect(checkStateTransition("in_progress", "open")).toEqual({ ok: true });
    // review -> in_progress (changes-requested re-entry, D15) needs no
    // extra data (just clearing `review`), so it's directly legal here.
    expect(checkStateTransition("review", "in_progress")).toEqual({ ok: true });
  });

  it("dropped is legal from any non-terminal state", () => {
    for (const s of ["draft", "open", "in_progress", "review"] as const) {
      expect(checkStateTransition(s, "dropped").ok).toBe(true);
    }
  });

  it("rejects entering review from anywhere it would actually be a transition (not already review — same-state is the legal no-op case above)", () => {
    for (const s of ["draft", "open", "in_progress"] as const) {
      const result = checkStateTransition(s, "review");
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/slop review --mr/);
    }
  });

  it("rejects entering done from anywhere it would actually be a transition", () => {
    for (const s of ["draft", "open", "in_progress", "review"] as const) {
      const result = checkStateTransition(s, "done");
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/slop done/);
    }
  });

  it("rejects any transition out of a terminal state", () => {
    expect(checkStateTransition("done", "open").ok).toBe(false);
    expect(checkStateTransition("dropped", "open").ok).toBe(false);
  });

  it("rejects skipping straight from draft to in_progress", () => {
    const result = checkStateTransition("draft", "in_progress");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/illegal transition/);
  });

  it("rejects skipping straight from open to review-adjacent illegal shapes (e.g. draft -> dropped is fine, but open -> review is the dedicated-command case above, already covered)", () => {
    // Sanity check that a clearly-illegal, non-review/done edge is also caught by the table.
    expect(checkStateTransition("in_progress", "draft").ok).toBe(false);
  });
});
