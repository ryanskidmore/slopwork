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

  const stale = tickets
    .filter((t) => isTicketStale(t, thresholds, now))
    .sort((a, b) => a.last_activity_at.localeCompare(b.last_activity_at)); // longest-idle first

  const rows = stale.map(
    (ticket) => html`<tr>
      <td>${stateBadge(ticket.state)}</td>
      <td>${priorityBadge(ticket.priority)}</td>
      <td>${ticketLink(ticket)}</td>
      <td>${ticket.owner?.name ?? html`<span class="muted">—</span>`}</td>
      <td title="${ticket.last_activity_at}">${formatRelative(ticket.last_activity_at, now)}</td>
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
