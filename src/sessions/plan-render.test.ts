import { describe, expect, it } from "vitest";
import { newSessionId, newTicketId, planVersionSchema, sessionSchema } from "../core/index.js";
import type { PlanVersion, Session } from "../core/index.js";
import {
  renderLatestPlanVersion,
  renderPlanHistory,
  renderSessionPlanSection,
} from "./plan-render.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return sessionSchema.parse({
    id: newSessionId(),
    ticket: newTicketId(),
    actor: { name: "agent-1", kind: "agent" },
    harness: { kind: "claude-code", session_id: null },
    git: { branch: "main", commit_at_start: "abc" },
    started_at: "2026-07-23T09:00:00.000Z",
    ...overrides,
  });
}

function makeVersion(version: number, steps: { text: string; checked?: boolean }[]): PlanVersion {
  return planVersionSchema.parse({
    version,
    steps,
    created_at: "2026-07-23T09:00:00.000Z",
  });
}

describe("renderLatestPlanVersion", () => {
  it("renders each step with a [x]/[ ] checkbox and the checked/total count", () => {
    const v = makeVersion(1, [{ text: "step one", checked: true }, { text: "step two" }]);
    const lines = renderLatestPlanVersion(v, 1).join("\n");
    expect(lines).toContain("1/2 checked");
    expect(lines).toContain("[x] step one");
    expect(lines).toContain("[ ] step two");
  });

  it("names the version and total version count", () => {
    const v = makeVersion(2, [{ text: "a" }]);
    const lines = renderLatestPlanVersion(v, 3).join("\n");
    expect(lines).toContain("v2 of 3");
  });

  it("handles an empty steps list", () => {
    const v = makeVersion(1, []);
    const lines = renderLatestPlanVersion(v, 1).join("\n");
    expect(lines).toContain("(no steps)");
    expect(lines).toContain("0/0 checked");
  });
});

describe("renderPlanHistory", () => {
  it("is empty for a single version (nothing to diff yet)", () => {
    const v1 = makeVersion(1, [{ text: "a" }]);
    expect(renderPlanHistory([v1])).toEqual([]);
  });

  it("is empty for zero versions", () => {
    expect(renderPlanHistory([])).toEqual([]);
  });

  it("renders one summary line per consecutive version pair", () => {
    const v1 = makeVersion(1, [{ text: "a" }]);
    const v2 = makeVersion(2, [{ text: "a" }, { text: "b" }]);
    const v3 = makeVersion(3, [{ text: "a", checked: true }, { text: "b" }]);
    const lines = renderPlanHistory([v1, v2, v3]);
    expect(lines.some((l) => l.includes("v1 -> v2") && l.includes("added"))).toBe(true);
    expect(lines.some((l) => l.includes("v2 -> v3") && l.includes("check-state changed"))).toBe(
      true,
    );
  });
});

describe("renderSessionPlanSection", () => {
  it("is empty when the session has no plan at all", () => {
    expect(renderSessionPlanSection(makeSession())).toEqual([]);
  });

  it("renders the latest version's checklist plus version history for a planned session", () => {
    const v1 = makeVersion(1, [{ text: "step one" }]);
    const v2 = makeVersion(2, [{ text: "step one", checked: true }, { text: "step two" }]);
    const session = makeSession({ plan: [v1, v2] });
    const lines = renderSessionPlanSection(session).join("\n");
    expect(lines).toContain("v2 of 2");
    expect(lines).toContain("[x] step one");
    expect(lines).toContain("[ ] step two");
    expect(lines).toContain("v1 -> v2");
  });
});
