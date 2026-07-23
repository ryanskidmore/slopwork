import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ticket } from "../core/index.js";
import { newTicketId, ticketSchema } from "../core/index.js";
import type { EventContext, MutationEventSpec } from "../repo/events.js";
import { ensureDbDirs } from "../repo/paths.js";
import type { RepoPaths } from "../repo/paths.js";
import { createTicket } from "../repo/tickets.js";
import { ancestryFor, resolveParentRef } from "./parent.js";

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

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-parent-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("resolveParentRef", () => {
  it("returns kind 'none' when no --parent was given", async () => {
    expect(await resolveParentRef(paths, undefined)).toEqual({ kind: "none" });
  });

  it("resolves a local parent by full id / slug / short prefix (D12/D6)", async () => {
    const parent = makeTicket({ name: "Parent ticket", slug: "parent-ticket" });
    await createTicket(paths, parent, ctx, createdEvent);

    await expect(resolveParentRef(paths, parent.id)).resolves.toEqual({
      kind: "local",
      ticket: parent,
    });
    await expect(resolveParentRef(paths, "parent-ticket")).resolves.toEqual({
      kind: "local",
      ticket: parent,
    });
    await expect(resolveParentRef(paths, parent.id.slice(0, 14))).resolves.toEqual({
      kind: "local",
      ticket: parent,
    });
  });

  it("throws NOT_FOUND for a local ref that doesn't resolve", async () => {
    await expect(resolveParentRef(paths, "no-such-slug")).rejects.toMatchObject({ exitCode: 4 });
  });

  it("accepts a well-formed jira: ref as external, with no warning (§8.2 item 5)", async () => {
    const result = await resolveParentRef(paths, "jira:PROJ-123");
    expect(result).toEqual({ kind: "external", ref: "jira:PROJ-123", warning: undefined });
  });

  it("accepts a malformed jira: ref as external too, WARNING but never blocking (§8.2 item 5)", async () => {
    const result = await resolveParentRef(paths, "jira:not-a-key");
    expect(result.kind).toBe("external");
    if (result.kind === "external") {
      expect(result.warning).toBeDefined();
      expect(result.warning).toMatch(/doesn't look like/);
    }
  });

  it("accepts a non-jira external ref with no warning at all", async () => {
    const result = await resolveParentRef(paths, "gh:123");
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
