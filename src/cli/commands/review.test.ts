import { describe, expect, it } from "vitest";
import { fixedClock } from "../../core/clock.js";
import { newSessionId, newTicketId, ticketSchema } from "../../core/index.js";
import type { Ticket } from "../../core/index.js";
import { buildReviewedTicket } from "./review.js";

const actor = { name: "ryan", kind: "human" } as const;

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
    provenance: { method: "new", created_by: actor },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

describe("buildReviewedTicket", () => {
  const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

  it("moves state to review and sets review.requested_at/by", () => {
    const ticket = makeTicket();
    const reviewed = buildReviewedTicket(ticket, "https://example.com/pr/1", actor, clock);
    expect(reviewed.state).toBe("review");
    expect(reviewed.review).toEqual({
      mr: "https://example.com/pr/1",
      requested_at: "2026-07-23T12:00:00.000Z",
      by: actor,
    });
  });

  it("review.mr is undefined (not a URL) when no --mr was given — D15 required-with-warning", () => {
    const ticket = makeTicket();
    const reviewed = buildReviewedTicket(ticket, undefined, actor, clock);
    expect(reviewed.state).toBe("review");
    expect(reviewed.review?.mr).toBeUndefined();
  });

  it("bumps last_activity_at/updated_at", () => {
    const ticket = makeTicket({ last_activity_at: "2020-01-01T00:00:00.000Z" });
    const reviewed = buildReviewedTicket(ticket, undefined, actor, clock);
    expect(reviewed.last_activity_at).toBe("2026-07-23T12:00:00.000Z");
    expect(reviewed.updated_at).toBe("2026-07-23T12:00:00.000Z");
  });

  it("leaves active_session untouched — review does not end the session (DECISIONS.md's C3 entry)", () => {
    const ticket = makeTicket();
    const reviewed = buildReviewedTicket(ticket, undefined, actor, clock);
    expect(reviewed.active_session).toBe(ticket.active_session);
  });
});
