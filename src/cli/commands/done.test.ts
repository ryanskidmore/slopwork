import { describe, expect, it } from "vitest";
import { fixedClock } from "../../core/clock.js";
import { newSessionId, newTicketId, ticketSchema } from "../../core/index.js";
import type { Ticket } from "../../core/index.js";
import { buildDoneTicket } from "./done.js";

const actor = { name: "ryan", kind: "human" } as const;

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: "a-ticket",
    spec: { summary: "Do the thing" },
    state: "review",
    review: { requested_at: "2026-07-23T09:00:00.000Z", by: actor },
    active_session: newSessionId(),
    root_id: id,
    provenance: { method: "new", created_by: actor },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

describe("buildDoneTicket", () => {
  const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

  it("moves state to done and clears review + active_session", () => {
    const ticket = makeTicket();
    const done = buildDoneTicket(ticket, "shipped", clock);
    expect(done.state).toBe("done");
    expect(done.review).toBeUndefined();
    expect(done.active_session).toBeNull();
  });

  it("sets latest_note from --note when given", () => {
    const ticket = makeTicket({ latest_note: "old note" });
    const done = buildDoneTicket(ticket, "final note", clock);
    expect(done.latest_note).toBe("final note");
  });

  it("leaves latest_note untouched when no --note was given", () => {
    const ticket = makeTicket({ latest_note: "old note" });
    const done = buildDoneTicket(ticket, undefined, clock);
    expect(done.latest_note).toBe("old note");
  });

  it("bumps last_activity_at/updated_at", () => {
    const ticket = makeTicket({ last_activity_at: "2020-01-01T00:00:00.000Z" });
    const done = buildDoneTicket(ticket, undefined, clock);
    expect(done.last_activity_at).toBe("2026-07-23T12:00:00.000Z");
    expect(done.updated_at).toBe("2026-07-23T12:00:00.000Z");
  });
});
