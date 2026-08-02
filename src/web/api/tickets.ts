/**
 * `GET /api/tickets` — ticket list + filters (feature parity with the old
 * `src/web/views/tickets.ts`): filterable by state/label/priority/owner
 * plus a free-text `q` against name/slug/summary/id/handle. Filters are
 * applied before a validated, bounded `page`/`limit` slice (50 by default,
 * 100 maximum), sorted by effective `last_activity_at` descending and id
 * ascending as a deterministic tie-break.
 */
import type { BunRequest } from "bun";
import { shortTicketCode, TICKET_STATES, type Ticket, type TicketState } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import {
  computeAwaitingInputByTicket,
  deriveEffectiveTickets,
  staleThresholdsFromConfig,
} from "../overlays.js";
import {
  apiErrorResponse,
  configDto,
  createTicketSummaryContext,
  jsonResponse,
  ticketSummaryDto,
} from "./shared.js";
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

export const DEFAULT_TICKET_PAGE_SIZE = 50;
export const MAX_TICKET_PAGE_SIZE = 100;

interface PaginationInput {
  page: number;
  limit: number;
}

function parsePositiveInteger(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePagination(url: URL): PaginationInput | string {
  const page = parsePositiveInteger(url.searchParams.get("page"), 1);
  if (page === null) return 'query parameter "page" must be a positive integer';

  const limit = parsePositiveInteger(url.searchParams.get("limit"), DEFAULT_TICKET_PAGE_SIZE);
  if (limit === null) return 'query parameter "limit" must be a positive integer';
  if (limit > MAX_TICKET_PAGE_SIZE) {
    return `query parameter "limit" must be at most ${MAX_TICKET_PAGE_SIZE}`;
  }
  return { page, limit };
}

function matchesFilters(ticket: Ticket, filters: Filters): boolean {
  if (filters.state && ticket.state !== filters.state) return false;
  if (filters.label && !ticket.labels.includes(filters.label)) return false;
  if (filters.priority && String(ticket.priority) !== filters.priority) return false;
  if (filters.owner && (ticket.owner?.name ?? "") !== filters.owner) return false;
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    const haystack =
      `${ticket.name} ${ticket.slug} ${ticket.spec.summary} ${ticket.id} ${shortTicketCode(ticket.id)}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function compareTicketListOrder(a: Ticket, b: Ticket): number {
  const activity = b.last_activity_at.localeCompare(a.last_activity_at);
  if (activity !== 0) return activity;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export async function handleTicketList(
  req: BunRequest,
  dataSource: WebDataSource,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  const pagination = parsePagination(url);
  if (typeof pagination === "string") return apiErrorResponse(pagination, 400);
  const filters: Filters = {
    state: url.searchParams.get("state") ?? "",
    label: url.searchParams.get("label") ?? "",
    priority: url.searchParams.get("priority") ?? "",
    owner: url.searchParams.get("owner") ?? "",
    q: url.searchParams.get("q") ?? "",
  };
  if (filters.state && !isTicketState(filters.state)) filters.state = "";

  const [rawTickets, { config, warning }, eventResult] = await Promise.all([
    dataSource.listTickets(),
    dataSource.getConfig(),
    dataSource.listEvents(),
  ]);
  // Effective last_activity_at/latest_note (overlays.ts's deriveEffectiveTickets doc) —
  // a lock-free `update --progress` note must show up here and reset staleness,
  // exactly like `slop show`/the ticket detail page.
  const tickets = deriveEffectiveTickets(rawTickets, eventResult.events);
  const thresholds = staleThresholdsFromConfig(config);
  // G4 (t-jggg9): reuses the SAME whole-db event read already fetched
  // above for deriveEffectiveTickets — no second listEvents() call.
  const awaitingInputByTicket = computeAwaitingInputByTicket(eventResult.events);
  const summaryContext = createTicketSummaryContext(
    tickets,
    thresholds,
    config,
    now,
    awaitingInputByTicket,
  );

  const allLabels = [...new Set(tickets.flatMap((t) => t.labels))].sort();
  const allOwners = [
    ...new Set(tickets.map((t) => t.owner?.name).filter((n): n is string => !!n)),
  ].sort();

  const filtered = tickets.filter((t) => matchesFilters(t, filters)).sort(compareTicketListOrder);
  const filteredTotal = filtered.length;
  const totalPages = Math.ceil(filteredTotal / pagination.limit);
  const pageStart = Math.min(filteredTotal, (pagination.page - 1) * pagination.limit);
  const pageTickets = filtered.slice(pageStart, pageStart + pagination.limit);
  const hasNext = pageStart + pageTickets.length < filteredTotal;

  const body: TicketListResponseDTO = {
    config: configDto(config, warning, eventResult.problems),
    tickets: pageTickets.map((ticket) => ticketSummaryDto(ticket, summaryContext)),
    total: tickets.length,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      filtered_total: filteredTotal,
      total_pages: totalPages,
      previous_page: pagination.page > 1 ? pagination.page - 1 : null,
      next_page: hasNext ? pagination.page + 1 : null,
    },
    facets: { labels: allLabels, owners: allOwners, states: [...TICKET_STATES] },
  };
  return jsonResponse(body);
}
