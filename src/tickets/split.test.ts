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
import { buildSplitChild } from "./split.js";

const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };
const actor = { name: "ryan", kind: "human" as const };
const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "Ticket",
    slug: `ticket-${id.slice(-8).toLowerCase()}`,
    spec: { summary: "s" },
    state: "open",
    priority: 2,
    labels: [],
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
  scratch = await mkdtemp(join(tmpdir(), "slop-split-test-"));
  paths = await ensureDbDirs(scratch);
  backend = new FlatfileBackend(paths);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("buildSplitChild — provenance, edges, ancestry, inheritance", () => {
  it("sets parent = the split target, AND a discovered-from edge back to it (this work item's acceptance criterion)", async () => {
    const target = makeTicket({ slug: "target", name: "Target ticket" });
    await createTicket(paths, target, ctx, createdEvent);

    const { ticket: child } = await buildSplitChild(
      backend,
      { name: "Sub 1", parent: target, actor },
      clock,
    );

    expect(child.parent).toBe(target.id);
    expect(child.discovered_from).toEqual([target.id]);
  });

  it("computes root_id/path from the split target (one level below it)", async () => {
    const target = makeTicket({ slug: "target-root", name: "Target root" });
    await createTicket(paths, target, ctx, createdEvent);

    const { ticket: child } = await buildSplitChild(
      backend,
      { name: "Sub", parent: target, actor },
      clock,
    );

    expect(child.root_id).toBe(target.id);
    expect(child.path).toEqual([target.id]);
  });

  it('sets provenance = {method: "split", created_by: actor, split_from: <target id>}', async () => {
    const target = makeTicket({ slug: "prov-target" });
    await createTicket(paths, target, ctx, createdEvent);

    const { ticket: child } = await buildSplitChild(
      backend,
      { name: "Sub", parent: target, actor },
      clock,
    );

    expect(child.provenance).toEqual({
      method: "split",
      created_by: actor,
      split_from: target.id,
    });
  });

  it("two levels deep: splitting a child of an already-parented ticket produces correct grandchild ancestry", async () => {
    const root = makeTicket({ slug: "gp-root" });
    await createTicket(paths, root, ctx, createdEvent);
    const mid = makeTicket({ slug: "gp-mid", parent: root.id, root_id: root.id, path: [root.id] });
    await createTicket(paths, mid, ctx, createdEvent);

    const { ticket: leaf } = await buildSplitChild(
      backend,
      { name: "Leaf", parent: mid, actor },
      clock,
    );

    expect(leaf.parent).toBe(mid.id);
    expect(leaf.root_id).toBe(root.id);
    expect(leaf.path).toEqual([root.id, mid.id]);
    expect(leaf.discovered_from).toEqual([mid.id]);
  });

  it("splitting a ticket whose OWN parent is external (jira:) parents the child to the local split target (D1)", async () => {
    // D1: an externally-parented ticket is its own local root — `makeTicket`'s
    // defaults (root_id: id, path: []) already represent exactly that.
    const jiraParented = makeTicket({ slug: "jira-parented", parent: "jira:PROJ-1" });
    await createTicket(paths, jiraParented, ctx, createdEvent);

    const { ticket: child } = await buildSplitChild(
      backend,
      { name: "Child of jira-parented", parent: jiraParented, actor },
      clock,
    );

    expect(child.parent).toBe(jiraParented.id);
    expect(child.root_id).toBe(jiraParented.id);
    expect(child.path).toEqual([jiraParented.id]);
    expect(child.discovered_from).toEqual([jiraParented.id]);
  });

  it("inherits labels and priority from the split target", async () => {
    const target = makeTicket({
      slug: "inherit-target",
      labels: ["team:core", "type:bug"],
      priority: 0,
    });
    await createTicket(paths, target, ctx, createdEvent);

    const { ticket: child } = await buildSplitChild(
      backend,
      { name: "Sub", parent: target, actor },
      clock,
    );

    expect(child.labels).toEqual(["team:core", "type:bug"]);
    expect(child.priority).toBe(0);
  });

  it("does NOT inherit owner, adhoc, state, or spec from the split target", async () => {
    const target = makeTicket({
      slug: "no-inherit-target",
      owner: { name: "ryan", kind: "human" },
      provenance: { method: "adhoc", created_by: { name: "ryan", kind: "human" } },
      state: "in_progress",
      spec: {
        summary: "Target summary",
        details_md: "target details",
        acceptance: [],
        context: [],
        meta: {},
        v: 1,
      },
    });
    await createTicket(paths, target, ctx, createdEvent);

    const { ticket: child } = await buildSplitChild(
      backend,
      { name: "Fresh child", parent: target, actor },
      clock,
    );

    expect(child.owner).toBeNull();
    expect(child.provenance.method).toBe("split");
    expect(child.state).toBe("open");
    expect(child.spec.summary).toBe("Fresh child");
    expect(child.spec.details_md).toBe("");
  });

  it("assigns a fresh, name-derived slug per child, collision-suffixed against the live taken-set", async () => {
    const target = makeTicket({ slug: "slug-target" });
    await createTicket(paths, target, ctx, createdEvent);

    const { ticket: first } = await buildSplitChild(
      backend,
      { name: "Same name", parent: target, actor },
      clock,
    );
    await createTicket(paths, first, ctx, createdEvent);
    const { ticket: second } = await buildSplitChild(
      backend,
      { name: "Same name", parent: target, actor },
      clock,
    );

    expect(first.slug).toBe("same-name");
    expect(second.slug).toBe("same-name-2");
  });

  it("rejects a blank name as a USAGE_ERROR (exit 2)", async () => {
    const target = makeTicket({ slug: "blank-name-target" });
    await createTicket(paths, target, ctx, createdEvent);

    await expect(
      buildSplitChild(backend, { name: "   ", parent: target, actor }, clock),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("blocks/relates_to start empty on a split child", async () => {
    const target = makeTicket({ slug: "empty-edges-target" });
    await createTicket(paths, target, ctx, createdEvent);

    const { ticket: child } = await buildSplitChild(
      backend,
      { name: "Sub", parent: target, actor },
      clock,
    );

    expect(child.blocks).toEqual([]);
    expect(child.relates_to).toEqual([]);
  });
});
