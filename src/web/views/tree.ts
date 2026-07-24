/**
 * §4.4 item 2: "Tree view — the parent/child hierarchy. External parents
 * render as badges linking to the Jira URL built from `remotes.jira` in
 * `config.yaml` (D1: external parents terminate the local tree, so an
 * external parent is a leaf-upward badge, not a traversable node)."
 */
import type { BunRequest } from "bun";
import type { Config, Ticket, TicketId } from "../../core/index.js";
import { isTicketId } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import { html, joinHtml, type RawHtml } from "../html.js";
import {
  computeBlockedTicketIds,
  deriveEffectiveTickets,
  isTicketStale,
  staleThresholdsFromConfig,
} from "../overlays.js";
import {
  blockedBadge,
  externalParentBadge,
  labelChips,
  pageResponse,
  priorityBadge,
  staleBadge,
  stateBadge,
  ticketLink,
} from "./shared.js";

function buildChildIndex(tickets: readonly Ticket[]): Map<TicketId, Ticket[]> {
  const byParent = new Map<TicketId, Ticket[]>();
  for (const ticket of tickets) {
    if (ticket.parent !== undefined && isTicketId(ticket.parent)) {
      const siblings = byParent.get(ticket.parent) ?? [];
      siblings.push(ticket);
      byParent.set(ticket.parent, siblings);
    }
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.name.localeCompare(b.name));
  }
  return byParent;
}

function renderNode(
  ticket: Ticket,
  childIndex: Map<TicketId, Ticket[]>,
  config: Config,
  blockedIds: Set<TicketId>,
  staleIds: Set<TicketId>,
  visited: Set<TicketId>,
): RawHtml {
  // Cycle defence: B3 cycle-checks at write time, but a tree renderer
  // should never infinite-loop even if a fixture (or a future bug)
  // produces a bad graph.
  if (visited.has(ticket.id)) {
    return html`<li><span class="muted">(cycle detected at ${ticket.slug})</span></li>`;
  }
  const nextVisited = new Set(visited).add(ticket.id);
  const children = childIndex.get(ticket.id) ?? [];
  const hasExternalParent = ticket.parent !== undefined && !isTicketId(ticket.parent);

  return html`<li>
  <div class="tree-node">
    ${stateBadge(ticket.state)}
    ${priorityBadge(ticket.priority)}
    ${ticketLink(ticket)}
    <span class="mono muted">${ticket.slug}</span>
    ${blockedIds.has(ticket.id) ? blockedBadge() : ""}
    ${staleIds.has(ticket.id) ? staleBadge() : ""}
    ${labelChips(ticket.labels)}
    ${hasExternalParent && ticket.parent !== undefined ? externalParentBadge(ticket.parent, config) : ""}
  </div>
  ${
    children.length > 0
      ? html`<ul class="tree">${joinHtml(
          children.map((child) =>
            renderNode(child, childIndex, config, blockedIds, staleIds, nextVisited),
          ),
        )}</ul>`
      : ""
  }
</li>`;
}

export async function handleTreeView(
  _req: BunRequest,
  dataSource: WebDataSource,
  now: number,
): Promise<Response> {
  const [rawTickets, config, events] = await Promise.all([
    dataSource.listTickets(),
    dataSource.getConfig(),
    dataSource.listEvents(),
  ]);
  // ticket_01KY9S0172V8AYCYV9KWS6RC9P: effective `last_activity_at` (see
  // overlays.ts's `deriveEffectiveTickets` doc) — a lock-free `update
  // --progress` note must reset an in_progress ticket's staleness clock
  // here exactly like it does on `slop show`/`/tickets/:ref`, not just on
  // the ticket detail page.
  const tickets = deriveEffectiveTickets(rawTickets, events);
  const blockedIds = computeBlockedTicketIds(tickets);
  const thresholds = staleThresholdsFromConfig(config);
  const staleIds = new Set(
    tickets.filter((t) => isTicketStale(t, thresholds, now)).map((t) => t.id),
  );
  const childIndex = buildChildIndex(tickets);

  // Local roots (D1): no parent at all, or an external parent — either way
  // there is no local ticket above this one to nest it under.
  const roots = tickets
    .filter((t) => t.parent === undefined || !isTicketId(t.parent))
    .sort((a, b) => a.name.localeCompare(b.name));

  const body = html`<h1>Tree</h1>
<p class="muted">${roots.length} root${roots.length === 1 ? "" : "s"} of ${tickets.length} ticket${tickets.length === 1 ? "" : "s"} total. External parents are shown as an "↑" badge rather than a node you can open.</p>
${
  roots.length > 0
    ? html`<ul class="tree root">${joinHtml(
        roots.map((root) => renderNode(root, childIndex, config, blockedIds, staleIds, new Set())),
      )}</ul>`
    : html`<div class="empty-state">No tickets yet.</div>`
}`;

  return pageResponse({ title: "Tree", nav: "tree", project: config.project, body });
}
