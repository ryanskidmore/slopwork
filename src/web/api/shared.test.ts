import { describe, expect, it } from "vitest";
import type { Config, Ticket } from "../../core/index.js";
import { newTicketId, ticketSchema } from "../../core/index.js";
import { staleThresholdsFromConfig } from "../overlays.js";
import { createTicketSummaryContext, ticketSummaryDto } from "./shared.js";

const config: Config = {
  project: "summary-performance",
  remotes: {},
  defaults: { stale_after: "60m", review_stale_after: "24h", lock_timeout: "5s" },
  backend: "flatfile",
};

function makeTicket(index: number): Ticket {
  const id = newTicketId();
  return ticketSchema.parse({
    id,
    name: `Ticket ${index}`,
    slug: `ticket-${index}`,
    spec: { summary: "summary" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "test", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
  });
}

describe("ticket summary context", () => {
  it("reads each ticket's blocks list once while summarizing a large snapshot", () => {
    const count = 8_192;
    const tickets = Array.from({ length: count }, (_, index) => makeTicket(index));
    let blocksReads = 0;

    for (let index = 0; index < tickets.length; index++) {
      const ticket = tickets[index];
      const target = tickets[(index + 1) % tickets.length];
      if (!ticket || !target) throw new Error("test fixture index out of bounds");
      const blocks = [target.id];
      Object.defineProperty(ticket, "blocks", {
        configurable: true,
        enumerable: true,
        get: () => {
          blocksReads++;
          return blocks;
        },
      });
    }

    const context = createTicketSummaryContext(
      tickets,
      staleThresholdsFromConfig(config),
      config,
      Date.parse("2026-07-23T12:00:00.000Z"),
      new Map(),
    );
    const summaries = tickets.map((ticket) => ticketSummaryDto(ticket, context));

    expect(summaries).toHaveLength(count);
    expect(summaries.every((summary) => summary.overlay.blocked_by.length === 1)).toBe(true);
    expect(blocksReads).toBe(count);
  });
});
