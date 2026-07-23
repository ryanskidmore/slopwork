import { describe, expect, it } from "vitest";
import { fixedClock } from "../core/clock.js";
import { newSessionId, newTicketId, sessionSchema, ticketSchema } from "../core/index.js";
import type { Session, Ticket } from "../core/index.js";
import { assertStoppable, buildStoppedSession, buildStoppedTicket } from "./stop.js";

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

describe("assertStoppable", () => {
  it("refuses a ticket with no active session, exit CONFLICT (6)", () => {
    const ticket = makeTicket({ state: "open", active_session: null });
    expect(() => assertStoppable(ticket)).toThrow(/no active session/i);
    try {
      assertStoppable(ticket);
    } catch (err) {
      expect((err as { exitCode?: number }).exitCode).toBe(6);
    }
  });

  it("allows a ticket with an active session", () => {
    expect(() => assertStoppable(makeTicket())).not.toThrow();
  });
});

describe("buildStoppedSession", () => {
  const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

  it("sets ended_at and end_summary from the note", () => {
    const session = makeSession();
    const stopped = buildStoppedSession(session, "handed off, tests green", clock);
    expect(stopped.ended_at).toBe("2026-07-23T12:00:00.000Z");
    expect(stopped.end_summary).toBe("handed off, tests green");
  });

  it("end_summary is null when no note was given", () => {
    const session = makeSession();
    const stopped = buildStoppedSession(session, undefined, clock);
    expect(stopped.end_summary).toBeNull();
  });

  it("does not touch transcript_ref — that seam is C4's, not stop's", () => {
    const session = makeSession({ transcript_ref: null });
    const stopped = buildStoppedSession(session, "note", clock);
    expect(stopped.transcript_ref).toBeNull();
  });
});

describe("buildStoppedTicket", () => {
  const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

  it("returns the ticket to open and clears active_session", () => {
    const ticket = makeTicket();
    const stopped = buildStoppedTicket(ticket, "note", clock);
    expect(stopped.state).toBe("open");
    expect(stopped.active_session).toBeNull();
  });

  it("sets latest_note from the handoff note when given", () => {
    const ticket = makeTicket({ latest_note: "old note" });
    const stopped = buildStoppedTicket(ticket, "new handoff note", clock);
    expect(stopped.latest_note).toBe("new handoff note");
  });

  it("leaves latest_note untouched when no note was given", () => {
    const ticket = makeTicket({ latest_note: "old note" });
    const stopped = buildStoppedTicket(ticket, undefined, clock);
    expect(stopped.latest_note).toBe("old note");
  });

  it("bumps last_activity_at/updated_at", () => {
    const ticket = makeTicket({ last_activity_at: "2020-01-01T00:00:00.000Z" });
    const stopped = buildStoppedTicket(ticket, undefined, clock);
    expect(stopped.last_activity_at).toBe("2026-07-23T12:00:00.000Z");
    expect(stopped.updated_at).toBe("2026-07-23T12:00:00.000Z");
  });
});
