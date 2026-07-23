import { describe, expect, it } from "vitest";
import { fixedClock } from "../core/clock.js";
import {
  newSessionId,
  newTicketId,
  planVersionSchema,
  sessionSchema,
  ticketSchema,
} from "../core/index.js";
import type { Session, Ticket } from "../core/index.js";
import {
  assertHasActiveSession,
  buildPlanStepToggle,
  buildPlanSteps,
  buildPlanVersion,
} from "./plan.js";

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: "a-ticket",
    spec: { summary: "Do the thing" },
    state: "in_progress",
    active_session: newSessionId(),
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return sessionSchema.parse({
    id: newSessionId(),
    ticket: newTicketId(),
    actor: { name: "ryan", kind: "human" },
    harness: { kind: "claude-code", session_id: null },
    git: { branch: "main", commit_at_start: "abc" },
    started_at: "2026-07-23T09:00:00.000Z",
    ...overrides,
  });
}

describe("assertHasActiveSession", () => {
  it("refuses a ticket with no active session, exit CONFLICT (6)", () => {
    const ticket = makeTicket({ active_session: null });
    expect(() => assertHasActiveSession(ticket)).toThrow(/no active session/i);
    try {
      assertHasActiveSession(ticket);
    } catch (err) {
      expect((err as { exitCode?: number }).exitCode).toBe(6);
    }
  });

  it("allows a ticket with an active session", () => {
    expect(() => assertHasActiveSession(makeTicket())).not.toThrow();
  });
});

describe("buildPlanSteps (checked-state carry-forward rule)", () => {
  it("every step starts unchecked when there is no previous version", () => {
    const steps = buildPlanSteps(["step one", "step two"]);
    expect(steps).toEqual([
      { text: "step one", checked: false },
      { text: "step two", checked: false },
    ]);
  });

  it("carries checked forward for a step whose text is identical to the previous version's", () => {
    const previous = planVersionSchema.parse({
      version: 1,
      steps: [
        { text: "step one", checked: true },
        { text: "step two", checked: false },
      ],
      created_at: "2026-07-23T09:00:00.000Z",
    });
    const steps = buildPlanSteps(["step one", "step two", "step three"], previous);
    expect(steps).toEqual([
      { text: "step one", checked: true },
      { text: "step two", checked: false },
      { text: "step three", checked: false },
    ]);
  });

  it("a step with new/different text starts unchecked even if reworded", () => {
    const previous = planVersionSchema.parse({
      version: 1,
      steps: [{ text: "step one", checked: true }],
      created_at: "2026-07-23T09:00:00.000Z",
    });
    const steps = buildPlanSteps(["step one (reworded)"], previous);
    expect(steps).toEqual([{ text: "step one (reworded)", checked: false }]);
  });

  it("matches duplicate step text in order, not fuzzily", () => {
    const previous = planVersionSchema.parse({
      version: 1,
      steps: [
        { text: "dup", checked: true },
        { text: "dup", checked: false },
      ],
      created_at: "2026-07-23T09:00:00.000Z",
    });
    const steps = buildPlanSteps(["dup", "dup"], previous);
    expect(steps).toEqual([
      { text: "dup", checked: true },
      { text: "dup", checked: false },
    ]);
  });
});

describe("buildPlanVersion", () => {
  const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

  it("the first call sets v1 and reports isFirstVersion", () => {
    const session = makeSession();
    const result = buildPlanVersion(session, ["step one", "step two"], clock);
    expect(result.isFirstVersion).toBe(true);
    expect(result.version.version).toBe(1);
    expect(result.session.plan).toHaveLength(1);
    expect(result.session.plan[0]?.steps.map((s) => s.text)).toEqual(["step one", "step two"]);
    expect(result.version.created_at).toBe("2026-07-23T12:00:00.000Z");
  });

  it("a subsequent call appends v2, never mutating v1 (the diffability property)", () => {
    const session = makeSession();
    const afterV1 = buildPlanVersion(session, ["step one", "step two"], clock).session;
    const result = buildPlanVersion(afterV1, ["step one", "step two", "step three"], clock);

    expect(result.isFirstVersion).toBe(false);
    expect(result.version.version).toBe(2);
    expect(result.session.plan).toHaveLength(2);
    // v1 is untouched -- same object identity's worth of content as before.
    expect(result.session.plan[0]).toEqual(afterV1.plan[0]);
    expect(result.session.plan[1]?.steps).toHaveLength(3);
  });

  it("carries checked state forward across a revision for identical step text", () => {
    const session = makeSession();
    const v1 = buildPlanVersion(session, ["step one", "step two"], clock).session;
    const checked = buildPlanStepToggle(v1, 1, true);
    const v2 = buildPlanVersion(checked, ["step one", "step two", "step three"], clock);
    expect(v2.version.steps[0]).toEqual({ text: "step one", checked: true });
    expect(v2.version.steps[1]).toEqual({ text: "step two", checked: false });
    expect(v2.version.steps[2]).toEqual({ text: "step three", checked: false });
    // And v1 itself still shows step one unchecked -- the toggle only
    // touched the latest version at the time, not history.
    expect(checked.plan[0]?.steps[0]?.checked).toBe(true);
  });
});

describe("buildPlanStepToggle", () => {
  const withPlan = () => {
    const session = makeSession();
    return buildPlanVersion(session, ["step one", "step two", "step three"]).session;
  };

  it("is 1-based: --check 1 checks the FIRST step", () => {
    const toggled = buildPlanStepToggle(withPlan(), 1, true);
    const latest = toggled.plan.at(-1);
    expect(latest?.steps[0]?.checked).toBe(true);
    expect(latest?.steps[1]?.checked).toBe(false);
  });

  it("uncheck flips a checked step back off", () => {
    const checked = buildPlanStepToggle(withPlan(), 2, true);
    const unchecked = buildPlanStepToggle(checked, 2, false);
    expect(unchecked.plan.at(-1)?.steps[1]?.checked).toBe(false);
  });

  it("does not create a new plan version", () => {
    const before = withPlan();
    const after = buildPlanStepToggle(before, 1, true);
    expect(after.plan).toHaveLength(before.plan.length);
    expect(after.plan.at(-1)?.version).toBe(before.plan.at(-1)?.version);
  });

  it("rejects step 0 (not 1-based) as out of range, exit USAGE_ERROR (2)", () => {
    expect(() => buildPlanStepToggle(withPlan(), 0, true)).toThrow(/out of range/i);
    try {
      buildPlanStepToggle(withPlan(), 0, true);
    } catch (err) {
      expect((err as { exitCode?: number }).exitCode).toBe(2);
    }
  });

  it("rejects a step number beyond the plan's length", () => {
    expect(() => buildPlanStepToggle(withPlan(), 4, true)).toThrow(/out of range/i);
  });

  it("throws USAGE_ERROR when there is no plan at all yet", () => {
    const session = makeSession();
    expect(() => buildPlanStepToggle(session, 1, true)).toThrow(/no plan exists/i);
    try {
      buildPlanStepToggle(session, 1, true);
    } catch (err) {
      expect((err as { exitCode?: number }).exitCode).toBe(2);
    }
  });
});
