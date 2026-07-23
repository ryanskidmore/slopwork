import { describe, expect, it } from "vitest";
import { newTicketId } from "../ids.js";
import { TICKET_STATES, ticketSchema } from "./ticket.js";

function baseTicket() {
  const id = newTicketId();
  return {
    id,
    name: "Add auth provider",
    slug: "add-auth-provider",
    spec: { summary: "Add an auth provider" },
    state: "open" as const,
    root_id: id,
    provenance: { method: "new" as const, created_by: { name: "ryan", kind: "human" as const } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
  };
}

describe("ticketSchema — minimal ticket + defaults", () => {
  it("accepts a minimal open root ticket and fills in every default", () => {
    const input = baseTicket();
    const parsed = ticketSchema.parse(input);
    expect(parsed.priority).toBe(2);
    expect(parsed.labels).toEqual([]);
    expect(parsed.adhoc).toBe(false);
    expect(parsed.blocks).toEqual([]);
    expect(parsed.relates_to).toEqual([]);
    expect(parsed.discovered_from).toEqual([]);
    expect(parsed.parent).toBeUndefined();
    expect(parsed.path).toEqual([]);
    expect(parsed.active_session).toBeNull();
    expect(parsed.latest_note).toBeNull();
    expect(parsed.owner).toBeNull();
    expect(parsed.review).toBeUndefined();
  });

  it("covers all six stored states, and exactly those six", () => {
    expect(TICKET_STATES).toEqual(["draft", "open", "in_progress", "review", "done", "dropped"]);
  });
});

describe("ticketSchema — D5: blocked/stale are never fields on the schema", () => {
  it("has no `blocked` or `stale` key even when smuggled into the input", () => {
    const input = { ...baseTicket(), blocked: true, stale: true };
    const parsed = ticketSchema.parse(input);
    expect(parsed as Record<string, unknown>).not.toHaveProperty("blocked");
    expect(parsed as Record<string, unknown>).not.toHaveProperty("stale");
  });
});

describe("ticketSchema — review (D15: present iff state === review)", () => {
  it("rejects a non-review ticket that carries a review object", () => {
    const input = {
      ...baseTicket(),
      state: "open" as const,
      review: {
        requested_at: "2026-07-23T10:00:00.000Z",
        by: { name: "ryan", kind: "human" as const },
      },
    };
    expect(ticketSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a review-state ticket with no review object", () => {
    const input = { ...baseTicket(), state: "review" as const };
    expect(ticketSchema.safeParse(input).success).toBe(false);
  });

  it("accepts a review-state ticket with review.mr set", () => {
    const input = {
      ...baseTicket(),
      state: "review" as const,
      review: {
        mr: "https://example.com/mr/1",
        requested_at: "2026-07-23T10:00:00.000Z",
        by: { name: "ryan", kind: "human" as const },
      },
    };
    expect(ticketSchema.safeParse(input).success).toBe(true);
  });

  it("accepts a review-state ticket WITHOUT review.mr (D15: can enter review without an MR link)", () => {
    const input = {
      ...baseTicket(),
      state: "review" as const,
      review: {
        requested_at: "2026-07-23T10:00:00.000Z",
        by: { name: "ryan", kind: "human" as const },
      },
    };
    expect(ticketSchema.safeParse(input).success).toBe(true);
  });
});

describe("ticketSchema — priority (design.md §8.1 item 4)", () => {
  it("defaults to 2", () => {
    expect(ticketSchema.parse(baseTicket()).priority).toBe(2);
  });

  it("accepts the full 0-3 range", () => {
    for (const priority of [0, 1, 2, 3]) {
      expect(ticketSchema.safeParse({ ...baseTicket(), priority }).success).toBe(true);
    }
  });

  it("rejects out-of-range priorities", () => {
    expect(ticketSchema.safeParse({ ...baseTicket(), priority: -1 }).success).toBe(false);
    expect(ticketSchema.safeParse({ ...baseTicket(), priority: 4 }).success).toBe(false);
  });
});

describe("ticketSchema — parent (D1: local id or external ref)", () => {
  it("accepts a local ticket parent", () => {
    const parentId = newTicketId();
    expect(ticketSchema.safeParse({ ...baseTicket(), parent: parentId }).success).toBe(true);
  });

  it("accepts an external jira: parent (terminates the local tree)", () => {
    expect(ticketSchema.safeParse({ ...baseTicket(), parent: "jira:PROJ-123" }).success).toBe(true);
  });

  it("rejects a garbage parent ref", () => {
    expect(ticketSchema.safeParse({ ...baseTicket(), parent: "not-a-ref" }).success).toBe(false);
  });
});

describe("ticketSchema — slug", () => {
  it("rejects an uppercase or space-containing slug", () => {
    expect(ticketSchema.safeParse({ ...baseTicket(), slug: "Not A Slug" }).success).toBe(false);
  });
});
