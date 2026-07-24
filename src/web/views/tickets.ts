/**
 * §4.4 item 1: "Ticket list with filters — by state, label, priority,
 * owner; plus text filter. Show what a human scanning work needs (state,
 * priority, name, slug, labels, owner, last activity)."
 *
 * Filters are a plain GET form — no client JS required for the feature to
 * work (app.js layers an optional instant client-side filter on top of
 * the same search box, purely as progressive enhancement).
 */
import type { BunRequest } from "bun";
import { TICKET_STATES, type Ticket, type TicketState } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import { html, type RawHtml } from "../html.js";
import {
  computeBlockedTicketIds,
  deriveEffectiveTickets,
  formatRelative,
  isTicketStale,
  staleThresholdsFromConfig,
} from "../overlays.js";
import {
  blockedBadge,
  labelChips,
  pageResponse,
  priorityBadge,
  staleBadge,
  stateBadge,
  ticketLink,
} from "./shared.js";

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

/** `<option>` list for a `<select>`, with an "All" option for the empty value. Every value/label is escaped by `html` — labels/owners are user data, not controlled vocabulary. */
function selectOptions(values: readonly string[], selected: string, allLabel = "All"): RawHtml {
  const options = [
    html`<option value="" ${selected === "" ? "selected" : ""}>${allLabel}</option>`,
    ...values.map(
      (v) => html`<option value="${v}" ${v === selected ? "selected" : ""}>${v}</option>`,
    ),
  ];
  return html`${options}`;
}

export async function handleTicketList(
  req: BunRequest,
  dataSource: WebDataSource,
  nowMs: number,
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

  const [rawTickets, { config, warning: configWarning }, events] = await Promise.all([
    dataSource.listTickets(),
    dataSource.getConfig(),
    dataSource.listEvents(),
  ]);
  // ticket_01KY9S0172V8AYCYV9KWS6RC9P: effective `last_activity_at` (see
  // overlays.ts's `deriveEffectiveTickets` doc) — a lock-free `update
  // --progress` note must show up here, and reset staleness, exactly like
  // it does on `slop show`/the ticket detail page.
  const tickets = deriveEffectiveTickets(rawTickets, events);
  const blockedIds = computeBlockedTicketIds(tickets);
  const thresholds = staleThresholdsFromConfig(config);

  const allLabels = [...new Set(tickets.flatMap((t) => t.labels))].sort();
  const allOwners = [
    ...new Set(tickets.map((t) => t.owner?.name).filter((n): n is string => !!n)),
  ].sort();

  const filtered = tickets
    .filter((t) => matchesFilters(t, filters))
    // Most recently active first — the default question a human opens this page with is "what's moving right now".
    .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));

  const now = nowMs;

  const rows = filtered.map((ticket) => {
    const searchBlob = [ticket.name, ticket.slug, ...ticket.labels, ticket.owner?.name ?? ""]
      .join(" ")
      .toLowerCase();
    return html`<tr data-search="${searchBlob}">
      <td>${stateBadge(ticket.state)} ${blockedIds.has(ticket.id) ? blockedBadge() : ""} ${isTicketStale(ticket, thresholds, now) ? staleBadge() : ""}</td>
      <td>${priorityBadge(ticket.priority)}</td>
      <td>${ticketLink(ticket)}</td>
      <td class="mono muted">${ticket.slug}</td>
      <td>${labelChips(ticket.labels)}</td>
      <td>${ticket.owner?.name ?? html`<span class="muted">—</span>`}</td>
      <td class="muted" title="${ticket.last_activity_at}">${formatRelative(ticket.last_activity_at, now)}</td>
    </tr>`;
  });

  const body = html`<h1>Tickets</h1>
<p class="muted">${filtered.length} of ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}</p>
<form class="filters" method="get" action="/tickets">
  <label>State
    <select name="state">${selectOptions(TICKET_STATES, filters.state)}</select>
  </label>
  <label>Label
    <select name="label">${selectOptions(allLabels, filters.label)}</select>
  </label>
  <label>Priority
    <select name="priority">${selectOptions(["0", "1", "2", "3"], filters.priority)}</select>
  </label>
  <label>Owner
    <select name="owner">${selectOptions(allOwners, filters.owner)}</select>
  </label>
  <label>Text
    <input type="search" name="q" value="${filters.q}" placeholder="name, slug, summary…" data-live-filter>
  </label>
  <button type="submit">Filter</button>
  <a class="clear" href="/tickets">Clear</a>
</form>
<div class="table-scroll">
<table data-filter-target>
  <thead><tr><th>State</th><th>Priority</th><th>Name</th><th>Slug</th><th>Labels</th><th>Owner</th><th>Last activity</th></tr></thead>
  <tbody>${rows.length > 0 ? rows : html`<tr><td colspan="7" class="empty-state">No tickets match these filters.</td></tr>`}</tbody>
</table>
</div>
<script src="/assets/app.js"></script>`;

  return pageResponse({
    title: "Tickets",
    nav: "tickets",
    project: config.project,
    configWarning,
    body,
  });
}
