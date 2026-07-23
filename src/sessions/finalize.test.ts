import { describe, expect, it } from "vitest";
import { fixedClock } from "../core/clock.js";
import { newSessionId, newTicketId, sessionSchema } from "../core/index.js";
import type { Session } from "../core/index.js";
import { buildFinalizedSession } from "./finalize.js";

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

describe("buildFinalizedSession", () => {
  const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

  it("sets ended_at and end_summary from the summary text", () => {
    const finalized = buildFinalizedSession(makeSession(), "shipped, MR merged", clock);
    expect(finalized.ended_at).toBe("2026-07-23T12:00:00.000Z");
    expect(finalized.end_summary).toBe("shipped, MR merged");
  });

  it("end_summary is null when summary is null (e.g. done with no --note)", () => {
    const finalized = buildFinalizedSession(makeSession(), null, clock);
    expect(finalized.end_summary).toBeNull();
  });

  it("does not touch transcript_ref — that's the caller's job, folding in C4's captureTranscript result", () => {
    const finalized = buildFinalizedSession(makeSession({ transcript_ref: null }), "note", clock);
    expect(finalized.transcript_ref).toBeNull();
  });

  it("leaves every other field on the session untouched", () => {
    const session = makeSession({ end_summary: null });
    const finalized = buildFinalizedSession(session, "wrap-up", clock);
    expect(finalized.id).toBe(session.id);
    expect(finalized.ticket).toBe(session.ticket);
    expect(finalized.actor).toEqual(session.actor);
    expect(finalized.harness).toEqual(session.harness);
    expect(finalized.started_at).toBe(session.started_at);
  });
});
