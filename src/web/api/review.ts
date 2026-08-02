/**
 * `GET /api/review` — every ticket currently `in review`, sorted
 * longest-awaiting-first (feature parity with the old
 * `src/web/views/review.ts`, design.md D15).
 */
import type { BunRequest } from "bun";
import type { WebDataSource } from "../data-source.js";
import { computeAwaitingInputByTicket, staleThresholdsFromConfig } from "../overlays.js";
import { configDto, createTicketSummaryContext, jsonResponse, ticketSummaryDto } from "./shared.js";
import type { ReviewResponseDTO } from "./types.js";

export async function handleReviewPanel(
  _req: BunRequest,
  dataSource: WebDataSource,
  now: number,
): Promise<Response> {
  const [tickets, { config, warning }, eventResult] = await Promise.all([
    dataSource.listTickets(),
    dataSource.getConfig(),
    // G4 (t-jggg9): needed for the awaiting_input overlay badge — see
    // overlays.ts's computeAwaitingInputByTicket.
    dataSource.listEvents(),
  ]);
  const thresholds = staleThresholdsFromConfig(config);
  const awaitingInputByTicket = computeAwaitingInputByTicket(eventResult.events);
  const summaryContext = createTicketSummaryContext(
    tickets,
    thresholds,
    config,
    now,
    awaitingInputByTicket,
  );

  const inReview = tickets
    .filter((t) => t.state === "review" && t.review)
    .sort((a, b) => (a.review?.requested_at ?? "").localeCompare(b.review?.requested_at ?? ""));

  const body: ReviewResponseDTO = {
    config: configDto(config, warning, eventResult.problems),
    tickets: inReview.map((ticket) => ticketSummaryDto(ticket, summaryContext)),
  };
  return jsonResponse(body);
}
