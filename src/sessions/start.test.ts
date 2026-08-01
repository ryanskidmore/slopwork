import { describe, expect, it } from "vitest";
import { fixedClock } from "../core/clock.js";
import { newSessionId, newTicketId, sessionSchema, ticketSchema } from "../core/index.js";
import type { Session, Ticket } from "../core/index.js";
import {
  activeSessionConflictError,
  assertStartable,
  buildNewSession,
  buildStartedTicket,
  buildSupersededSession,
  describeActiveSession,
} from "./start.js";

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: "a-ticket",
    spec: { summary: "Do the thing" },
    state: "open",
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
    actor: { name: "prior-agent", kind: "agent" },
    harness: { kind: "opencode", session_id: null },
    git: { branch: "main", commit_at_start: "abc123" },
    started_at: "2026-07-23T08:00:00.000Z",
    ...overrides,
  });
}

describe("assertStartable (D13 + terminal states)", () => {
  it("refuses a draft, exit CONFLICT (6)", () => {
    expect(() => assertStartable(makeTicket({ state: "draft" }))).toThrow(/draft/i);
    try {
      assertStartable(makeTicket({ state: "draft" }));
    } catch (err) {
      expect((err as { exitCode?: number }).exitCode).toBe(6);
    }
  });

  it.each(["done", "dropped"] as const)(
    "refuses a terminal state '%s', exit CONFLICT (6)",
    (state) => {
      expect(() => assertStartable(makeTicket({ state }))).toThrow(/terminal/i);
    },
  );

  it.each(["open", "in_progress"] as const)("allows '%s'", (state) => {
    expect(() => assertStartable(makeTicket({ state }))).not.toThrow();
  });

  it("allows 'review' (D15's changes-requested re-entry)", () => {
    const reviewTicket = makeTicket({
      state: "review",
      review: { requested_at: "2026-07-23T09:00:00.000Z", by: { name: "ryan", kind: "human" } },
    });
    expect(() => assertStartable(reviewTicket)).not.toThrow();
  });
});

describe("buildNewSession", () => {
  it("builds a valid, freshly-started session with the given actor/harness/git", () => {
    const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));
    const ticket = makeTicket();
    const session = buildNewSession(
      {
        ticket: ticket.id,
        actor: { name: "ryan", kind: "human" },
        harness: { kind: "claude-code", session_id: "sess-123" },
        git: { branch: "main", commit_at_start: "deadbeef" },
      },
      clock,
    );
    expect(session.ticket).toBe(ticket.id);
    expect(session.started_at).toBe("2026-07-23T12:00:00.000Z");
    expect(session.ended_at).toBeNull();
    expect(session.plan).toEqual([]);
    expect(session.end_summary).toBeNull();
    expect(session.harness).toEqual({ kind: "claude-code", session_id: "sess-123" });
    expect(session.git).toEqual({ branch: "main", commit_at_start: "deadbeef" });
  });
});

describe("buildStartedTicket", () => {
  const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

  it("open -> in_progress: state changes, active_session set, not a re-entry", () => {
    const ticket = makeTicket({ state: "open" });
    const sessionId = newSessionId();
    const { ticket: next, stateChanged, reEntry } = buildStartedTicket(ticket, sessionId, clock);
    expect(next.state).toBe("in_progress");
    expect(next.active_session).toBe(sessionId);
    expect(stateChanged).toBe(true);
    expect(reEntry).toBe(false);
  });

  it("in_progress -> in_progress (takeover case): state unchanged, only active_session moves", () => {
    const oldSessionId = newSessionId();
    const ticket = makeTicket({ state: "in_progress", active_session: oldSessionId });
    const newId = newSessionId();
    const { ticket: next, stateChanged, reEntry } = buildStartedTicket(ticket, newId, clock);
    expect(next.state).toBe("in_progress");
    expect(next.active_session).toBe(newId);
    expect(stateChanged).toBe(false);
    expect(reEntry).toBe(false);
  });

  it("review -> in_progress: a D15 re-entry, review is cleared", () => {
    const ticket = makeTicket({
      state: "review",
      review: { requested_at: "2026-07-23T09:00:00.000Z", by: { name: "ryan", kind: "human" } },
    });
    const sessionId = newSessionId();
    const { ticket: next, stateChanged, reEntry } = buildStartedTicket(ticket, sessionId, clock);
    expect(next.state).toBe("in_progress");
    expect(next.review).toBeUndefined();
    expect(stateChanged).toBe(true);
    expect(reEntry).toBe(true);
  });

  it("bumps last_activity_at/updated_at to the clock's now", () => {
    const ticket = makeTicket({ state: "open", last_activity_at: "2020-01-01T00:00:00.000Z" });
    const { ticket: next } = buildStartedTicket(ticket, newSessionId(), clock);
    expect(next.last_activity_at).toBe("2026-07-23T12:00:00.000Z");
    expect(next.updated_at).toBe("2026-07-23T12:00:00.000Z");
  });
});

describe("buildSupersededSession (--takeover)", () => {
  it("ends the previous session with an end_summary naming who took over", () => {
    const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));
    const previous = makeSession();
    const ended = buildSupersededSession(previous, { name: "new-agent", kind: "agent" }, clock);
    expect(ended.ended_at).toBe("2026-07-23T12:00:00.000Z");
    expect(ended.end_summary).toContain("new-agent");
    expect(ended.end_summary).toContain("takeover");
  });
});

describe("activeSessionConflictError / describeActiveSession", () => {
  it("names the active actor/harness/since, and mentions --takeover", () => {
    const ticket = makeTicket({ name: "Ticket X" });
    const session = makeSession({ actor: { name: "busy-agent", kind: "agent" } });
    const err = activeSessionConflictError(ticket, session);
    expect(err.message).toContain("Ticket X");
    expect(err.message).toContain("busy-agent");
    expect(err.message).toContain(session.started_at);
    expect(err.message).toMatch(/--takeover/);
    expect(err.exitCode).toBe(6);
  });

  it("describeActiveSession renders actor/kind/harness/since", () => {
    const session = makeSession({
      actor: { name: "x", kind: "human" },
      harness: { kind: "codex", session_id: null },
    });
    const line = describeActiveSession(session);
    expect(line).toContain("x");
    expect(line).toContain("human");
    expect(line).toContain("codex");
    expect(line).toContain(session.started_at);
  });
});
