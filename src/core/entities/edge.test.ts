import { describe, expect, it } from "vitest";
import { newTicketId } from "../ids.js";
import {
  EDGE_KIND_TO_TICKET_FIELD,
  EDGE_KINDS,
  edgeSchema,
  outgoingEdges,
  ticketEdgeFieldsSchema,
} from "./edge.js";

describe("edgeSchema", () => {
  it("accepts a local blocks edge", () => {
    const from = newTicketId();
    const to = newTicketId();
    expect(edgeSchema.safeParse({ from, to, kind: "blocks" }).success).toBe(true);
  });

  it("accepts a parent edge targeting an external ref", () => {
    const from = newTicketId();
    expect(edgeSchema.safeParse({ from, to: "jira:PROJ-123", kind: "parent" }).success).toBe(true);
  });

  it("rejects a non-parent edge targeting an external ref", () => {
    const from = newTicketId();
    for (const kind of ["blocks", "relates-to", "discovered-from"] as const) {
      expect(
        edgeSchema.safeParse({ from, to: "jira:PROJ-123", kind }).success,
        `${kind} should reject an external target`,
      ).toBe(false);
    }
  });

  it("rejects an unknown edge kind", () => {
    const from = newTicketId();
    const to = newTicketId();
    expect(edgeSchema.safeParse({ from, to, kind: "supersedes" }).success).toBe(false);
  });
});

describe("EDGE_KIND_TO_TICKET_FIELD", () => {
  it("covers every edge kind exactly once", () => {
    expect(Object.keys(EDGE_KIND_TO_TICKET_FIELD).sort()).toEqual([...EDGE_KINDS].sort());
  });

  it("maps the three plural kinds to their snake_case array field", () => {
    expect(EDGE_KIND_TO_TICKET_FIELD["relates-to"]).toBe("relates_to");
    expect(EDGE_KIND_TO_TICKET_FIELD["discovered-from"]).toBe("discovered_from");
    expect(EDGE_KIND_TO_TICKET_FIELD.blocks).toBe("blocks");
    expect(EDGE_KIND_TO_TICKET_FIELD.parent).toBe("parent");
  });
});

describe("outgoingEdges", () => {
  it("is empty for a root ticket with no edges", () => {
    const id = newTicketId();
    const fields = ticketEdgeFieldsSchema.parse({});
    expect(outgoingEdges({ id, ...fields })).toEqual([]);
  });

  it("emits one edge per parent/blocks/relates_to/discovered_from entry", () => {
    const id = newTicketId();
    const parent = newTicketId();
    const blocked = newTicketId();
    const related = newTicketId();
    const discoveredFrom = newTicketId();

    const fields = ticketEdgeFieldsSchema.parse({
      parent,
      blocks: [blocked],
      relates_to: [related],
      discovered_from: [discoveredFrom],
    });

    const edges = outgoingEdges({ id, ...fields });
    expect(edges).toHaveLength(4);
    expect(edges).toContainEqual({ from: id, to: parent, kind: "parent" });
    expect(edges).toContainEqual({ from: id, to: blocked, kind: "blocks" });
    expect(edges).toContainEqual({ from: id, to: related, kind: "relates-to" });
    expect(edges).toContainEqual({ from: id, to: discoveredFrom, kind: "discovered-from" });
  });

  it("emits multiple edges for a field with multiple entries", () => {
    const id = newTicketId();
    const a = newTicketId();
    const b = newTicketId();
    const fields = ticketEdgeFieldsSchema.parse({ blocks: [a, b] });
    const edges = outgoingEdges({ id, ...fields });
    expect(edges).toEqual([
      { from: id, to: a, kind: "blocks" },
      { from: id, to: b, kind: "blocks" },
    ]);
  });

  it("omits the parent edge entirely for a root ticket (no `parent` field)", () => {
    const id = newTicketId();
    const fields = ticketEdgeFieldsSchema.parse({});
    expect(fields.parent).toBeUndefined();
    expect(outgoingEdges({ id, ...fields }).some((e) => e.kind === "parent")).toBe(false);
  });
});
