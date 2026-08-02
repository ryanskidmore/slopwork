import type { BunRequest } from "bun";
import { describe, expect, it } from "vitest";
import type { Config, Ticket, TicketId } from "../../core/index.js";
import { newTicketId, ticketSchema } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import type { TreeNodeDTO, TreeResponseDTO } from "./types.js";
import {
  DEFAULT_TREE_MAX_DEPTH,
  DEFAULT_TREE_MAX_NODES,
  handleTreeView,
  MAX_TREE_MAX_DEPTH,
  MAX_TREE_MAX_NODES,
} from "./tree.js";

const config: Config = {
  project: "tree-bounds-test",
  remotes: {},
  defaults: { stale_after: "60m", review_stale_after: "24h", lock_timeout: "5s" },
  backend: "flatfile",
};

function makeTicket(name: string, overrides: Record<string, unknown> = {}): Ticket {
  const id = newTicketId();
  return ticketSchema.parse({
    id,
    name,
    slug: name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
    spec: { summary: name },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "test", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

function dataSource(tickets: Ticket[]): WebDataSource {
  return {
    async getConfig() {
      return { config, warning: null };
    },
    async listTickets() {
      return tickets;
    },
    async findTicketByRef(ref: string) {
      return tickets.find((ticket) => ticket.id === ref || ticket.slug === ref) ?? null;
    },
    async listSessionsForTicket(_ticketId: TicketId) {
      return [];
    },
    async listEventsForTicket(_ticketId: TicketId) {
      return { events: [], problems: [] };
    },
    async listEvents() {
      return { events: [], problems: [] };
    },
  };
}

async function request(
  tickets: Ticket[],
  query = "",
): Promise<{ response: Response; body: TreeResponseDTO }> {
  const response = await handleTreeView(
    new Request(`http://localhost/api/tree${query}`) as BunRequest,
    dataSource(tickets),
    Date.parse("2026-07-23T12:00:00.000Z"),
  );
  return { response, body: (await response.json()) as TreeResponseDTO };
}

function countNodes(nodes: readonly TreeNodeDTO[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

describe("GET /api/tree node/depth bounds", () => {
  it("bounds a forest larger than the default node budget and reports truncation", async () => {
    const tickets = Array.from({ length: DEFAULT_TREE_MAX_NODES + 50 }, (_, index) =>
      makeTicket(`Root ${String(index).padStart(4, "0")}`),
    );
    const { response, body } = await request(tickets);

    expect(response.status).toBe(200);
    expect(body.total).toBe(tickets.length);
    expect(body.returned).toBe(DEFAULT_TREE_MAX_NODES);
    expect(countNodes(body.roots)).toBe(DEFAULT_TREE_MAX_NODES);
    expect(body.truncated).toBe(true);
    expect(body.bounds).toEqual({
      max_nodes: DEFAULT_TREE_MAX_NODES,
      max_depth: DEFAULT_TREE_MAX_DEPTH,
      maximum_nodes: MAX_TREE_MAX_NODES,
      maximum_depth: MAX_TREE_MAX_DEPTH,
    });
  });

  it("does not truncate a forest at or under the node budget", async () => {
    const tickets = Array.from({ length: 12 }, (_, index) => makeTicket(`Root ${index}`));
    const { body } = await request(tickets);
    expect(body.returned).toBe(12);
    expect(body.truncated).toBe(false);
    expect(countNodes(body.roots)).toBe(12);
  });

  it("bounds a chain deeper than the default depth budget, marking the cut node has_children/children_truncated", async () => {
    // A single chain deeper than DEFAULT_TREE_MAX_DEPTH: root -> child -> ... ,
    // one ticket per level.
    const depth = DEFAULT_TREE_MAX_DEPTH + 4;
    const tickets: Ticket[] = [];
    let parent: Ticket | null = null;
    for (let level = 0; level < depth; level++) {
      const ticket = makeTicket(`Level ${level}`, parent ? { parent: parent.id } : {});
      tickets.push(ticket);
      parent = ticket;
    }
    const { body } = await request(tickets);

    expect(body.truncated).toBe(true);
    // Walk down to the deepest node the response actually included.
    let node = body.roots[0];
    for (let level = 1; level < DEFAULT_TREE_MAX_DEPTH; level++) {
      expect(node).toBeDefined();
      node = node?.children[0];
    }
    expect(node).toBeDefined();
    expect(node?.has_children).toBe(true);
    expect(node?.children_truncated).toBe(true);
    expect(node?.children).toHaveLength(0);
  });

  it("respects explicit limit/depth query params, allowing a fully-untruncated response", async () => {
    const depth = DEFAULT_TREE_MAX_DEPTH + 4;
    const tickets: Ticket[] = [];
    let parent: Ticket | null = null;
    for (let level = 0; level < depth; level++) {
      const ticket = makeTicket(`Level ${level}`, parent ? { parent: parent.id } : {});
      tickets.push(ticket);
      parent = ticket;
    }
    const { body } = await request(tickets, `?limit=${tickets.length}&depth=${depth}`);

    expect(body.truncated).toBe(false);
    expect(body.returned).toBe(tickets.length);
    expect(countNodes(body.roots)).toBe(tickets.length);
  });

  it.each([
    "?limit=0",
    "?limit=-1",
    "?limit=1.5",
    "?depth=0",
    "?depth=nope",
    `?limit=${MAX_TREE_MAX_NODES + 1}`,
    `?depth=${MAX_TREE_MAX_DEPTH + 1}`,
  ])("rejects invalid or over-limit bounds: %s", async (query) => {
    const { response } = await request([makeTicket("Root")], query);
    expect(response.status).toBe(400);
  });
});
