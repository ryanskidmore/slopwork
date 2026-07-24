/**
 * §4.4 item 6: "Stale / resumable panel — in-progress or review tickets
 * with no activity past the configured threshold (`defaults.stale_after`,
 * `defaults.review_stale_after` from `config.yaml`)." Exactly design.md
 * §2's `stale` overlay definition — see src/web/overlays.ts.
 */
import type { BunRequest } from "bun";
import type { WebDataSource } from "../data-source.js";
import { html } from "../html.js";
import {
  computeStaleReason,
  deriveEffectiveTickets,
  formatRelative,
  isTicketStale,
  staleThresholdsFromConfig,
} from "../overlays.js";
import { pageResponse, priorityBadge, stateBadge, ticketLink } from "./shared.js";

export async function handleStalePanel(
  _req: BunRequest,
  dataSource: WebDataSource,
  now: number,
): Promise<Response> {
  const [rawTickets, { config, warning: configWarning }, events] = await Promise.all([
    dataSource.listTickets(),
    dataSource.getConfig(),
    dataSource.listEvents(),
  ]);
  // ticket_01KY9S0172V8AYCYV9KWS6RC9P: effective `last_activity_at` — see
  // overlays.ts's `deriveEffectiveTickets` doc. A lock-free `update
  // --progress` note must un-stale an in_progress ticket here exactly like
  // it does on `slop show`/`slop status`.
  const tickets = deriveEffectiveTickets(rawTickets, events);
  const thresholds = staleThresholdsFromConfig(config);

  // web-head-returns-404-despite: sort/label by the SAME anchor
  // isTicketStale itself judged staleness against — review's
  // `review.requested_at`, in_progress's `last_activity_at` — not
  // `last_activity_at` for both. An unrelated `update --progress` note (or
  // any other event that bumps `last_activity_at` without touching the
  // review) must not make a rotting MR look fresher than it is; reusing
  // `computeStaleReason` (already the ticket-detail page's source for the
  // exact same "since when" text) keeps this panel and that page in
  // agreement rather than re-deriving the rule a second time.
  const stale = tickets
    .filter((t) => isTicketStale(t, thresholds, now))
    .map((t) => ({
      ticket: t,
      since: computeStaleReason(t, thresholds, now)?.since ?? t.last_activity_at,
    }))
    .sort((a, b) => a.since.localeCompare(b.since)); // longest-idle first

  const rows = stale.map(
    ({ ticket, since }) => html`<tr>
      <td>${stateBadge(ticket.state)}</td>
      <td>${priorityBadge(ticket.priority)}</td>
      <td>${ticketLink(ticket)}</td>
      <td>${ticket.owner?.name ?? html`<span class="muted">—</span>`}</td>
      <td title="${since}">${formatRelative(since, now)}</td>
    </tr>`,
  );

  const body = html`<h1>Stale / resumable</h1>
<p class="muted">${stale.length} ticket${stale.length === 1 ? "" : "s"} idle past threshold (in_progress: ${config.defaults.stale_after}, review: ${config.defaults.review_stale_after}), longest-idle first.</p>
<div class="table-scroll">
<table>
  <thead><tr><th>State</th><th>Priority</th><th>Ticket</th><th>Owner</th><th>Idle for</th></tr></thead>
  <tbody>${rows.length > 0 ? rows : html`<tr><td colspan="5" class="empty-state">Nothing stale right now.</td></tr>`}</tbody>
</table>
</div>`;

  return pageResponse({
    title: "Stale",
    nav: "stale",
    project: config.project,
    configWarning,
    body,
  });
}
