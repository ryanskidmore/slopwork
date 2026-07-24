import { describe, expect, it } from "vitest";
import { checkDoneEntry, checkDropEntry, checkReviewEntry, checkStateTransition } from "./state.js";

describe("checkStateTransition (design.md §2's state diagram)", () => {
  it("same-state is always a legal no-op, including on a terminal ticket", () => {
    for (const s of ["draft", "open", "in_progress", "review", "done", "dropped"] as const) {
      expect(checkStateTransition(s, s)).toEqual({ ok: true });
    }
  });

  it("allows ONLY D13's draft <-> open edges directly — every other §2 edge needs a dedicated command", () => {
    expect(checkStateTransition("draft", "open")).toEqual({ ok: true });
    expect(checkStateTransition("open", "draft")).toEqual({ ok: true });
  });

  // Adversarial-review fix: these four used to be legal directly via
  // `update --state` (the pre-fix `RAW_STATE_TRANSITIONS` table). Each is
  // now rejected because it needs session-lifecycle machinery this
  // generic, side-effect-free mutator doesn't have.
  it("rejects open -> in_progress: creating a session is `slop start`'s job, not update's", () => {
    const result = checkStateTransition("open", "in_progress");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/slop start/);
  });

  it("rejects in_progress -> open: ending the active session is `slop stop`'s job, not update's (the ORPHANING hole)", () => {
    const result = checkStateTransition("in_progress", "open");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/slop stop/);
  });

  it("rejects review -> in_progress: this is D15's changes-requested re-entry, which needs a FRESH session + a logged re_entry — `slop start`'s job, not update's (the unlogged-re-entry hole)", () => {
    const result = checkStateTransition("review", "in_progress");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/slop done|slop start/);
  });

  it("rejects \"-> dropped\" from every non-terminal state: finalizing the session + B4's cascade is `slop drop`'s job, not update's (the resurrection hole)", () => {
    for (const s of ["draft", "open", "in_progress", "review"] as const) {
      const result = checkStateTransition(s, "dropped");
      expect(result.ok, s).toBe(false);
      expect(result.reason, s).toMatch(/slop drop/);
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

  it("rejects skipping straight from draft to in_progress, naming `slop start` (the dedicated-command message, not the generic table one)", () => {
    const result = checkStateTransition("draft", "in_progress");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/slop start/);
  });

  it("rejects skipping straight from open to review-adjacent illegal shapes (e.g. draft -> dropped is fine, but open -> review is the dedicated-command case above, already covered)", () => {
    // Sanity check that a clearly-illegal, non-review/done edge is also caught.
    expect(checkStateTransition("in_progress", "draft").ok).toBe(false);
  });

  // Adversarial-review finding 6 (minor, C3 review): the terminal-state
  // check must run BEFORE the dedicated-command messages, so a genuinely
  // terminal ticket gets the accurate "terminal state" reason rather than
  // a misleading "use `slop review`/`slop done`/`slop start`/`slop drop`"
  // that implies the dedicated command would succeed from this state (it
  // wouldn't — checkReviewEntry/checkDoneEntry reject `done`/`dropped` too).
  describe("terminal-state check runs before the dedicated-command messages (ordering fix)", () => {
    it.each(["done", "dropped"] as const)(
      'update <%s-ticket> --state review names the terminal state, not "use slop review"',
      (s) => {
        const result = checkStateTransition(s, "review");
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/terminal state/);
        expect(result.reason).not.toMatch(/slop review/);
      },
    );

    // Only "dropped" -> "done" here (NOT "done" -> "done" — that's the
    // legal same-state no-op, a different case entirely, already covered
    // above in "same-state is always a legal no-op").
    it('update <dropped-ticket> --state done names the terminal state, not "use slop done"', () => {
      const result = checkStateTransition("dropped", "done");
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/terminal state/);
      expect(result.reason).not.toMatch(/slop done/);
    });

    // Only "done" -> "dropped" here, for the same same-state-no-op reason.
    it('update <done-ticket> --state dropped names the terminal state, not "use slop drop"', () => {
      const result = checkStateTransition("done", "dropped");
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/terminal state/);
      expect(result.reason).not.toMatch(/slop drop/);
    });

    it.each(["done", "dropped"] as const)(
      'update <%s-ticket> --state in_progress names the terminal state, not "use slop start"',
      (s) => {
        const result = checkStateTransition(s, "in_progress");
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/terminal state/);
        expect(result.reason).not.toMatch(/slop start/);
      },
    );
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
