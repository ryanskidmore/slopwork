import { describe, expect, it } from "vitest";
import type { Ticket, TicketState } from "../core/index.js";
import { newTicketId, ticketSchema } from "../core/index.js";
import { assertDraftable, assertUndraftable } from "./draft.js";

function makeTicket(state: TicketState, overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  const review =
    state === "review"
      ? { requested_at: "2026-07-23T10:00:00.000Z", by: { name: "ryan", kind: "human" as const } }
      : undefined;
  return ticketSchema.parse({
    id,
    name: "Ticket",
    slug: `ticket-${id.slice(-8).toLowerCase()}`,
    spec: { summary: "s" },
    state,
    review,
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

describe("assertDraftable", () => {
  it("allows open -> draft", () => {
    expect(() => assertDraftable(makeTicket("open"))).not.toThrow();
  });

  it("allows draft -> draft (idempotent no-op)", () => {
    expect(() => assertDraftable(makeTicket("draft"))).not.toThrow();
  });

  for (const state of ["in_progress", "review", "done", "dropped"] as const) {
    it(`rejects ${state} -> draft with a CONFLICT (exit 6)`, () => {
      expect(() => assertDraftable(makeTicket(state))).toThrowError(
        expect.objectContaining({ exitCode: 6 }),
      );
    });
  }
});

describe("assertUndraftable", () => {
  it("allows draft -> open", () => {
    expect(() => assertUndraftable(makeTicket("draft"))).not.toThrow();
  });

  it("allows open -> open (idempotent no-op)", () => {
    expect(() => assertUndraftable(makeTicket("open"))).not.toThrow();
  });

  it("rejects in_progress -> open (that's `stop`'s edge, not `undraft`'s)", () => {
    expect(() => assertUndraftable(makeTicket("in_progress"))).toThrowError(
      expect.objectContaining({ exitCode: 6 }),
    );
  });

  for (const state of ["review", "done", "dropped"] as const) {
    it(`rejects ${state} -> open with a CONFLICT (exit 6)`, () => {
      expect(() => assertUndraftable(makeTicket(state))).toThrowError(
        expect.objectContaining({ exitCode: 6 }),
      );
    });
  }
});
