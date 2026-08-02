/**
 * `GET /api/stale` — in-progress or review tickets idle past the
 * configured threshold, longest-idle first (feature parity with the old
 * `src/web/views/stale.ts`). Anchors each row's "since" on the SAME clock
 * `isTicketStale` judged staleness against — review's `review.requested_at`,
 * in_progress's `last_activity_at` — not `last_activity_at` for both (see
 * `overlays.ts`'s `computeStaleReason` doc / web-head-returns-404-despite).
 * Bounded the same `page`/`limit` way `GET /api/tickets` is — see
 * `pagination.ts`'s doc.
 */
import type { BunRequest } from "bun";
import type { WebDataSource } from "../data-source.js";
import {
  computeAwaitingInputByTicket,
  computeStaleReason,
  deriveEffectiveTickets,
  isTicketStale,
  staleThresholdsFromConfig,
} from "../overlays.js";
import { configDto, createTicketSummaryContext, jsonResponse, ticketSummaryDto } from "./shared.js";
import type { StaleResponseDTO } from "./types.js";
import { paginate, parsePage } from "./pagination.js";

export async function handleStalePanel(
  req: BunRequest,
  dataSource: WebDataSource,
  now: number,
): Promise<Response> {
  const pageInput = parsePage(new URL(req.url));
  if (pageInput instanceof Response) return pageInput;
  const [rawTickets, { config, warning }, eventResult] = await Promise.all([
    dataSource.listTickets(),
    dataSource.getConfig(),
    dataSource.listEvents(),
  ]);
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

  const stale = tickets
    .filter((t) => isTicketStale(t, thresholds, now))
    .map((t) => ({
      ticket: t,
      since: computeStaleReason(t, thresholds, now)?.since ?? t.last_activity_at,
    }))
    .sort((a, b) => {
      const since = a.since.localeCompare(b.since);
      return since !== 0 ? since : a.ticket.id.localeCompare(b.ticket.id);
    });
  const page = paginate(stale, pageInput);

  const body: StaleResponseDTO = {
    config: configDto(config, warning, eventResult.problems),
    rows: page.items.map(({ ticket, since }) => ({
      ticket: ticketSummaryDto(ticket, summaryContext),
      since,
    })),
    pagination: page.pagination,
  };
  return jsonResponse(body);
}
