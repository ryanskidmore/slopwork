import { describe, expect, it } from "vitest";
import { checkDoneEntry, checkDropEntry, checkReviewEntry, checkStateTransition } from "./state.js";

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

describe("checkReviewEntry (C3: in_progress -> review, D15)", () => {
  it("legal only from in_progress", () => {
    expect(checkReviewEntry("in_progress")).toEqual({ ok: true });
  });

  it("rejects every other state, including review itself (no self-loop)", () => {
    for (const s of ["draft", "open", "review", "done", "dropped"] as const) {
      const result = checkReviewEntry(s);
      expect(result.ok, s).toBe(false);
      expect(result.reason, s).toBeDefined();
    }
  });

  it("review -> review names the no-self-loop rationale, not the generic terminal/illegal wording", () => {
    expect(checkReviewEntry("review").reason).toMatch(/already in "review"/);
  });

  it("terminal states (done/dropped) name themselves as terminal", () => {
    expect(checkReviewEntry("done").reason).toMatch(/terminal state/);
    expect(checkReviewEntry("dropped").reason).toMatch(/terminal state/);
  });
});

describe("checkDoneEntry (C3: review -> done, D15)", () => {
  it("legal only from review — NOT directly from in_progress (design.md §2's diagram has no such edge)", () => {
    expect(checkDoneEntry("review")).toEqual({ ok: true });
    expect(checkDoneEntry("in_progress").ok).toBe(false);
  });

  it("rejects every other state", () => {
    for (const s of ["draft", "open", "in_progress", "done", "dropped"] as const) {
      expect(checkDoneEntry(s).ok, s).toBe(false);
    }
  });

  it("in_progress -> done names the review-first rule, not a generic message", () => {
    expect(checkDoneEntry("in_progress").reason).toMatch(/reachable only from "review"/);
  });

  it("terminal states name themselves as terminal", () => {
    expect(checkDoneEntry("done").reason).toMatch(/terminal state/);
    expect(checkDoneEntry("dropped").reason).toMatch(/terminal state/);
  });
});

describe("checkDropEntry (C3: -> dropped, §2 'from anywhere')", () => {
  it("legal from every non-terminal state", () => {
    for (const s of ["draft", "open", "in_progress", "review"] as const) {
      expect(checkDropEntry(s), s).toEqual({ ok: true });
    }
  });

  it("rejects an already-terminal ticket — unlike checkStateTransition's same-state shortcut, this is NOT a no-op", () => {
    expect(checkDropEntry("done").ok).toBe(false);
    expect(checkDropEntry("dropped").ok).toBe(false);
    // Proves the divergence from checkStateTransition's generic same-state
    // convention this function deliberately does not reuse (module doc).
    expect(checkStateTransition("dropped", "dropped")).toEqual({ ok: true });
    expect(checkDropEntry("dropped").ok).toBe(false);
  });
});
