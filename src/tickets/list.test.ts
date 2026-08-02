import { describe, expect, it } from "vitest";
import { newTicketId, ticketSchema } from "../core/index.js";
import type { Ticket, TicketId } from "../core/index.js";
import { compareListOrder, filterTickets, paginateTickets } from "./list.js";
import { defaultSpec } from "./spec.js";

function makeTicket(
  overrides: Partial<Omit<Ticket, "spec">> & { name: string; summary?: string },
): Ticket {
  const id = overrides.id ?? newTicketId();
  const { summary, ...rest } = overrides;
  return ticketSchema.parse({
    id,
    slug: `ticket-${id.slice(-10).toLowerCase()}`,
    spec: defaultSpec(summary ?? rest.name),
    state: "open",
    priority: 2,
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...rest,
  });
}

function idsInOrder(n: number): TicketId[] {
  const ids: TicketId[] = [];
  for (let i = 0; i < n; i++) ids.push(newTicketId());
  return ids.sort();
}

describe("compareListOrder", () => {
  it("state is the primary key, in TICKET_STATES' own declared order", () => {
    const [olderId, newerId] = idsInOrder(2);
    const done = makeTicket({ id: olderId, name: "Done ticket", state: "done", priority: 0 });
    const open = makeTicket({ id: newerId, name: "Open ticket", state: "open", priority: 3 });
    // Even though `open` has a more urgent priority, `done` sorts AFTER it
    // — state beats priority.
    const sorted = [done, open].sort(compareListOrder);
    expect(sorted.map((t) => t.name)).toEqual(["Open ticket", "Done ticket"]);
  });

  it("priority is the secondary key, within the same state", () => {
    const [a, b] = idsInOrder(2);
    const low = makeTicket({ id: a, name: "Low", state: "open", priority: 3 });
    const urgent = makeTicket({ id: b, name: "Urgent", state: "open", priority: 0 });
    const sorted = [low, urgent].sort(compareListOrder);
    expect(sorted.map((t) => t.name)).toEqual(["Urgent", "Low"]);
  });

  it("age (id) is the tiebreak — oldest first — within the same state+priority", () => {
    const [older, newer] = idsInOrder(2);
    const newerTicket = makeTicket({ id: newer, name: "Newer", state: "open", priority: 1 });
    const olderTicket = makeTicket({ id: older, name: "Older", state: "open", priority: 1 });
    const sorted = [newerTicket, olderTicket].sort(compareListOrder);
    expect(sorted.map((t) => t.name)).toEqual(["Older", "Newer"]);
  });
});

