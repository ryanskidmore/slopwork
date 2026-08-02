import type { BunRequest } from "bun";
import { describe, expect, it } from "vitest";
import type { Config, Ticket, TicketId } from "../../core/index.js";
import { newTicketId, ticketSchema } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import type { StaleResponseDTO } from "./types.js";
import { handleStalePanel } from "./stale.js";
import { DEFAULT_COLLECTION_PAGE_SIZE, MAX_COLLECTION_PAGE_SIZE } from "./pagination.js";

const config: Config = {
  project: "stale-pagination-test",
  remotes: {},
  defaults: { stale_after: "60m", review_stale_after: "24h", lock_timeout: "5s" },
  backend: "flatfile",
};

const NOW = Date.parse("2026-07-23T12:00:00.000Z");

function staleTicket(index: number, lastActivityAt: string): Ticket {
  const id = newTicketId();
  return ticketSchema.parse({
    id,
    name: `Stale ${String(index).padStart(4, "0")}`,
    slug: `stale-${index}`,
    spec: { summary: `Summary ${index}` },
    state: "in_progress",
    root_id: id,
    provenance: { method: "new", created_by: { name: "test", kind: "human" } },
    last_activity_at: lastActivityAt,
    created_at: lastActivityAt,
    updated_at: lastActivityAt,
  });
}

function dataSource(tickets: Ticket[]): WebDataSource {
  return {
    async getConfig() {
      return { config, warning: null };
    },
    async listTickets() {
      return tickets;
    },
    async findTicketByRef(ref: string) {
      return tickets.find((ticket) => ticket.id === ref || ticket.slug === ref) ?? null;
    },
    async listSessionsForTicket(_ticketId: TicketId) {
      return [];
    },
    async listEventsForTicket(_ticketId: TicketId) {
      return { events: [], problems: [] };
    },
    async listEvents() {
      return { events: [], problems: [] };
    },
  };
}

async function request(
  tickets: Ticket[],
  query = "",
): Promise<{ response: Response; body: StaleResponseDTO }> {
  const response = await handleStalePanel(
    new Request(`http://localhost/api/stale${query}`) as BunRequest,
    dataSource(tickets),
    NOW,
  );
  return { response, body: (await response.json()) as StaleResponseDTO };
}

// All idle well past the 60m in_progress threshold — days apart so each
// row gets a distinct `since`, exercising ordering across page boundaries.
function idleSince(index: number): string {
  const daysAgo = 10 + (index % 30);
  return new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

describe("GET /api/stale pagination", () => {
  it("bounds an unparameterized request to the default page size", async () => {
    const tickets = Array.from({ length: 210 }, (_, index) => staleTicket(index, idleSince(index)));
    const { response, body } = await request(tickets);

    expect(response.status).toBe(200);
    expect(body.rows).toHaveLength(DEFAULT_COLLECTION_PAGE_SIZE);
    expect(body.pagination).toEqual({
      page: 1,
      limit: DEFAULT_COLLECTION_PAGE_SIZE,
      total: 210,
      total_pages: Math.ceil(210 / DEFAULT_COLLECTION_PAGE_SIZE),
      previous_page: null,
      next_page: 2,
    });
  });

  it.each(["?page=0", "?limit=0", "?limit=1.5"])(
    "rejects invalid pagination: %s",
    async (query) => {
      const { response } = await request([staleTicket(1, idleSince(1))], query);
      expect(response.status).toBe(400);
    },
  );

  it("rejects a limit above the maximum", async () => {
    const tickets = Array.from({ length: MAX_COLLECTION_PAGE_SIZE + 1 }, (_, index) =>
      staleTicket(index, idleSince(index)),
    );
    const { response } = await request(tickets, `?limit=${MAX_COLLECTION_PAGE_SIZE + 1}`);
    expect(response.status).toBe(400);
  });

  it("returns every row exactly once in stable longest-idle-first order across bounded pages", async () => {
    const tickets = Array.from({ length: 241 }, (_, index) => staleTicket(index, idleSince(index)));
    const returnedIds: string[] = [];
    let page = 1;

    while (true) {
      const { body } = await request(tickets, `?page=${page}&limit=${MAX_COLLECTION_PAGE_SIZE}`);
      expect(body.rows.length).toBeLessThanOrEqual(MAX_COLLECTION_PAGE_SIZE);
      returnedIds.push(...body.rows.map((row) => row.ticket.id));
      if (body.pagination.next_page === null) break;
      page = body.pagination.next_page;
    }

    const expected = [...tickets]
      .sort((a, b) => {
        const since = a.last_activity_at.localeCompare(b.last_activity_at);
        return since !== 0 ? since : a.id.localeCompare(b.id);
      })
      .map((ticket) => ticket.id);
    expect(returnedIds).toEqual(expected);
    expect(new Set(returnedIds).size).toBe(tickets.length);
  });
});
