import { describe, expect, it } from "vitest";
import type { Ticket } from "../core/index.js";
import { newTicketId, ticketSchema, writeCanonical } from "../core/index.js";
import { validateEditedTicketText } from "./edit.js";

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: "a-ticket",
    spec: { summary: "s" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

describe("validateEditedTicketText", () => {
  it("accepts well-formed, schema-valid text unchanged", () => {
    const ticket = makeTicket();
    const result = validateEditedTicketText(writeCanonical(ticket), ticket.id);
    expect(result).toEqual({ ok: true, ticket });
  });

  it("accepts an edit that legitimately changes fields (other than id)", () => {
    const ticket = makeTicket({ priority: 2 });
    const edited = { ...ticket, priority: 0, name: "Renamed by hand" };
    const result = validateEditedTicketText(writeCanonical(edited), ticket.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ticket.priority).toBe(0);
      expect(result.ticket.name).toBe("Renamed by hand");
    }
  });

  it("rejects malformed JSONC with a location-bearing error", () => {
    const ticket = makeTicket();
    const result = validateEditedTicketText("{ this is not valid jsonc", ticket.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects text that fails schema validation, with a path:message per issue", () => {
    const ticket = makeTicket();
    const broken = { ...ticket, priority: 99 };
    const result = validateEditedTicketText(writeCanonical(broken), ticket.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((l) => l.includes("priority"))).toBe(true);
    }
  });

  it("rejects a changed id — a ticket's id is immutable", () => {
    const ticket = makeTicket();
    const otherId = newTicketId();
    const edited = { ...ticket, id: otherId };
    const result = validateEditedTicketText(writeCanonical(edited), ticket.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((l) => l.includes("id"))).toBe(true);
    }
  });
});
