import { describe, expect, it } from "vitest";
import type { Ticket } from "../core/index.js";
import { newTicketId, ticketSchema } from "../core/index.js";
import { TICKET_FIELDS, deepEqualJson, diffTicketPatch, fullFieldPatch } from "./patch.js";

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

describe("deepEqualJson", () => {
  it("compares primitives, arrays, and objects structurally", () => {
    expect(deepEqualJson(1, 1)).toBe(true);
    expect(deepEqualJson("a", "b")).toBe(false);
    expect(deepEqualJson([1, 2], [1, 2])).toBe(true);
    expect(deepEqualJson([1, 2], [2, 1])).toBe(false);
    expect(deepEqualJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqualJson({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqualJson(null, undefined)).toBe(false);
    expect(deepEqualJson(undefined, undefined)).toBe(true);
  });
});

describe("TICKET_FIELDS", () => {
  it("covers every top-level Ticket field with no duplicates", () => {
    expect(new Set(TICKET_FIELDS).size).toBe(TICKET_FIELDS.length);
    expect(TICKET_FIELDS).toContain("id");
    expect(TICKET_FIELDS).toContain("review");
    expect(TICKET_FIELDS).toContain("provenance");
    expect(TICKET_FIELDS).toContain("resolution");
    expect(TICKET_FIELDS.length).toBe(23);
  });
});

describe("diffTicketPatch", () => {
  it("emits a patch entry only for fields that actually changed", () => {
    const before = makeTicket({ priority: 2, name: "Before" });
    const after = { ...before, priority: 0 };
    const patch = diffTicketPatch(before, after, ["name", "priority"]);
    expect(patch).toEqual([{ path: ["priority"], value: 0 }]);
  });

  it("emits an undefined-value (delete) entry when a field is cleared", () => {
    const before = makeTicket({
      state: "review",
      review: { requested_at: "2026-07-23T10:00:00.000Z", by: { name: "ryan", kind: "human" } },
    });
    const after: Ticket = { ...before, state: "in_progress", review: undefined };
    const patch = diffTicketPatch(before, after, ["state", "review"]);
    expect(patch).toContainEqual({ path: ["state"], value: "in_progress" });
    expect(patch).toContainEqual({ path: ["review"], value: undefined });
  });

  it("emits nothing when nothing in the given field list changed", () => {
    const t = makeTicket();
    expect(diffTicketPatch(t, { ...t }, ["name", "priority", "labels"])).toEqual([]);
  });
});

describe("fullFieldPatch", () => {
  it("has exactly one entry per TICKET_FIELDS field", () => {
    const t = makeTicket();
    const patch = fullFieldPatch(t);
    expect(patch).toHaveLength(TICKET_FIELDS.length);
    expect(patch.map((p) => p.path[0]).sort()).toEqual([...TICKET_FIELDS].sort());
  });
});
