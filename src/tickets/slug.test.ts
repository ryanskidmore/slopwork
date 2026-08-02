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
import { FlatfileBackend } from "../storage/flatfile.js";
import { pickSlug, takenSlugs } from "./slug.js";

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
  scratch = await mkdtemp(join(tmpdir(), "slop-slug-test-"));
  paths = await ensureDbDirs(scratch);
  backend = new FlatfileBackend(paths);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("pickSlug (D12: collision suffix)", () => {
  it("returns the plain slugified name when it's free", async () => {
    expect(await pickSlug(backend, "Add auth provider")).toBe("add-auth-provider");
  });

  it("appends -2, -3, ... on collision, against real on-disk slugs", async () => {
    await createTicket(paths, makeTicket({ slug: "add-auth-provider" }), ctx, createdEvent);
    expect(await pickSlug(backend, "Add auth provider")).toBe("add-auth-provider-2");

    await createTicket(paths, makeTicket({ slug: "add-auth-provider-2" }), ctx, createdEvent);
    expect(await pickSlug(backend, "Add auth provider")).toBe("add-auth-provider-3");
  });

  it("sees slugs created in a prior call (index self-heals across calls)", async () => {
    const first = await pickSlug(backend, "Same name");
    await createTicket(paths, makeTicket({ slug: first }), ctx, createdEvent);
    const second = await pickSlug(backend, "Same name");
    expect(second).not.toBe(first);
    expect(second).toBe("same-name-2");
  });
});

describe("takenSlugs", () => {
  it("is empty against a fresh db", async () => {
    await expect(takenSlugs(backend)).resolves.toEqual(new Set());
  });

  it("reflects every slug on disk", async () => {
    await createTicket(paths, makeTicket({ slug: "one" }), ctx, createdEvent);
    await createTicket(paths, makeTicket({ slug: "two" }), ctx, createdEvent);
    await expect(takenSlugs(backend)).resolves.toEqual(new Set(["one", "two"]));
  });
});
