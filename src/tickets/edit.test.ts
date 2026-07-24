import { describe, expect, it } from "vitest";
import type { Ticket } from "../core/index.js";
import {
  EXIT_CODES,
  newSessionId,
  newTicketId,
  ticketSchema,
  writeCanonical,
} from "../core/index.js";
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
    const result = validateEditedTicketText(writeCanonical(ticket), ticket);
    expect(result).toEqual({ ok: true, ticket });
  });

  it("accepts an edit that legitimately changes fields (other than id)", () => {
    const ticket = makeTicket({ priority: 2 });
    const edited = { ...ticket, priority: 0, name: "Renamed by hand" };
    const result = validateEditedTicketText(writeCanonical(edited), ticket);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ticket.priority).toBe(0);
      expect(result.ticket.name).toBe("Renamed by hand");
    }
  });

  it("rejects malformed JSONC with a location-bearing error", () => {
    const ticket = makeTicket();
    const result = validateEditedTicketText("{ this is not valid jsonc", ticket);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.exitCode).toBe(EXIT_CODES.USAGE_ERROR);
    }
  });

  it("rejects text that fails schema validation, with a path:message per issue", () => {
    const ticket = makeTicket();
    const broken = { ...ticket, priority: 99 };
    const result = validateEditedTicketText(writeCanonical(broken), ticket);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((l) => l.includes("priority"))).toBe(true);
      expect(result.exitCode).toBe(EXIT_CODES.USAGE_ERROR);
    }
  });

  it("rejects a changed id — a ticket's id is immutable", () => {
    const ticket = makeTicket();
    const otherId = newTicketId();
    const edited = { ...ticket, id: otherId };
    const result = validateEditedTicketText(writeCanonical(edited), ticket);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((l) => l.includes("id"))).toBe(true);
      expect(result.exitCode).toBe(EXIT_CODES.USAGE_ERROR);
    }
  });

  it("still allows the legitimate draft <-> open state edit", () => {
    const ticket = makeTicket({ state: "draft" });
    const edited = { ...ticket, state: "open" as const };
    const result = validateEditedTicketText(writeCanonical(edited), ticket);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ticket.state).toBe("open");
    }
  });

  it("rejects an out-of-order state edit (open -> done, skipping review)", () => {
    const ticket = makeTicket({ state: "open", active_session: null });
    const edited = { ...ticket, state: "done" as const };
    const result = validateEditedTicketText(writeCanonical(edited), ticket);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_CODES.CONFLICT);
      expect(result.errors.some((l) => l.includes("slop review") || l.includes("slop done"))).toBe(
        true,
      );
    }
  });

  it("rejects an out-of-order state edit that also skips the session-ending command (in_progress -> open)", () => {
    const sessionId = newSessionId();
    const ticket = makeTicket({ state: "in_progress", active_session: sessionId });
    const edited = { ...ticket, state: "open" as const };
    const result = validateEditedTicketText(writeCanonical(edited), ticket);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_CODES.CONFLICT);
      expect(result.errors.some((l) => l.includes("slop stop"))).toBe(true);
    }
  });

  it("rejects an incoherent edit: state done with active_session still set", () => {
    const sessionId = newSessionId();
    const ticket = makeTicket({ state: "done", active_session: null });
    // Hand-edit only touches active_session, leaving state alone — the
    // state-transition check (same-state no-op) can't catch this; the
    // dedicated active_session<->state coherence check must.
    const edited = { ...ticket, active_session: sessionId };
    const result = validateEditedTicketText(writeCanonical(edited), ticket);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_CODES.CONFLICT);
      expect(result.errors.some((l) => l.includes("active_session"))).toBe(true);
    }
  });

  it("rejects an incoherent edit: state in_progress with active_session cleared to null", () => {
    const sessionId = newSessionId();
    const ticket = makeTicket({ state: "in_progress", active_session: sessionId });
    const edited = { ...ticket, active_session: null };
    const result = validateEditedTicketText(writeCanonical(edited), ticket);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_CODES.CONFLICT);
      expect(result.errors.some((l) => l.includes("active_session"))).toBe(true);
    }
  });

  it("still allows a coherent content-only edit on an in_progress ticket", () => {
    const sessionId = newSessionId();
    const ticket = makeTicket({
      state: "in_progress",
      active_session: sessionId,
      priority: 2,
    });
    const edited = { ...ticket, priority: 0, name: "Renamed mid-session" };
    const result = validateEditedTicketText(writeCanonical(edited), ticket);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ticket.priority).toBe(0);
      expect(result.ticket.state).toBe("in_progress");
      expect(result.ticket.active_session).toBe(sessionId);
    }
  });
});
