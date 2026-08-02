/**
 * `GET /api/tickets` — ticket list + filters (feature parity with the old
 * `src/web/views/tickets.ts`): filterable by state/label/priority/owner
 * plus a free-text `q` against name/slug/summary, sorted most-recently-
 * active first (design.md D5 / ticket_01KY9S0172V8AYCYV9KWS6RC9P's
 * effective `last_activity_at`).
 */
import type { BunRequest } from "bun";
import { TICKET_STATES, type Ticket, type TicketId, type TicketState } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import {
  computeAwaitingInputByTicket,
  deriveEffectiveTickets,
  staleThresholdsFromConfig,
} from "../overlays.js";
import { configDto, jsonResponse, ticketSummaryDto } from "./shared.js";
import type { TicketListResponseDTO } from "./types.js";

function isTicketState(value: string): value is TicketState {
  return (TICKET_STATES as readonly string[]).includes(value);
}

interface Filters {
  state: string;
  label: string;
  priority: string;
  owner: string;
  q: string;
}

function matchesFilters(ticket: Ticket, filters: Filters): boolean {
  if (filters.state && ticket.state !== filters.state) return false;
  if (filters.label && !ticket.labels.includes(filters.label)) return false;
  if (filters.priority && String(ticket.priority) !== filters.priority) return false;
  if (filters.owner && (ticket.owner?.name ?? "") !== filters.owner) return false;
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    const haystack = `${ticket.name} ${ticket.slug} ${ticket.spec.summary}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export async function handleTicketList(
  req: BunRequest,
  dataSource: WebDataSource,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  const filters: Filters = {
    state: url.searchParams.get("state") ?? "",
    label: url.searchParams.get("label") ?? "",
    priority: url.searchParams.get("priority") ?? "",
    owner: url.searchParams.get("owner") ?? "",
    q: url.searchParams.get("q") ?? "",
  };
  if (filters.state && !isTicketState(filters.state)) filters.state = "";

  const [rawTickets, { config, warning }, events] = await Promise.all([
    dataSource.listTickets(),
    dataSource.getConfig(),
    dataSource.listEvents(),
  ]);
  // Effective last_activity_at/latest_note (overlays.ts's deriveEffectiveTickets doc) —
  // a lock-free `update --progress` note must show up here and reset staleness,
  // exactly like `slop show`/the ticket detail page.
  const tickets = deriveEffectiveTickets(rawTickets, events);
  const byId = new Map<TicketId, Ticket>(tickets.map((t) => [t.id, t]));
  const thresholds = staleThresholdsFromConfig(config);
  // G4 (t-jggg9): reuses the SAME whole-db event read already fetched
  // above for deriveEffectiveTickets — no second listEvents() call.
  const awaitingInputByTicket = computeAwaitingInputByTicket(events);

  const allLabels = [...new Set(tickets.flatMap((t) => t.labels))].sort();
  const allOwners = [
    ...new Set(tickets.map((t) => t.owner?.name).filter((n): n is string => !!n)),
  ].sort();

  const filtered = tickets
    .filter((t) => matchesFilters(t, filters))
    .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));

  const body: TicketListResponseDTO = {
    config: configDto(config, warning),
    tickets: filtered.map((t) =>
      ticketSummaryDto(t, tickets, byId, thresholds, config, now, awaitingInputByTicket),
    ),
    total: tickets.length,
    facets: { labels: allLabels, owners: allOwners, states: [...TICKET_STATES] },
  };
  return jsonResponse(body);
}
