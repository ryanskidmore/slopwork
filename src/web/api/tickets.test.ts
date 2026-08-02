import type { BunRequest } from "bun";
import { describe, expect, it } from "vitest";
import type { Config, Ticket, TicketId } from "../../core/index.js";
import { newTicketId, shortTicketCode, ticketSchema } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import type { TicketListResponseDTO } from "./types.js";
import { DEFAULT_TICKET_PAGE_SIZE, handleTicketList, MAX_TICKET_PAGE_SIZE } from "./tickets.js";

const config: Config = {
  project: "pagination-test",
  remotes: {},
  defaults: { stale_after: "60m", review_stale_after: "24h", lock_timeout: "5s" },
  backend: "flatfile",
};

function makeTicket(index: number, overrides: Record<string, unknown> = {}): Ticket {
  const id = newTicketId();
  return ticketSchema.parse({
    id,
    name: `Ticket ${String(index).padStart(4, "0")}`,
    slug: `ticket-${index}`,
    spec: { summary: `Summary ${index}` },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "test", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
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
): Promise<{ response: Response; body: TicketListResponseDTO }> {
  const response = await handleTicketList(
    new Request(`http://localhost/api/tickets${query}`) as BunRequest,
    dataSource(tickets),
    Date.parse("2026-07-23T12:00:00.000Z"),
  );
  return { response, body: (await response.json()) as TicketListResponseDTO };
}

describe("GET /api/tickets pagination", () => {
  it("bounds an unparameterized request while preserving total compatibility", async () => {
    const tickets = Array.from({ length: 5_000 }, (_, index) => makeTicket(index));
    const { response, body } = await request(tickets);

    expect(response.status).toBe(200);
    expect(body.total).toBe(5_000);
    expect(body.tickets).toHaveLength(DEFAULT_TICKET_PAGE_SIZE);
    expect(body.pagination).toEqual({
      page: 1,
      limit: DEFAULT_TICKET_PAGE_SIZE,
      filtered_total: 5_000,
      total_pages: 100,
      previous_page: null,
      next_page: 2,
    });
  });

  it.each(["?page=0", "?page=-1", "?page=1.5", "?page=nope", "?limit=0", "?limit=1.5"])(
    "rejects invalid pagination: %s",
    async (query) => {
      const { response } = await request([makeTicket(1)], query);
      expect(response.status).toBe(400);
    },
  );

  it("enforces the maximum page size", async () => {
    const tickets = Array.from({ length: MAX_TICKET_PAGE_SIZE + 1 }, (_, index) =>
      makeTicket(index),
    );
    const { response } = await request(tickets, `?limit=${MAX_TICKET_PAGE_SIZE + 1}`);
    expect(response.status).toBe(400);
  });

  it("returns every row exactly once in stable order across bounded pages", async () => {
    const tickets = Array.from({ length: 237 }, (_, index) =>
      makeTicket(index, {
        // Seven repeated activity buckets exercise both the primary clock
        // order and the id tie-break across page boundaries.
        last_activity_at: `2026-07-${String((index % 7) + 1).padStart(2, "0")}T10:00:00.000Z`,
      }),
    );
    const returnedIds: string[] = [];
    let page = 1;

    while (true) {
      const { body } = await request(tickets, `?page=${page}&limit=${MAX_TICKET_PAGE_SIZE}`);
      expect(body.tickets.length).toBeLessThanOrEqual(MAX_TICKET_PAGE_SIZE);
      returnedIds.push(...body.tickets.map((ticket) => ticket.id));
      if (body.pagination.next_page === null) break;
      page = body.pagination.next_page;
    }

    const expected = [...tickets]
      .sort((a, b) => {
        const activity = b.last_activity_at.localeCompare(a.last_activity_at);
        return activity !== 0 ? activity : a.id.localeCompare(b.id);
      })
      .map((ticket) => ticket.id);
    expect(returnedIds).toEqual(expected);
    expect(new Set(returnedIds).size).toBe(tickets.length);
  });

  it("applies filters before slicing and reports the filtered total", async () => {
    const tickets = Array.from({ length: 240 }, (_, index) =>
      makeTicket(index, { state: index % 3 === 0 ? "done" : "open" }),
    );
    const { body } = await request(tickets, "?state=done&page=2&limit=25");

    expect(body.total).toBe(240);
    expect(body.pagination.filtered_total).toBe(80);
    expect(body.pagination.total_pages).toBe(4);
    expect(body.tickets).toHaveLength(25);
    expect(body.tickets.every((ticket) => ticket.state === "done")).toBe(true);
  });

  it("supports bounded server-side lookup by full id and short handle", async () => {
    const tickets = Array.from({ length: 120 }, (_, index) => makeTicket(index));
    const target = tickets[73];
    if (!target) throw new Error("test fixture index out of bounds");

    for (const query of [target.id, shortTicketCode(target.id)]) {
      const { body } = await request(tickets, `?q=${encodeURIComponent(query)}&limit=20`);
      expect(body.pagination.filtered_total).toBe(1);
      expect(body.tickets.map((ticket) => ticket.id)).toEqual([target.id]);
    }
  });
});
