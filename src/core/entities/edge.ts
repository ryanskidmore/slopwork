/**
 * Edges (design.md §4.1 item 2): `blocks` · `parent` · `relates-to` ·
 * `discovered-from`.
 *
 * Storage decision (see DECISIONS.md for the full rationale — this is
 * binding, not a suggestion): design.md §3's flatfile db layout lists
 * only `tickets/`, `sessions/`, `events/`, and the derived `index.jsonc`
 * — there is no `edges/` directory. So edges are stored *embedded on the
 * source ticket*: `parent` as its own optional field, and `blocks` /
 * `relates_to` / `discovered_from` as arrays of ticket ids. The reverse
 * direction (e.g. "who blocks on me", B4's `blocked_count`) is never
 * stored — it is derived into `index.jsonc` at reindex time by scanning
 * every ticket's outgoing edges (see {@link outgoingEdges} below).
 *
 * This file defines both halves and the mapping between them: the
 * *logical* {@link edgeSchema} (`{from, to, kind}`) that the index/graph
 * code (B3/B4) reasons about, and {@link ticketEdgeFieldsSchema}, the
 * embedded on-ticket shape that actually round-trips to disk.
 */
import { z } from "zod";
import { type TicketId, isTicketId, ticketIdSchema } from "../ids.js";
import { externalRefSchema, parentRefSchema } from "./ref.js";

export const EDGE_KINDS = ["blocks", "parent", "relates-to", "discovered-from"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];
export const edgeKindSchema = z.enum(EDGE_KINDS);

/**
 * The logical edge shape. Only `parent` edges may target an external ref
 * (D1: external parents terminate the local tree) — `blocks`,
 * `relates-to`, and `discovered-from` always target a local ticket. This
 * is a structural constraint, enforced here; it is distinct from B3's
 * *semantic* checks (cycle detection, degree caps), which this schema
 * knows nothing about.
 */
export const edgeSchema = z
  .object({
    from: ticketIdSchema,
    to: z.union([ticketIdSchema, externalRefSchema]),
    kind: edgeKindSchema,
  })
  .refine((edge) => edge.kind === "parent" || isTicketId(edge.to), {
    message:
      "only `parent` edges may target an external ref; blocks/relates-to/discovered-from must target a local ticket",
    path: ["to"],
  });
export type Edge = z.infer<typeof edgeSchema>;

/** The embedded on-ticket representation of a ticket's outgoing edges. */
export const ticketEdgeFieldsSchema = z.object({
  parent: parentRefSchema.optional(),
  blocks: z.array(ticketIdSchema).default([]),
  relates_to: z.array(ticketIdSchema).default([]),
  discovered_from: z.array(ticketIdSchema).default([]),
});
export type TicketEdgeFields = z.infer<typeof ticketEdgeFieldsSchema>;

/**
 * Mapping between a logical {@link EdgeKind} and the ticket field it is
 * embedded in on disk. `parent` maps to itself; the three plural kinds
 * map to their snake_case array field (the kind names themselves use
 * hyphens purely as label text — JSON keys use snake_case, as everywhere
 * else in these schemas).
 */
export const EDGE_KIND_TO_TICKET_FIELD = {
  parent: "parent",
  blocks: "blocks",
  "relates-to": "relates_to",
  "discovered-from": "discovered_from",
} as const satisfies Record<EdgeKind, keyof TicketEdgeFields>;

/**
 * Extract a ticket's outgoing logical edges from its embedded fields.
 * There is no reverse-direction store — B4 builds the reverse index (the
 * things B4's `blocked_count` needs) by calling this over every ticket at
 * reindex time and inverting the result in memory.
 */
export function outgoingEdges(ticket: { id: TicketId } & TicketEdgeFields): Edge[] {
  const edges: Edge[] = [];
  if (ticket.parent !== undefined) {
    edges.push({ from: ticket.id, to: ticket.parent, kind: "parent" });
  }
  for (const to of ticket.blocks) {
    edges.push({ from: ticket.id, to, kind: "blocks" });
  }
  for (const to of ticket.relates_to) {
    edges.push({ from: ticket.id, to, kind: "relates-to" });
  }
  for (const to of ticket.discovered_from) {
    edges.push({ from: ticket.id, to, kind: "discovered-from" });
  }
  return edges;
}
