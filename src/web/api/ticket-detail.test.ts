import type { BunRequest } from "bun";
import { describe, expect, it } from "vitest";
import type { Config, Event, Session, Ticket, TicketId } from "../../core/index.js";
import {
  newEventId,
  newSessionId,
  newTicketId,
  sessionSchema,
  ticketSchema,
} from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import type { TicketDetailDTO } from "./types.js";
import {
  DEFAULT_DETAIL_EVENT_LIMIT,
  DEFAULT_DETAIL_SESSION_LIMIT,
  handleTicketDetail,
  MAX_DETAIL_EVENT_LIMIT,
  MAX_DETAIL_SESSION_LIMIT,
} from "./ticket-detail.js";

const config: Config = {
  project: "ticket-detail-pagination-test",
  remotes: {},
  defaults: { stale_after: "60m", review_stale_after: "24h", lock_timeout: "5s" },
  backend: "flatfile",
};

function makeTicket(): Ticket {
  const id = newTicketId();
  return ticketSchema.parse({
    id,
    name: "Large-collection ticket",
    slug: "large-collection-ticket",
    spec: { summary: "Has a lot of events and sessions" },
    state: "in_progress",
    root_id: id,
    provenance: { method: "new", created_by: { name: "test", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
  });
}

function makeEvent(ticketId: TicketId, index: number): Event {
  return {
    id: newEventId(),
    actor: { name: "agent-1", kind: "agent" },
    session: null,
    verb: "ticket.updated",
    entity: { kind: "ticket", id: ticketId },
    payload: { index },
    at: new Date(Date.parse("2026-07-23T10:00:00.000Z") + index * 1_000).toISOString(),
  };
}

function makeSession(ticketId: TicketId, index: number): Session {
  return sessionSchema.parse({
    id: newSessionId(),
    ticket: ticketId,
    actor: { name: "agent-1", kind: "agent" },
    harness: { kind: "claude-code", session_id: null },
    git: { branch: null, commit_at_start: null },
    started_at: new Date(Date.parse("2026-07-23T10:00:00.000Z") + index * 60_000).toISOString(),
  });
}

function dataSource(ticket: Ticket, events: Event[], sessions: Session[]): WebDataSource {
  return {
    async getConfig() {
      return { config, warning: null };
    },
    async listTickets() {
      return [ticket];
    },
    async findTicketByRef(ref: string) {
      return ref === ticket.id || ref === ticket.slug ? ticket : null;
    },
    async listSessionsForTicket(_ticketId: TicketId) {
      return sessions;
    },
    async listEventsForTicket(_ticketId: TicketId) {
      return { events, problems: [] };
    },
    async listEvents() {
      return { events, problems: [] };
    },
  };
}

function ticketDetailRequest(url: string, ref: string): BunRequest<"/api/tickets/:ref"> {
  // Bun's own router populates `.params` from the matched route pattern at
  // dispatch time (createWebServer's declarative `routes` table) — a plain
  // `new Request()` never goes through that, so tests drive the handler
  // directly need to stitch `.params` on themselves.
  return Object.assign(new Request(url), { params: { ref } }) as BunRequest<"/api/tickets/:ref">;
}

async function request(
  ticket: Ticket,
  events: Event[],
  sessions: Session[],
  query = "",
): Promise<{ response: Response; body: TicketDetailDTO }> {
  const response = await handleTicketDetail(
    ticketDetailRequest(`http://localhost/api/tickets/${ticket.id}${query}`, ticket.id),
    dataSource(ticket, events, sessions),
    Date.parse("2026-07-23T12:00:00.000Z"),
  );
  return { response, body: (await response.json()) as TicketDetailDTO };
}

describe("GET /api/tickets/:ref events/sessions pagination", () => {
  it("bounds the events timeline to the default page size and reports its own pagination", async () => {
    const ticket = makeTicket();
    const events = Array.from({ length: 180 }, (_, index) => makeEvent(ticket.id, index));
    const { response, body } = await request(ticket, events, []);

    expect(response.status).toBe(200);
    expect(body.events).toHaveLength(DEFAULT_DETAIL_EVENT_LIMIT);
    expect(body.event_pagination).toEqual({
      page: 1,
      limit: DEFAULT_DETAIL_EVENT_LIMIT,
      total: 180,
      total_pages: Math.ceil(180 / DEFAULT_DETAIL_EVENT_LIMIT),
      previous_page: null,
      next_page: 2,
    });
  });

  it("bounds the sessions timeline to its own default page size, independent of events", async () => {
    const ticket = makeTicket();
    const sessions = Array.from({ length: 90 }, (_, index) => makeSession(ticket.id, index));
    const { body } = await request(ticket, [], sessions);

    expect(body.sessions).toHaveLength(DEFAULT_DETAIL_SESSION_LIMIT);
    expect(body.session_pagination).toEqual({
      page: 1,
      limit: DEFAULT_DETAIL_SESSION_LIMIT,
      total: 90,
      total_pages: Math.ceil(90 / DEFAULT_DETAIL_SESSION_LIMIT),
      previous_page: null,
      next_page: 2,
    });
  });

  it("pages events and sessions independently via events_page/sessions_page", async () => {
    const ticket = makeTicket();
    const events = Array.from({ length: 120 }, (_, index) => makeEvent(ticket.id, index));
    const sessions = Array.from({ length: 60 }, (_, index) => makeSession(ticket.id, index));
    const { body } = await request(ticket, events, sessions, "?events_page=2&sessions_page=2");

    expect(body.event_pagination.page).toBe(2);
    expect(body.session_pagination.page).toBe(2);
    expect(body.events[0]?.id).toBe(
      [...events].sort((a, b) => a.id.localeCompare(b.id))[DEFAULT_DETAIL_EVENT_LIMIT]?.id,
    );
  });

  it.each([
    "?events_limit=0",
    "?events_page=nope",
    `?events_limit=${MAX_DETAIL_EVENT_LIMIT + 1}`,
    "?sessions_limit=0",
    `?sessions_limit=${MAX_DETAIL_SESSION_LIMIT + 1}`,
  ])("rejects invalid or over-limit timeline pagination: %s", async (query) => {
    const ticket = makeTicket();
    const { response } = await request(ticket, [], [], query);
    expect(response.status).toBe(400);
  });

  it("returns every event exactly once, oldest-first, across bounded pages", async () => {
    const ticket = makeTicket();
    const events = Array.from({ length: 233 }, (_, index) => makeEvent(ticket.id, index));
    const returnedIds: string[] = [];
    let page = 1;

    while (true) {
      const { body } = await request(
        ticket,
        events,
        [],
        `?events_page=${page}&events_limit=${MAX_DETAIL_EVENT_LIMIT}`,
      );
      expect(body.events.length).toBeLessThanOrEqual(MAX_DETAIL_EVENT_LIMIT);
      returnedIds.push(...body.events.map((event) => event.id));
      if (body.event_pagination.next_page === null) break;
      page = body.event_pagination.next_page;
    }

    const expected = [...events].sort((a, b) => a.id.localeCompare(b.id)).map((event) => event.id);
    expect(returnedIds).toEqual(expected);
    expect(new Set(returnedIds).size).toBe(events.length);
  });
});
