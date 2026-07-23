import { describe, expect, it } from "vitest";
import type { Ticket } from "../core/index.js";
import { newTicketId, ticketSchema } from "../core/index.js";
import { buildTree, pathToTarget, renderTreeLines } from "./tree.js";

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: `slug-${id.slice(-6).toLowerCase()}`,
    spec: { summary: "s" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

describe("buildTree", () => {
  it("builds a root with nested children, sorted by name", () => {
    const root = makeTicket({ name: "Root" });
    const childB = makeTicket({
      name: "B child",
      parent: root.id,
      root_id: root.id,
      path: [root.id],
    });
    const childA = makeTicket({
      name: "A child",
      parent: root.id,
      root_id: root.id,
      path: [root.id],
    });
    const grandchild = makeTicket({
      name: "Grandchild",
      parent: childA.id,
      root_id: root.id,
      path: [root.id, childA.id],
    });

    const tree = buildTree(root.id, [root, childB, childA, grandchild]);
    expect(tree.ticket.id).toBe(root.id);
    expect(tree.children.map((c) => c.ticket.name)).toEqual(["A child", "B child"]);
    const aNode = tree.children.find((c) => c.ticket.id === childA.id);
    expect(aNode?.children.map((c) => c.ticket.id)).toEqual([grandchild.id]);
  });

  it("throws if the root id isn't in the given ticket list", () => {
    expect(() => buildTree(newTicketId(), [])).toThrow();
  });

  it("guards against a cycle rather than infinite-looping (defensive; B3 prevents this at write time)", () => {
    const a = makeTicket({ name: "A" });
    const b = makeTicket({ name: "B", parent: a.id, root_id: a.id, path: [a.id] });
    // Hand-construct a cycle: a's parent points back at b (not something
    // B1/B3 would ever produce, but the renderer must still not hang).
    const aCyclic: Ticket = { ...a, parent: b.id };
    const tree = buildTree(aCyclic.id, [aCyclic, b]);
    // Should terminate and produce *some* tree without throwing/looping.
    expect(tree.ticket.id).toBe(a.id);
  });
});

describe("pathToTarget", () => {
  it("finds the chain from root to a nested target", () => {
    const root = makeTicket({ name: "Root" });
    const child = makeTicket({ name: "Child", parent: root.id, root_id: root.id, path: [root.id] });
    const tree = buildTree(root.id, [root, child]);
    const path = pathToTarget(tree, child.id);
    expect(path?.map((n) => n.ticket.id)).toEqual([root.id, child.id]);
  });

  it("returns null when the target isn't in the tree", () => {
    const root = makeTicket({ name: "Root" });
    const tree = buildTree(root.id, [root]);
    expect(pathToTarget(tree, newTicketId())).toBeNull();
  });
});

describe("renderTreeLines", () => {
  it("marks the target ticket and indents children", () => {
    const root = makeTicket({ name: "Root" });
    const child = makeTicket({ name: "Child", parent: root.id, root_id: root.id, path: [root.id] });
    const tree = buildTree(root.id, [root, child]);
    const lines = renderTreeLines(tree, child.id);
    expect(lines[0]).toContain("Root");
    expect(lines[0]).not.toMatch(/^\*/);
    expect(lines[1]).toContain("Child");
    expect(lines[1]?.trim().startsWith("*")).toBe(true);
  });

  it("renders an external-parent badge above the tree, with the jira URL when given", () => {
    const root = makeTicket({ name: "Root", parent: "jira:PROJ-1" });
    const tree = buildTree(root.id, [root]);
    const lines = renderTreeLines(
      tree,
      root.id,
      "jira:PROJ-1",
      "https://example.atlassian.net/browse/PROJ-1",
    );
    expect(lines[0]).toContain("jira:PROJ-1");
    expect(lines[0]).toContain("https://example.atlassian.net/browse/PROJ-1");
    expect(lines[0]).toContain("external parent");
  });

  it("renders the external-parent badge without a URL when none is given (no remotes.jira configured)", () => {
    const root = makeTicket({ name: "Root", parent: "jira:PROJ-1" });
    const tree = buildTree(root.id, [root]);
    const lines = renderTreeLines(tree, root.id, "jira:PROJ-1", null);
    expect(lines[0]).toContain("jira:PROJ-1");
    expect(lines[0]).not.toContain("http");
  });
});
