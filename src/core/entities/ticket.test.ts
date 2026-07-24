import { describe, expect, it } from "vitest";
import { newTicketId } from "../ids.js";
import { mrUrlSchema, RESOLUTION_MAX_LENGTH, TICKET_STATES, ticketSchema } from "./ticket.js";

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

// `resolution` (ticket_01KY9RWFGVDQNDH1XN43A0GH1M): optional, OMITTED
// entirely when absent (never null/"") so an existing ticket/fixture with
// no resolution parses byte-identically before and after this field's
// introduction — the same "smuggle it in, check it never sticks" style as
// the D5 blocked/stale test above, but the other way round: this key
// SHOULD be absent by default, and should round-trip when actually set.
describe("ticketSchema — resolution (optional, omitted when absent)", () => {
  it("has no `resolution` key at all when the input doesn't carry one", () => {
    const parsed = ticketSchema.parse(baseTicket());
    expect(parsed.resolution).toBeUndefined();
    expect(parsed as Record<string, unknown>).not.toHaveProperty("resolution");
  });

  it("round-trips a multi-line resolution", () => {
    const resolution = "## Findings\n\nRoot cause was X.\n\n- step one\n- step two\n\nFixed in Y.";
    const parsed = ticketSchema.parse({ ...baseTicket(), resolution });
    expect(parsed.resolution).toBe(resolution);
  });

  it("trims surrounding whitespace", () => {
    const parsed = ticketSchema.parse({ ...baseTicket(), resolution: "  padded body  \n" });
    expect(parsed.resolution).toBe("padded body");
  });

  it("rejects a blank (whitespace-only) resolution rather than silently storing it", () => {
    expect(ticketSchema.safeParse({ ...baseTicket(), resolution: "   " }).success).toBe(false);
  });

  it("rejects a resolution over the max length", () => {
    const tooLong = "x".repeat(RESOLUTION_MAX_LENGTH + 1);
    expect(ticketSchema.safeParse({ ...baseTicket(), resolution: tooLong }).success).toBe(false);
  });

  it("accepts a resolution right at the max length", () => {
    const atLimit = "x".repeat(RESOLUTION_MAX_LENGTH);
    expect(ticketSchema.safeParse({ ...baseTicket(), resolution: atLimit }).success).toBe(true);
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

// Stored-XSS regression (ticket_01KY93E2FG20KF5RVW7HRK9M7X): bare `z.url()`
// accepts javascript:/data:/vbscript: URLs — confirmed pre-fix by parsing
// each directly against `z.url()` (no `.refine` in the pipeline), which
// returns `success: true` for all three. `slop web`'s review views then
// rendered `review.mr` straight into a live `href`, so any of those schemes
// reaching a persisted ticket ran attacker JS the moment a human opened the
// review page — this is the schema-level half of the fix (the CLI's
// `review --mr` and the persisted-ticket schema share `mrUrlSchema`, per
// this schema's doc comment).
describe("mrUrlSchema — http(s)-only scheme allowlist", () => {
  it("rejects javascript:, data:, and vbscript: URLs", () => {
    expect(mrUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(mrUrlSchema.safeParse("data:text/html;base64,QQ==").success).toBe(false);
    expect(mrUrlSchema.safeParse("vbscript:msgbox(1)").success).toBe(false);
  });

  it("rejects those schemes case-insensitively", () => {
    expect(mrUrlSchema.safeParse("JavaScript:alert(1)").success).toBe(false);
  });

  it("still accepts http/https MR URLs (no regression on legitimate use)", () => {
    expect(mrUrlSchema.safeParse("https://github.com/org/repo/pull/123").success).toBe(true);
    expect(mrUrlSchema.safeParse("http://example.com/mr/1").success).toBe(true);
  });

  it("rejects a non-URL string (still delegates the base URL shape check to z.url())", () => {
    expect(mrUrlSchema.safeParse("not a url").success).toBe(false);
  });
});
