/**
 * `slop show --tree` (B1, design.md §4.2/§4.4 item 2): the local
 * ancestry/descendants of a ticket as a tree, with an external parent
 * rendered as a badge-style leaf above the local root (D1: "external
 * parents terminate the local tree"). Mirrors `src/web/views/tree.ts`'s
 * shape for the CLI, reimplemented locally rather than imported — see
 * `jira.ts`'s doc for why (that directory is out of this work item's
 * scope to touch or depend on).
 */
import type { Ticket, TicketId } from "../core/index.js";
import { isTicketId } from "../core/index.js";

export interface TreeNode {
  ticket: Ticket;
  children: TreeNode[];
}

/**
 * The descendant subtree rooted at `rootId`, built from `tickets` (every
 * ticket sharing `rootId`'s `root_id` is enough; the caller may also just
 * pass every ticket in the db — this only ever follows `parent` links
 * reachable from `rootId`). Children are sorted by name for stable
 * output. Defensive against a cycle that shouldn't exist (B3 write-time
 * cycle-checks; this is a display-time backstop, same as
 * `src/web/views/tree.ts`'s `renderNode`) by refusing to revisit an id
 * already on the current path.
 */
export function buildTree(rootId: TicketId, tickets: readonly Ticket[]): TreeNode {
  const byId = new Map(tickets.map((t) => [t.id, t] as const));
  const byParent = new Map<TicketId, Ticket[]>();
  for (const t of tickets) {
    if (t.parent !== undefined && isTicketId(t.parent)) {
      const siblings = byParent.get(t.parent) ?? [];
      siblings.push(t);
      byParent.set(t.parent, siblings);
    }
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.name.localeCompare(b.name));
  }

  const root = byId.get(rootId);
  if (!root) {
    throw new Error(`buildTree: ${rootId} is not present in the given ticket list`);
  }

  function node(ticket: Ticket, visited: ReadonlySet<TicketId>): TreeNode {
    if (visited.has(ticket.id)) return { ticket, children: [] };
    const nextVisited = new Set(visited).add(ticket.id);
    const kids = byParent.get(ticket.id) ?? [];
    return { ticket, children: kids.map((k) => node(k, nextVisited)) };
  }

  return node(root, new Set());
}

/** Every id on the path from `tree`'s root down to (and including) `targetId`, or `null` if `targetId` isn't in the tree at all. */
export function pathToTarget(tree: TreeNode, targetId: TicketId): TreeNode[] | null {
  if (tree.ticket.id === targetId) return [tree];
  for (const child of tree.children) {
    const rest = pathToTarget(child, targetId);
    if (rest) return [tree, ...rest];
  }
  return null;
}

function describeNode(node: TreeNode, targetId: TicketId): string {
  const t = node.ticket;
  const marker = t.id === targetId ? "* " : "  ";
  const labels = t.labels.length > 0 ? ` [${t.labels.join(", ")}]` : "";
  return `${marker}${t.name} (${t.slug}) — ${t.state}, p${t.priority}${labels}`;
}

/**
 * Render `tree` as indented text lines, `targetId` marked with a leading
 * `*`. `externalParentRef`, when given (the local root's own `parent`
 * field, if it's external), renders as a badge line above the whole tree
 * — never a traversable node, exactly D1's "terminates the local tree."
 */
export function renderTreeLines(
  tree: TreeNode,
  targetId: TicketId,
  externalParentRef?: string,
  jiraUrl?: string | null,
): string[] {
  const lines: string[] = [];
  if (externalParentRef !== undefined) {
    lines.push(
      `↑ ${externalParentRef}${jiraUrl ? ` (${jiraUrl})` : ""}  (external parent — not a local ticket)`,
    );
  }

  function walk(node: TreeNode, depth: number): void {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${describeNode(node, targetId)}`);
    for (const child of node.children) walk(child, depth + 1);
  }
  walk(tree, 0);
  return lines;
}
