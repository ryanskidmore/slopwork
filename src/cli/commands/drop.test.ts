import { describe, expect, it } from "vitest";
import { fixedClock } from "../../core/clock.js";
import { newSessionId, newTicketId, ticketSchema } from "../../core/index.js";
import type { Ticket } from "../../core/index.js";
import { buildDroppedTicket } from "./drop.js";

const actor = { name: "ryan", kind: "human" } as const;

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: "a-ticket",
    spec: { summary: "Do the thing" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: actor },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

describe("buildDroppedTicket", () => {
  const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

  it("moves state to dropped, sets latest_note from --reason, clears active_session", () => {
    const ticket = makeTicket({ state: "in_progress", active_session: newSessionId() });
    const dropped = buildDroppedTicket(ticket, "no longer needed", clock);
    expect(dropped.state).toBe("dropped");
    expect(dropped.latest_note).toBe("no longer needed");
    expect(dropped.active_session).toBeNull();
  });

  it("clears review when dropping a review-state ticket", () => {
    const ticket = makeTicket({
      state: "review",
      review: { requested_at: "2026-07-23T09:00:00.000Z", by: actor },
      active_session: newSessionId(),
    });
    const dropped = buildDroppedTicket(ticket, "wontdo", clock);
    expect(dropped.state).toBe("dropped");
    expect(dropped.review).toBeUndefined();
  });

  it("active_session stays null (harmless no-op) when dropping an open/draft ticket with nothing active", () => {
    const ticket = makeTicket({ state: "open", active_session: null });
    const dropped = buildDroppedTicket(ticket, "duplicate of another ticket", clock);
    expect(dropped.active_session).toBeNull();
  });

  it("bumps last_activity_at/updated_at", () => {
    const ticket = makeTicket({ last_activity_at: "2020-01-01T00:00:00.000Z" });
    const dropped = buildDroppedTicket(ticket, "reason", clock);
    expect(dropped.last_activity_at).toBe("2026-07-23T12:00:00.000Z");
    expect(dropped.updated_at).toBe("2026-07-23T12:00:00.000Z");
  });
});
