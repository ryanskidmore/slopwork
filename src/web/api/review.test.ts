import type { BunRequest } from "bun";
import { describe, expect, it } from "vitest";
import type { Config, Ticket, TicketId } from "../../core/index.js";
import { newTicketId, ticketSchema } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import type { ReviewResponseDTO } from "./types.js";
import { handleReviewPanel } from "./review.js";
import { DEFAULT_COLLECTION_PAGE_SIZE, MAX_COLLECTION_PAGE_SIZE } from "./pagination.js";

const config: Config = {
  project: "review-pagination-test",
  remotes: {},
  defaults: { stale_after: "60m", review_stale_after: "24h", lock_timeout: "5s" },
  backend: "flatfile",
};

function reviewTicket(index: number, requestedAt: string): Ticket {
  const id = newTicketId();
  return ticketSchema.parse({
    id,
    name: `In review ${String(index).padStart(4, "0")}`,
    slug: `in-review-${index}`,
    spec: { summary: `Summary ${index}` },
    state: "review",
    review: { requested_at: requestedAt, by: { name: "reviewer", kind: "human" } },
    root_id: id,
    provenance: { method: "new", created_by: { name: "test", kind: "human" } },
    last_activity_at: requestedAt,
    created_at: requestedAt,
    updated_at: requestedAt,
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
): Promise<{ response: Response; body: ReviewResponseDTO }> {
  const response = await handleReviewPanel(
    new Request(`http://localhost/api/review${query}`) as BunRequest,
    dataSource(tickets),
    Date.parse("2026-07-23T12:00:00.000Z"),
  );
  return { response, body: (await response.json()) as ReviewResponseDTO };
}

describe("GET /api/review pagination", () => {
  it("bounds an unparameterized request to the default page size", async () => {
    const tickets = Array.from({ length: 220 }, (_, index) =>
      reviewTicket(index, `2026-07-${String((index % 20) + 1).padStart(2, "0")}T10:00:00.000Z`),
    );
    const { response, body } = await request(tickets);

    expect(response.status).toBe(200);
    expect(body.tickets).toHaveLength(DEFAULT_COLLECTION_PAGE_SIZE);
    expect(body.pagination).toEqual({
      page: 1,
      limit: DEFAULT_COLLECTION_PAGE_SIZE,
      total: 220,
      total_pages: Math.ceil(220 / DEFAULT_COLLECTION_PAGE_SIZE),
      previous_page: null,
      next_page: 2,
    });
  });

  it.each(["?page=0", "?page=-1", "?page=1.5", "?page=nope", "?limit=0", "?limit=1.5"])(
    "rejects invalid pagination: %s",
    async (query) => {
      const { response } = await request([reviewTicket(1, "2026-07-01T10:00:00.000Z")], query);
      expect(response.status).toBe(400);
    },
  );

  it("rejects a limit above the maximum", async () => {
    const tickets = Array.from({ length: MAX_COLLECTION_PAGE_SIZE + 1 }, (_, index) =>
      reviewTicket(index, "2026-07-01T10:00:00.000Z"),
    );
    const { response } = await request(tickets, `?limit=${MAX_COLLECTION_PAGE_SIZE + 1}`);
    expect(response.status).toBe(400);
  });

  it("returns every row exactly once in stable longest-waiting-first order across bounded pages", async () => {
    const tickets = Array.from({ length: 233 }, (_, index) =>
      // Repeated requested_at buckets exercise both the primary
      // longest-waiting-first clock and the id tiebreak across page
      // boundaries.
      reviewTicket(index, `2026-07-${String((index % 5) + 1).padStart(2, "0")}T10:00:00.000Z`),
    );
    const returnedIds: string[] = [];
    let page = 1;

    while (true) {
      const { body } = await request(tickets, `?page=${page}&limit=${MAX_COLLECTION_PAGE_SIZE}`);
      expect(body.tickets.length).toBeLessThanOrEqual(MAX_COLLECTION_PAGE_SIZE);
      returnedIds.push(...body.tickets.map((ticket) => ticket.id));
      if (body.pagination.next_page === null) break;
      page = body.pagination.next_page;
    }

    const expected = [...tickets]
      .sort((a, b) => {
        const requested = (a.review?.requested_at ?? "").localeCompare(
          b.review?.requested_at ?? "",
        );
        return requested !== 0 ? requested : a.id.localeCompare(b.id);
      })
      .map((ticket) => ticket.id);
    expect(returnedIds).toEqual(expected);
    expect(new Set(returnedIds).size).toBe(tickets.length);
  });
});
