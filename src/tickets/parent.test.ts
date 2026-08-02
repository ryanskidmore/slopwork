import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../core/clock.js";
import type { Ticket } from "../core/index.js";
import { newTicketId, ticketSchema } from "../core/index.js";
import type { EventContext, MutationEventSpec } from "../repo/events.js";
import { ensureDbDirs } from "../repo/paths.js";
import type { RepoPaths } from "../repo/paths.js";
import { createTicket } from "../repo/tickets.js";
import { FlatfileBackend } from "../storage/flatfile.js";
import { ancestryFor, recomputeAncestry, resolveParentRef } from "./parent.js";

const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "Ticket",
    slug: `ticket-${id.slice(-8).toLowerCase()}`,
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

let scratch: string;
let paths: RepoPaths;
let backend: FlatfileBackend;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-parent-test-"));
  paths = await ensureDbDirs(scratch);
  backend = new FlatfileBackend(paths);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("resolveParentRef", () => {
  it("returns kind 'none' when no --parent was given", async () => {
    expect(await resolveParentRef(backend, undefined)).toEqual({ kind: "none" });
  });

  it("resolves a local parent by full id / slug / short prefix (D12/D6)", async () => {
    const parent = makeTicket({ name: "Parent ticket", slug: "parent-ticket" });
    await createTicket(paths, parent, ctx, createdEvent);

    await expect(resolveParentRef(backend, parent.id)).resolves.toEqual({
      kind: "local",
      ticket: parent,
    });
    await expect(resolveParentRef(backend, "parent-ticket")).resolves.toEqual({
      kind: "local",
      ticket: parent,
    });
    await expect(resolveParentRef(backend, parent.id.slice(0, 14))).resolves.toEqual({
      kind: "local",
      ticket: parent,
    });
  });

  it("throws NOT_FOUND for a local ref that doesn't resolve", async () => {
    await expect(resolveParentRef(backend, "no-such-slug")).rejects.toMatchObject({ exitCode: 4 });
  });

  it("accepts a well-formed jira: ref as external, with no warning (§8.2 item 5)", async () => {
    const result = await resolveParentRef(backend, "jira:PROJ-123");
    expect(result).toEqual({ kind: "external", ref: "jira:PROJ-123", warning: undefined });
  });

  it("accepts a malformed jira: ref as external too, WARNING but never blocking (§8.2 item 5)", async () => {
    const result = await resolveParentRef(backend, "jira:not-a-key");
    expect(result.kind).toBe("external");
    if (result.kind === "external") {
      expect(result.warning).toBeDefined();
      expect(result.warning).toMatch(/doesn't look like/);
    }
  });

  it("accepts a non-jira external ref with no warning at all", async () => {
    const result = await resolveParentRef(backend, "gh:123");
    expect(result).toEqual({ kind: "external", ref: "gh:123", warning: undefined });
  });
});

describe("ancestryFor (D6 root_id/path, D1 external parents terminate the local tree)", () => {
  it("no parent: self is root, empty path", () => {
    const selfId = newTicketId();
    expect(ancestryFor({ kind: "none" }, selfId)).toEqual({
      parent: undefined,
      rootId: selfId,
      path: [],
    });
  });

  it("external parent: self is still a local root, empty path", () => {
    const selfId = newTicketId();
    expect(ancestryFor({ kind: "external", ref: "jira:PROJ-1" }, selfId)).toEqual({
      parent: "jira:PROJ-1",
      rootId: selfId,
      path: [],
    });
  });

  it("local parent: inherits root_id and appends to path", () => {
    const grandparentId = newTicketId();
    const parent = makeTicket({ id: newTicketId(), root_id: grandparentId, path: [grandparentId] });
    const selfId = newTicketId();
    expect(ancestryFor({ kind: "local", ticket: parent }, selfId)).toEqual({
      parent: parent.id,
      rootId: grandparentId,
      path: [grandparentId, parent.id],
    });
  });

  it("local parent that is itself a root: root_id is the parent's own id, path is [parent]", () => {
    const parent = makeTicket();
    const selfId = newTicketId();
    expect(ancestryFor({ kind: "local", ticket: parent }, selfId)).toEqual({
      parent: parent.id,
      rootId: parent.id,
      path: [parent.id],
    });
  });
});

describe("recomputeAncestry (B3: reparenting recomputes root_id/path for the ticket AND every descendant)", () => {
  const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

  it("a no-op edit (parent unchanged) reports changed:false and touches no descendants", () => {
    const root = makeTicket({ slug: "root" });
    const child = makeTicket({ slug: "child", parent: root.id, root_id: root.id, path: [root.id] });
    const result = recomputeAncestry(child, [root], clock);
    expect(result.changed).toBe(false);
    expect(result.descendants).toEqual([]);
    expect(result.ticket).toEqual(child);
  });

  it("becoming a root (parent removed): root_id becomes self, path becomes empty", () => {
    const root = makeTicket({ slug: "root" });
    const child = makeTicket({ slug: "child", parent: root.id, root_id: root.id, path: [root.id] });
    const detached: Ticket = { ...child, parent: undefined };
    const result = recomputeAncestry(detached, [root], clock);
    expect(result.changed).toBe(true);
    expect(result.ticket.root_id).toBe(child.id);
    expect(result.ticket.path).toEqual([]);
    expect(result.descendants).toEqual([]);
  });

  it("reparenting a leaf onto a new local root updates only itself (no descendants)", () => {
    const oldRoot = makeTicket({ slug: "old-root" });
    const newRoot = makeTicket({ slug: "new-root" });
    const leaf = makeTicket({
      slug: "leaf",
      parent: oldRoot.id,
      root_id: oldRoot.id,
      path: [oldRoot.id],
    });
    const reparented: Ticket = { ...leaf, parent: newRoot.id };
    const result = recomputeAncestry(reparented, [oldRoot, newRoot], clock);
    expect(result.changed).toBe(true);
    expect(result.ticket.root_id).toBe(newRoot.id);
    expect(result.ticket.path).toEqual([newRoot.id]);
    expect(result.descendants).toEqual([]);
  });

  it("reparenting a subtree root re-derives root_id/path for every descendant, at every depth, preserving their relative structure", () => {
    // oldRoot -> mid -> leafA
    //                -> leafB -> grandchild
    const oldRoot = makeTicket({ slug: "old-root" });
    const mid = makeTicket({
      slug: "mid",
      parent: oldRoot.id,
      root_id: oldRoot.id,
      path: [oldRoot.id],
    });
    const leafA = makeTicket({
      slug: "leaf-a",
      parent: mid.id,
      root_id: oldRoot.id,
      path: [oldRoot.id, mid.id],
    });
    const leafB = makeTicket({
      slug: "leaf-b",
      parent: mid.id,
      root_id: oldRoot.id,
      path: [oldRoot.id, mid.id],
    });
    const grandchild = makeTicket({
      slug: "grandchild",
      parent: leafB.id,
      root_id: oldRoot.id,
      path: [oldRoot.id, mid.id, leafB.id],
    });
    // An unrelated ticket elsewhere in the db — must NOT show up as a
    // descendant, and must NOT be returned at all.
    const unrelated = makeTicket({ slug: "unrelated" });

    const newRoot = makeTicket({ slug: "new-root" });
    const reparentedMid: Ticket = { ...mid, parent: newRoot.id };

    const others = [oldRoot, leafA, leafB, grandchild, unrelated, newRoot];
    const result = recomputeAncestry(reparentedMid, others, clock);

    expect(result.changed).toBe(true);
    expect(result.ticket.root_id).toBe(newRoot.id);
    expect(result.ticket.path).toEqual([newRoot.id]);

    const byId = new Map(result.descendants.map((t) => [t.id, t] as const));
    expect(byId.size).toBe(3); // leafA, leafB, grandchild — NOT unrelated, NOT oldRoot, NOT newRoot

    const newLeafA = byId.get(leafA.id);
    expect(newLeafA?.root_id).toBe(newRoot.id);
    expect(newLeafA?.path).toEqual([newRoot.id, mid.id]);
    expect(newLeafA?.updated_at).toBe("2026-07-23T12:00:00.000Z");
    // Everything except root_id/path/updated_at is untouched.
    expect(newLeafA?.slug).toBe("leaf-a");
    expect(newLeafA?.parent).toBe(mid.id);

    const newLeafB = byId.get(leafB.id);
    expect(newLeafB?.root_id).toBe(newRoot.id);
    expect(newLeafB?.path).toEqual([newRoot.id, mid.id]);

    const newGrandchild = byId.get(grandchild.id);
    expect(newGrandchild?.root_id).toBe(newRoot.id);
    // The portion of the path BELOW `mid` (mid.id, leafB.id) is preserved
    // verbatim; only the prefix down to and including mid's new ancestor
    // chain is spliced in.
    expect(newGrandchild?.path).toEqual([newRoot.id, mid.id, leafB.id]);

    expect(byId.has(unrelated.id)).toBe(false);
  });

  it("reparenting onto an external parent makes the ticket its own local root (D1)", () => {
    const oldRoot = makeTicket({ slug: "old-root" });
    const child = makeTicket({
      slug: "child",
      parent: oldRoot.id,
      root_id: oldRoot.id,
      path: [oldRoot.id],
    });
    const grandchild = makeTicket({
      slug: "grandchild",
      parent: child.id,
      root_id: oldRoot.id,
      path: [oldRoot.id, child.id],
    });
    const reparented: Ticket = { ...child, parent: "jira:PROJ-1" };
    const result = recomputeAncestry(reparented, [oldRoot, grandchild], clock);

    expect(result.changed).toBe(true);
    expect(result.ticket.root_id).toBe(child.id);
    expect(result.ticket.path).toEqual([]);
    expect(result.descendants).toHaveLength(1);
    expect(result.descendants[0]?.root_id).toBe(child.id);
    expect(result.descendants[0]?.path).toEqual([child.id]);
  });
});
