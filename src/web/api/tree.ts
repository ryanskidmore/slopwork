/**
 * `GET /api/tree` — parent/child hierarchy (feature parity with the old
 * `src/web/views/tree.ts`). External parents (`jira:PROJ-123`) terminate
 * the local tree (D1) — a root ticket may carry an `external_parent`, but
 * never a traversable node above it.
 */
import type { BunRequest } from "bun";
import { isTicketId, type Ticket, type TicketId } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import { deriveEffectiveTickets, staleThresholdsFromConfig } from "../overlays.js";
import { configDto, externalParentDto, jsonResponse, ticketSummaryDto } from "./shared.js";
import type { TreeNodeDTO, TreeResponseDTO } from "./types.js";

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

export async function handleTreeView(
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
  const childIndex = buildChildIndex(tickets);

  // Cycle defence: write-time validation already rejects cycles, but a
  // tree builder should never infinite-loop even against a bad fixture.
  function buildNode(ticket: Ticket, visited: ReadonlySet<TicketId>): TreeNodeDTO {
    const nextVisited = new Set(visited).add(ticket.id);
    const children = (childIndex.get(ticket.id) ?? []).filter((c) => !visited.has(c.id));
    const hasExternalParent = ticket.parent !== undefined && !isTicketId(ticket.parent);
    return {
      ticket: ticketSummaryDto(ticket, tickets, byId, thresholds, config, now),
      children: children.map((c) => buildNode(c, nextVisited)),
      external_parent:
        hasExternalParent && ticket.parent !== undefined
          ? externalParentDto(ticket.parent, config)
          : null,
    };
  }

  const roots = tickets
    .filter((t) => t.parent === undefined || !isTicketId(t.parent))
    .sort((a, b) => a.name.localeCompare(b.name));

  const body: TreeResponseDTO = {
    config: configDto(config, warning),
    roots: roots.map((root) => buildNode(root, new Set())),
    total: tickets.length,
  };
  return jsonResponse(body);
}
