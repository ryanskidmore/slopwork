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
import { buildNewTicket } from "./new.js";
import type { NewTicketInput } from "./new.js";

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
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

function baseInput(overrides: Partial<NewTicketInput> = {}): NewTicketInput {
  return {
    name: "Add auth provider",
    blocksRaw: [],
    labels: [],
    draft: false,
    adhoc: false,
    priority: 2,
    actor,
    ...overrides,
  };
}

let scratch: string;
let paths: RepoPaths;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-new-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("buildNewTicket — every §4.2 `new` creation flag", () => {
  it("bare name only: sensible defaults everywhere", async () => {
    const { ticket, warnings } = await buildNewTicket(paths, baseInput(), clock);
    expect(ticket.name).toBe("Add auth provider");
    expect(ticket.slug).toBe("add-auth-provider");
    expect(ticket.spec).toEqual({
      summary: "Add auth provider",
      details_md: "",
      acceptance: [],
      context: [],
      meta: {},
      v: 1,
    });
    expect(ticket.state).toBe("open");
    expect(ticket.priority).toBe(2);
    expect(ticket.labels).toEqual([]);
    expect(ticket.adhoc).toBe(false);
    expect(ticket.parent).toBeUndefined();
    expect(ticket.root_id).toBe(ticket.id);
    expect(ticket.path).toEqual([]);
    expect(ticket.owner).toBeNull();
    expect(ticket.blocks).toEqual([]);
    expect(ticket.discovered_from).toEqual([]);
    expect(ticket.provenance).toEqual({ method: "new", created_by: actor });
    expect(ticket.created_at).toBe("2026-07-23T12:00:00.000Z");
    expect(warnings).toEqual([]);
  });

  it("--spec (JSON, structural)", async () => {
    const { ticket } = await buildNewTicket(
      paths,
      baseInput({ specRaw: JSON.stringify({ summary: "Custom", acceptance: ["a"] }) }),
      clock,
    );
    expect(ticket.spec.summary).toBe("Custom");
    expect(ticket.spec.acceptance).toEqual(["a"]);
  });

  it("--spec (bare markdown -> details_md, D10)", async () => {
    const { ticket } = await buildNewTicket(
      paths,
      baseInput({ specRaw: "# Notes\nSome prose." }),
      clock,
    );
    expect(ticket.spec.details_md).toBe("# Notes\nSome prose.");
    expect(ticket.spec.summary).toBe("Add auth provider");
  });

  it("--parent (local, resolved via slug)", async () => {
    const parent = makeTicket({ name: "Parent", slug: "parent" });
    await createTicket(paths, parent, ctx, createdEvent);
    const { ticket } = await buildNewTicket(paths, baseInput({ parentRaw: "parent" }), clock);
    expect(ticket.parent).toBe(parent.id);
    expect(ticket.root_id).toBe(parent.id);
    expect(ticket.path).toEqual([parent.id]);
  });

  it("--parent jira:PROJ-123 (external; local root; warns only on malformed key)", async () => {
    const { ticket, warnings } = await buildNewTicket(
      paths,
      baseInput({ parentRaw: "jira:PROJ-123" }),
      clock,
    );
    expect(ticket.parent).toBe("jira:PROJ-123");
    expect(ticket.root_id).toBe(ticket.id);
    expect(ticket.path).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("--parent jira:malformed still creates, with a warning, never blocking (§8.2 item 5)", async () => {
    const { ticket, warnings } = await buildNewTicket(
      paths,
      baseInput({ parentRaw: "jira:not-a-key" }),
      clock,
    );
    expect(ticket.parent).toBe("jira:not-a-key");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/doesn't look like/);
  });

  it("--blocks (repeatable, resolved to ticket ids)", async () => {
    const b1 = makeTicket({ slug: "b1" });
    const b2 = makeTicket({ slug: "b2" });
    await createTicket(paths, b1, ctx, createdEvent);
    await createTicket(paths, b2, ctx, createdEvent);
    const { ticket } = await buildNewTicket(paths, baseInput({ blocksRaw: ["b1", "b2"] }), clock);
    expect(ticket.blocks.sort()).toEqual([b1.id, b2.id].sort());
  });

  it("--discovered-from (resolved to a one-element array)", async () => {
    const origin = makeTicket({ slug: "origin" });
    await createTicket(paths, origin, ctx, createdEvent);
    const { ticket } = await buildNewTicket(
      paths,
      baseInput({ discoveredFromRaw: "origin" }),
      clock,
    );
    expect(ticket.discovered_from).toEqual([origin.id]);
  });

  it("--label (repeatable)", async () => {
    const { ticket } = await buildNewTicket(
      paths,
      baseInput({ labels: ["type:feature", "team:core"] }),
      clock,
    );
    expect(ticket.labels).toEqual(["type:feature", "team:core"]);
  });

  it("--draft (state draft; D13: drafts never ready)", async () => {
    const { ticket } = await buildNewTicket(paths, baseInput({ draft: true }), clock);
    expect(ticket.state).toBe("draft");
  });

  it("--adhoc", async () => {
    const { ticket } = await buildNewTicket(paths, baseInput({ adhoc: true }), clock);
    expect(ticket.adhoc).toBe(true);
  });

  it("--owner", async () => {
    const { ticket } = await buildNewTicket(paths, baseInput({ ownerRaw: "ryan" }), clock);
    expect(ticket.owner).toEqual({ name: "ryan", kind: "human" });
  });

  it("--priority", async () => {
    const { ticket } = await buildNewTicket(paths, baseInput({ priority: 0 }), clock);
    expect(ticket.priority).toBe(0);
  });

  it("rejects an out-of-range priority as a usage error", async () => {
    await expect(buildNewTicket(paths, baseInput({ priority: 9 }), clock)).rejects.toMatchObject({
      exitCode: 2,
    });
  });

  it("all flags combined at once", async () => {
    const parent = makeTicket({ slug: "combo-parent" });
    const blocker = makeTicket({ slug: "combo-blocker" });
    const origin = makeTicket({ slug: "combo-origin" });
    await createTicket(paths, parent, ctx, createdEvent);
    await createTicket(paths, blocker, ctx, createdEvent);
    await createTicket(paths, origin, ctx, createdEvent);

    const { ticket, warnings } = await buildNewTicket(
      paths,
      baseInput({
        specRaw: JSON.stringify({ summary: "Combo summary" }),
        parentRaw: "combo-parent",
        blocksRaw: ["combo-blocker"],
        discoveredFromRaw: "combo-origin",
        labels: ["a:b"],
        draft: true,
        adhoc: true,
        ownerRaw: "ryan",
        priority: 0,
      }),
      clock,
    );

    expect(ticket.spec.summary).toBe("Combo summary");
    expect(ticket.parent).toBe(parent.id);
    expect(ticket.root_id).toBe(parent.id);
    expect(ticket.path).toEqual([parent.id]);
    expect(ticket.blocks).toEqual([blocker.id]);
    expect(ticket.discovered_from).toEqual([origin.id]);
    expect(ticket.labels).toEqual(["a:b"]);
    expect(ticket.state).toBe("draft");
    expect(ticket.adhoc).toBe(true);
    expect(ticket.owner).toEqual({ name: "ryan", kind: "human" });
    expect(ticket.priority).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("throws NOT_FOUND for an unresolvable --blocks ref", async () => {
    await expect(
      buildNewTicket(paths, baseInput({ blocksRaw: ["no-such-ticket"] }), clock),
    ).rejects.toMatchObject({ exitCode: 4 });
  });
});
