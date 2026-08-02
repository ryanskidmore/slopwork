/**
 * `GET /api/stale` — in-progress or review tickets idle past the
 * configured threshold, longest-idle first (feature parity with the old
 * `src/web/views/stale.ts`). Anchors each row's "since" on the SAME clock
 * `isTicketStale` judged staleness against — review's `review.requested_at`,
 * in_progress's `last_activity_at` — not `last_activity_at` for both (see
 * `overlays.ts`'s `computeStaleReason` doc / web-head-returns-404-despite).
 */
import type { BunRequest } from "bun";
import type { Ticket, TicketId } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import {
  computeAwaitingInputByTicket,
  computeStaleReason,
  deriveEffectiveTickets,
  isTicketStale,
  staleThresholdsFromConfig,
} from "../overlays.js";
import { configDto, jsonResponse, ticketSummaryDto } from "./shared.js";
import type { StaleResponseDTO } from "./types.js";

export async function handleStalePanel(
  _req: BunRequest,
  dataSource: WebDataSource,
  now: number,
): Promise<Response> {
  const [rawTickets, { config, warning }, events] = await Promise.all([
    dataSource.listTickets(),
    dataSource.getConfig(),
    dataSource.listEvents(),
  ]);
  const tickets = deriveEffectiveTickets(rawTickets, events);
  const byId = new Map<TicketId, Ticket>(tickets.map((t) => [t.id, t]));
  const thresholds = staleThresholdsFromConfig(config);
  // G4 (t-jggg9): reuses the SAME whole-db event read already fetched
  // above for deriveEffectiveTickets — no second listEvents() call.
  const awaitingInputByTicket = computeAwaitingInputByTicket(events);

  const stale = tickets
    .filter((t) => isTicketStale(t, thresholds, now))
    .map((t) => ({
      ticket: t,
      since: computeStaleReason(t, thresholds, now)?.since ?? t.last_activity_at,
    }))
    .sort((a, b) => a.since.localeCompare(b.since));

  const body: StaleResponseDTO = {
    config: configDto(config, warning),
    rows: stale.map(({ ticket, since }) => ({
      ticket: ticketSummaryDto(
        ticket,
        tickets,
        byId,
        thresholds,
        config,
        now,
        awaitingInputByTicket,
      ),
      since,
    })),
  };
  return jsonResponse(body);
}
