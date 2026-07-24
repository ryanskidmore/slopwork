/**
 * §4.4 item 5: "Review panel — tickets in `review` state with their MR
 * links and review-staleness (how long they've been awaiting a human), per
 * D15." Sorted longest-awaiting-first: that's the queue order a human
 * triaging reviews actually wants.
 */
import type { BunRequest } from "bun";
import type { WebDataSource } from "../data-source.js";
import { html } from "../html.js";
import {
  formatDurationShort,
  isTicketStale,
  msSince,
  staleThresholdsFromConfig,
} from "../overlays.js";
import { pageResponse, priorityBadge, staleBadge, ticketLink } from "./shared.js";

export async function handleReviewPanel(
  _req: BunRequest,
  dataSource: WebDataSource,
  now: number,
): Promise<Response> {
  const [tickets, config] = await Promise.all([dataSource.listTickets(), dataSource.getConfig()]);
  const thresholds = staleThresholdsFromConfig(config);

  const inReview = tickets
    .filter((t) => t.state === "review" && t.review)
    .sort((a, b) => (a.review?.requested_at ?? "").localeCompare(b.review?.requested_at ?? ""));

  const rows = inReview.map((ticket) => {
    const review = ticket.review;
    if (!review) return html``; // narrowed out by the filter above; guards the type only
    const awaitingMs = msSince(review.requested_at, now);
    const stale = isTicketStale(ticket, thresholds, now);
    return html`<tr>
      <td>${priorityBadge(ticket.priority)}</td>
      <td>${ticketLink(ticket)}</td>
      <td>${review.mr ? html`<a href="${review.mr}" target="_blank" rel="noopener noreferrer">${review.mr}</a>` : html`<span class="muted">no MR link</span>`}</td>
      <td>${review.by.name}</td>
      <td title="${review.requested_at}">${formatDurationShort(awaitingMs)}${stale ? html` ${staleBadge()}` : ""}</td>
    </tr>`;
  });

  const body = html`<h1>Review</h1>
<p class="muted">${inReview.length} ticket${inReview.length === 1 ? "" : "s"} awaiting review, longest-waiting first. Stale threshold: ${config.defaults.review_stale_after}.</p>
<div class="table-scroll">
<table>
  <thead><tr><th>Priority</th><th>Ticket</th><th>MR</th><th>Requested by</th><th>Awaiting</th></tr></thead>
  <tbody>${rows.length > 0 ? rows : html`<tr><td colspan="5" class="empty-state">Nothing awaiting review.</td></tr>`}</tbody>
</table>
</div>`;

  return pageResponse({ title: "Review", nav: "review", project: config.project, body });
}
