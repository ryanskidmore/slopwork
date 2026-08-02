/**
 * `GET /api/tree` — parent/child hierarchy (feature parity with the old
 * `src/web/views/tree.ts`). External parents (`jira:PROJ-123`) terminate
 * the local tree (D1) — a root ticket may carry an `external_parent`, but
 * never a traversable node above it.
 *
 * A nested tree has no "page N" of its own — bounded instead by a total
 * NODE budget (`limit`, walked breadth-first across roots) and a DEPTH
 * budget (`depth`, per branch) — see `TreeResponseDTO`'s `returned`/
 * `truncated`/`bounds` and each node's `has_children`/`children_truncated`
 * for how a client tells "this subtree is complete" from "there's more
 * here, not shown".
 */
import type { BunRequest } from "bun";
import { isTicketId, type Config, type Ticket, type TicketId } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import {
  computeAwaitingInputByTicket,
  deriveEffectiveTickets,
  staleThresholdsFromConfig,
} from "../overlays.js";
import {
  configDto,
  createTicketSummaryContext,
  externalParentDto,
  jsonResponse,
  ticketSummaryDto,
} from "./shared.js";
import type { TicketSummaryContext } from "./shared.js";
import type { TreeNodeDTO, TreeResponseDTO } from "./types.js";
import { parseBoundedPositiveInteger } from "./pagination.js";

export const DEFAULT_TREE_MAX_NODES = 500;
export const MAX_TREE_MAX_NODES = 1_000;
export const DEFAULT_TREE_MAX_DEPTH = 6;
export const MAX_TREE_MAX_DEPTH = 12;

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
    siblings.sort((a, b) => {
      const name = a.name.localeCompare(b.name);
      return name !== 0 ? name : a.id.localeCompare(b.id);
    });
  }
  return byParent;
}

/** Mutable node/truncation counters threaded through one `buildNode` walk —
 * a small class (rather than closed-over `let`s) so the recursive builder
 * below is a plain, independently-typed function: TypeScript can't narrow
 * a `let` captured by a closure across calls the way it can a `const`
 * (web-tree-bounds-narrowing), and re-deriving `maxNodes`/`maxDepth`/the
 * budget counters as constructor-bound fields sidesteps that gap entirely
 * instead of re-checking `instanceof Response` on every recursive call. */
class TreeBuilder {
  returned = 0;
  truncated = false;

  constructor(
    private readonly childIndex: ReadonlyMap<TicketId, Ticket[]>,
    private readonly summaryContext: TicketSummaryContext,
    private readonly config: Config,
    private readonly maxNodes: number,
    private readonly maxDepth: number,
  ) {}

  /** Cycle defence: write-time validation already rejects cycles, but a
   * tree builder should never infinite-loop even against a bad fixture. */
  buildNode(ticket: Ticket, visited: ReadonlySet<TicketId>, depth: number): TreeNodeDTO | null {
    if (this.returned >= this.maxNodes) {
      this.truncated = true;
      return null;
    }
    this.returned++;
    const nextVisited = new Set(visited).add(ticket.id);
    const candidates = (this.childIndex.get(ticket.id) ?? []).filter(
      (child) => !nextVisited.has(child.id),
    );
    const children: TreeNodeDTO[] = [];
    if (depth < this.maxDepth) {
      for (const child of candidates) {
        const built = this.buildNode(child, nextVisited, depth + 1);
        if (built === null) break;
        children.push(built);
      }
    }
    const childrenTruncated = children.length < candidates.length;
    if (childrenTruncated) this.truncated = true;
    const hasExternalParent = ticket.parent !== undefined && !isTicketId(ticket.parent);
    return {
      ticket: ticketSummaryDto(ticket, this.summaryContext),
      children,
      has_children: candidates.length > 0,
      children_truncated: childrenTruncated,
      external_parent:
        hasExternalParent && ticket.parent !== undefined
          ? externalParentDto(ticket.parent, this.config)
          : null,
    };
  }
}

export async function handleTreeView(
  req: BunRequest,
  dataSource: WebDataSource,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  const maxNodes = parseBoundedPositiveInteger(
    url,
    "limit",
    DEFAULT_TREE_MAX_NODES,
    MAX_TREE_MAX_NODES,
  );
  if (maxNodes instanceof Response) return maxNodes;
  const maxDepth = parseBoundedPositiveInteger(
    url,
    "depth",
    DEFAULT_TREE_MAX_DEPTH,
    MAX_TREE_MAX_DEPTH,
  );
  if (maxDepth instanceof Response) return maxDepth;

  const [rawTickets, { config, warning }, eventResult] = await Promise.all([
    dataSource.listTickets(),
    dataSource.getConfig(),
    dataSource.listEvents(),
  ]);
  const tickets = deriveEffectiveTickets(rawTickets, eventResult.events);
  const thresholds = staleThresholdsFromConfig(config);
  const childIndex = buildChildIndex(tickets);
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

  const roots = tickets
    .filter((t) => t.parent === undefined || !isTicketId(t.parent))
    .sort((a, b) => {
      const name = a.name.localeCompare(b.name);
      return name !== 0 ? name : a.id.localeCompare(b.id);
    });

  const builder = new TreeBuilder(childIndex, summaryContext, config, maxNodes, maxDepth);
  const boundedRoots: TreeNodeDTO[] = [];
  for (const root of roots) {
    const node = builder.buildNode(root, new Set(), 1);
    if (node === null) break;
    boundedRoots.push(node);
  }
  if (boundedRoots.length < roots.length) builder.truncated = true;

  const body: TreeResponseDTO = {
    config: configDto(config, warning, eventResult.problems),
    roots: boundedRoots,
    total: tickets.length,
    returned: builder.returned,
    truncated: builder.truncated,
    bounds: {
      max_nodes: maxNodes,
      max_depth: maxDepth,
      maximum_nodes: MAX_TREE_MAX_NODES,
      maximum_depth: MAX_TREE_MAX_DEPTH,
    },
  };
  return jsonResponse(body);
}
