import { describe, expect, it } from "vitest";
import { newSessionId, newTicketId } from "../ids.js";
import { HARNESS_KINDS, planVersionSchema, sessionSchema } from "./session.js";

function baseSession() {
  return {
    id: newSessionId(),
    ticket: newTicketId(),
    actor: { name: "ryan", kind: "human" as const },
    harness: { kind: "claude-code" as const, session_id: "abc123" },
    git: { branch: "main", commit_at_start: "deadbeef" },
    started_at: "2026-07-23T10:00:00.000Z",
  };
}

describe("sessionSchema", () => {
  it("accepts a minimal freshly-started session and defaults the rest", () => {
    const parsed = sessionSchema.parse(baseSession());
    expect(parsed.ended_at).toBeNull();
    expect(parsed.plan).toEqual([]);
    expect(parsed.end_summary).toBeNull();
    expect(parsed.transcript_ref).toBeNull();
  });

  it("covers all 4 harness kinds, including the other fallback", () => {
    expect(HARNESS_KINDS).toEqual(["claude-code", "opencode", "codex", "other"]);
    for (const kind of HARNESS_KINDS) {
      const input = { ...baseSession(), harness: { kind, session_id: null } };
      expect(sessionSchema.safeParse(input).success).toBe(true);
    }
  });

  it("allows a null harness session_id (harness doesn't expose one)", () => {
    const input = { ...baseSession(), harness: { kind: "opencode" as const, session_id: null } };
    expect(sessionSchema.safeParse(input).success).toBe(true);
  });

  it("allows null git branch/commit (not a git repo)", () => {
    const input = { ...baseSession(), git: { branch: null, commit_at_start: null } };
    expect(sessionSchema.safeParse(input).success).toBe(true);
  });

  it("allows a null transcript_ref (§4.3: warn, never block)", () => {
    const input = { ...baseSession(), transcript_ref: null };
    expect(sessionSchema.safeParse(input).success).toBe(true);
  });

  it("rejects an unknown harness kind", () => {
    const input = { ...baseSession(), harness: { kind: "cursor", session_id: null } };
    expect(sessionSchema.safeParse(input).success).toBe(false);
  });
});

describe("plan versioning (C2: plan v2 diffable from v1)", () => {
  it("a session's plan is an ordered array of versions, each with its own steps", () => {
    const v1 = planVersionSchema.parse({
      version: 1,
      steps: [{ text: "step one" }, { text: "step two" }],
      created_at: "2026-07-23T10:00:00.000Z",
    });
    const v2 = planVersionSchema.parse({
      version: 2,
      steps: [{ text: "step one", checked: true }, { text: "step two" }, { text: "step three" }],
      created_at: "2026-07-23T11:00:00.000Z",
    });

    const session = sessionSchema.parse({ ...baseSession(), plan: [v1, v2] });
    expect(session.plan).toHaveLength(2);
    expect(session.plan[0]?.steps).toHaveLength(2);
    expect(session.plan[1]?.steps).toHaveLength(3);
    // v1 is untouched by v2 existing -- a genuine diffable history, not a
    // single mutated array.
    expect(session.plan[0]?.steps[0]?.checked).toBe(false);
    expect(session.plan[1]?.steps[0]?.checked).toBe(true);
  });

  it("a step defaults to unchecked", () => {
    expect(planVersionSchema.parse({ version: 1, created_at: "2026-07-23T10:00:00.000Z" })).toEqual(
      {
        version: 1,
        steps: [],
        created_at: "2026-07-23T10:00:00.000Z",
      },
    );
  });

  it("rejects a non-positive version number", () => {
    expect(
      planVersionSchema.safeParse({ version: 0, created_at: "2026-07-23T10:00:00.000Z" }).success,
    ).toBe(false);
  });
});