describe("filterTickets", () => {
  it("--state is OR across values", () => {
    const draft = makeTicket({ name: "Draft", state: "draft" });
    const open = makeTicket({ name: "Open", state: "open" });
    const done = makeTicket({ name: "Done", state: "done" });
    const result = filterTickets([draft, open, done], { states: ["draft", "done"] });
    expect(result.map((t) => t.name).sort()).toEqual(["Done", "Draft"]);
  });

  it("no --state filter includes every state, including drafts (unlike ready)", () => {
    const draft = makeTicket({ name: "Draft", state: "draft" });
    const result = filterTickets([draft], {});
    expect(result).toHaveLength(1);
  });

  it("--label is AND across values", () => {
    const both = makeTicket({ name: "Both", labels: ["area:auth", "team:infra"] });
    const oneOnly = makeTicket({ name: "One", labels: ["area:auth"] });
    const result = filterTickets([both, oneOnly], { labels: ["area:auth", "team:infra"] });
    expect(result.map((t) => t.name)).toEqual(["Both"]);
  });

  it("--owner matches by name only, kind ignored", () => {
    const humanOwned = makeTicket({
      name: "Human",
      owner: { name: "priya", kind: "human" },
    });
    const agentOwned = makeTicket({
      name: "Agent",
      owner: { name: "priya", kind: "agent" },
    });
    const unowned = makeTicket({ name: "Unowned" });
    const result = filterTickets([humanOwned, agentOwned, unowned], { owner: "priya" });
    expect(result.map((t) => t.name).sort()).toEqual(["Agent", "Human"]);
  });

  it("--priority matches exactly", () => {
    const urgent = makeTicket({ name: "Urgent", priority: 0 });
    const low = makeTicket({ name: "Low", priority: 3 });
    expect(filterTickets([urgent, low], { priority: 0 }).map((t) => t.name)).toEqual(["Urgent"]);
  });

  it("--parent matches DIRECT children only, not grandchildren", () => {
    const root = makeTicket({ name: "Root" });
    const child = makeTicket({ name: "Child", parent: root.id, root_id: root.id, path: [root.id] });
    const grandchild = makeTicket({
      name: "Grandchild",
      parent: child.id,
      root_id: root.id,
      path: [root.id, child.id],
    });
    const result = filterTickets([root, child, grandchild], { parentId: root.id });
    expect(result.map((t) => t.name)).toEqual(["Child"]);
  });

  it("--subtree matches the whole descendant tree, INCLUSIVE of the root itself", () => {
    const root = makeTicket({ name: "Root" });
    const child = makeTicket({ name: "Child", parent: root.id, root_id: root.id, path: [root.id] });
    const grandchild = makeTicket({
      name: "Grandchild",
      parent: child.id,
      root_id: root.id,
      path: [root.id, child.id],
    });
    const unrelated = makeTicket({ name: "Unrelated" });
    const result = filterTickets([root, child, grandchild, unrelated], { subtreeId: root.id });
    expect(result.map((t) => t.name).sort()).toEqual(["Child", "Grandchild", "Root"]);
  });

  it("free-text matches name, slug, or spec.summary — case-insensitive", () => {
    const byName = makeTicket({ name: "Widget factory rewrite" });
    const bySlug = makeTicket({ name: "Something else", slug: "widget-slug-match" });
    const bySummary = makeTicket({ name: "Another name", summary: "mentions widget here" });
    const noMatch = makeTicket({ name: "Unrelated" });
    const result = filterTickets([byName, bySlug, bySummary, noMatch], { text: "WIDGET" });
    expect(result.map((t) => t.name).sort()).toEqual([
      "Another name",
      "Something else",
      "Widget factory rewrite",
    ]);
  });

  it("every filter composes with AND across different filter kinds", () => {
    const matches = makeTicket({ name: "Matches", state: "open", priority: 1, labels: ["x"] });
    const wrongPriority = makeTicket({
      name: "Wrong priority",
      state: "open",
      priority: 2,
      labels: ["x"],
    });
    const result = filterTickets([matches, wrongPriority], {
      states: ["open"],
      labels: ["x"],
      priority: 1,
    });
    expect(result.map((t) => t.name)).toEqual(["Matches"]);
  });

  it("an empty options object matches everything, sorted", () => {
    const a = makeTicket({ name: "A", priority: 3 });
    const b = makeTicket({ name: "B", priority: 0 });
    expect(filterTickets([a, b], {}).map((t) => t.name)).toEqual(["B", "A"]);
  });
});

describe("paginateTickets", () => {
  const items = ["a", "b", "c", "d", "e"];

  it("no limit/offset returns everything with the true total", () => {
    expect(paginateTickets(items, 0, undefined)).toEqual({ page: items, total: 5 });
  });

  it("limit caps the page but total still reflects the full filtered count", () => {
    expect(paginateTickets(items, 0, 2)).toEqual({ page: ["a", "b"], total: 5 });
  });

  it("offset skips leading entries", () => {
    expect(paginateTickets(items, 2, undefined)).toEqual({ page: ["c", "d", "e"], total: 5 });
  });

  it("offset + limit compose", () => {
    expect(paginateTickets(items, 1, 2)).toEqual({ page: ["b", "c"], total: 5 });
  });

  it("an offset past the end returns an empty page, not an error", () => {
    expect(paginateTickets(items, 10, undefined)).toEqual({ page: [], total: 5 });
  });
});
