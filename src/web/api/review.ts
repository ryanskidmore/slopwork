/**
 * `GET /api/review` — every ticket currently `in review`, sorted
 * longest-awaiting-first (feature parity with the old
 * `src/web/views/review.ts`, design.md D15).
 */
import type { BunRequest } from "bun";
import type { Ticket, TicketId } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import { computeAwaitingInputByTicket, staleThresholdsFromConfig } from "../overlays.js";
import { configDto, jsonResponse, ticketSummaryDto } from "./shared.js";
import type { ReviewResponseDTO } from "./types.js";

export async function handleReviewPanel(
  _req: BunRequest,
  dataSource: WebDataSource,
  now: number,
): Promise<Response> {
  const [tickets, { config, warning }, events] = await Promise.all([
    dataSource.listTickets(),
    dataSource.getConfig(),
    // G4 (t-jggg9): needed for the awaiting_input overlay badge — see
    // overlays.ts's computeAwaitingInputByTicket.
    dataSource.listEvents(),
  ]);
  const byId = new Map<TicketId, Ticket>(tickets.map((t) => [t.id, t]));
  const thresholds = staleThresholdsFromConfig(config);
  const awaitingInputByTicket = computeAwaitingInputByTicket(events);

  const inReview = tickets
    .filter((t) => t.state === "review" && t.review)
    .sort((a, b) => (a.review?.requested_at ?? "").localeCompare(b.review?.requested_at ?? ""));

  const body: ReviewResponseDTO = {
    config: configDto(config, warning),
    tickets: inReview.map((t) =>
      ticketSummaryDto(t, tickets, byId, thresholds, config, now, awaitingInputByTicket),
    ),
  };
  return jsonResponse(body);
}
