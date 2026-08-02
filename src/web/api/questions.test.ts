import type { BunRequest } from "bun";
import { describe, expect, it } from "vitest";
import type { Config, Event, Ticket, TicketId } from "../../core/index.js";
import { newEventId, newTicketId, ticketSchema } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import type { QuestionsResponseDTO } from "./types.js";
import { handleQuestionsPanel } from "./questions.js";
import { DEFAULT_COLLECTION_PAGE_SIZE, MAX_COLLECTION_PAGE_SIZE } from "./pagination.js";

const config: Config = {
  project: "questions-pagination-test",
  remotes: {},
  defaults: { stale_after: "60m", review_stale_after: "24h", lock_timeout: "5s" },
  backend: "flatfile",
};

function makeTicket(index: number): Ticket {
  const id = newTicketId();
  return ticketSchema.parse({
    id,
    name: `Ticket ${String(index).padStart(4, "0")}`,
    slug: `ticket-${index}`,
    spec: { summary: `Summary ${index}` },
    state: "in_progress",
    root_id: id,
    provenance: { method: "new", created_by: { name: "test", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
  });
}

function askedEvent(ticketId: TicketId, index: number): Event {
  return {
    id: newEventId(),
    actor: { name: "agent-1", kind: "agent" },
    session: null,
    verb: "question.asked",
    entity: { kind: "ticket", id: ticketId },
    payload: { text: `Question ${index}?`, options: [] },
    at: new Date(Date.parse("2026-07-23T10:00:00.000Z") + index * 1_000).toISOString(),
  };
}

function dataSource(tickets: Ticket[], events: Event[]): WebDataSource {
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
      return { events, problems: [] };
    },
  };
}

async function request(
  tickets: Ticket[],
  events: Event[],
  query = "",
): Promise<{ response: Response; body: QuestionsResponseDTO }> {
  const response = await handleQuestionsPanel(
    new Request(`http://localhost/api/questions${query}`) as BunRequest,
    dataSource(tickets, events),
  );
  return { response, body: (await response.json()) as QuestionsResponseDTO };
}

describe("GET /api/questions pagination", () => {
  it("bounds an unparameterized request to the default page size, whole-inbox counts unaffected", async () => {
    // One ticket per question — every question is its own group, isolating
    // the page slice from the extra grouping-by-ticket bookkeeping.
    const tickets = Array.from({ length: 220 }, (_, index) => makeTicket(index));
    const events = tickets.map((ticket, index) => askedEvent(ticket.id, index));
    const { response, body } = await request(tickets, events);

    expect(response.status).toBe(200);
    expect(body.total_questions).toBe(220);
    expect(body.total_tickets).toBe(220);
    expect(body.groups).toHaveLength(DEFAULT_COLLECTION_PAGE_SIZE);
    expect(body.pagination).toEqual({
      page: 1,
      limit: DEFAULT_COLLECTION_PAGE_SIZE,
      total: 220,
      total_pages: Math.ceil(220 / DEFAULT_COLLECTION_PAGE_SIZE),
      previous_page: null,
      next_page: 2,
    });
  });

  it.each(["?page=0", "?limit=0", "?limit=1.5"])(
    "rejects invalid pagination: %s",
    async (query) => {
      const ticket = makeTicket(1);
      const { response } = await request([ticket], [askedEvent(ticket.id, 1)], query);
      expect(response.status).toBe(400);
    },
  );

  it("rejects a limit above the maximum", async () => {
    const tickets = Array.from({ length: MAX_COLLECTION_PAGE_SIZE + 1 }, (_, index) =>
      makeTicket(index),
    );
    const events = tickets.map((ticket, index) => askedEvent(ticket.id, index));
    const { response } = await request(tickets, events, `?limit=${MAX_COLLECTION_PAGE_SIZE + 1}`);
    expect(response.status).toBe(400);
  });

  it("returns every open question exactly once, oldest-asked-first, across bounded pages", async () => {
    const tickets = Array.from({ length: 233 }, (_, index) => makeTicket(index));
    const events = tickets.map((ticket, index) => askedEvent(ticket.id, index));
    const returnedIds: string[] = [];
    let page = 1;

    while (true) {
      const { body } = await request(
        tickets,
        events,
        `?page=${page}&limit=${MAX_COLLECTION_PAGE_SIZE}`,
      );
      expect(body.groups.length).toBeLessThanOrEqual(MAX_COLLECTION_PAGE_SIZE);
      for (const group of body.groups) {
        for (const question of group.questions) returnedIds.push(question.id);
      }
      if (body.pagination.next_page === null) break;
      page = body.pagination.next_page;
    }

    const expected = [...events].sort((a, b) => a.id.localeCompare(b.id)).map((event) => event.id);
    expect(returnedIds).toEqual(expected);
    expect(new Set(returnedIds).size).toBe(events.length);
  });
});
