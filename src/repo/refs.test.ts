import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Ticket, newTicketId, ticketSchema } from "../core/index.js";
import type { IndexTicketRow } from "./db-index.js";
import type { EventContext, MutationEventSpec } from "./events.js";
import { ambiguousRefMessage, resolveTicketRef } from "./refs.js";
import { ensureDbDirs } from "./paths.js";
import type { RepoPaths } from "./paths.js";
import { createTicket } from "./tickets.js";

// A4: createTicket now requires an EventContext + a MutationEventSpec —
// these fixtures don't exercise event behavior, so a single fixed pair is
// reused across every createTicket call below.
const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };

function makeIndexRow(overrides: Partial<IndexTicketRow> & Pick<IndexTicketRow, "id">): IndexTicketRow {
  return {
    slug: "x",
    name: "X",
    state: "open",
    priority: 2,
    parent: null,
    root_id: overrides.id,
    path: [],
    labels: [],
    last_activity_at: "2026-07-23T10:00:00.000Z",
    active_session: null,
    blocked_by: [],
    related_from: [],
    discovered: [],
    blocked_count: null,
    ready: null,
    stale: null,
    review_stale: null,
    ...overrides,
  };
}

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
  scratch = await mkdtemp(join(tmpdir(), "slop-refs-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("resolveTicketRef — full id (exit criterion: not found -> exit 4)", () => {
  it("resolves by the full ticket_<ULID> id", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    await expect(resolveTicketRef(paths, t.id)).resolves.toEqual(t);
  });

  it("a well-formed but nonexistent full id is NOT_FOUND (exit 4)", async () => {
    await expect(resolveTicketRef(paths, newTicketId())).rejects.toMatchObject({ exitCode: 4 });
  });

  it("a ref that matches nothing at all is NOT_FOUND (exit 4)", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    await expect(resolveTicketRef(paths, "totally-unknown-ref")).rejects.toMatchObject({
      exitCode: 4,
    });
  });
});

describe("resolveTicketRef — exact slug", () => {
  it("resolves by exact slug", async () => {
    const t = makeTicket({ slug: "add-sso" });
    await createTicket(paths, t, ctx, createdEvent);
    await expect(resolveTicketRef(paths, "add-sso")).resolves.toEqual(t);
  });

  it("an exact slug match wins over an ambiguous short-prefix interpretation", async () => {
    // Two tickets whose ids share a prefix that happens to equal a
    // THIRD ticket's slug exactly — resolving by that slug string must
    // pick the slug match, not error out as an ambiguous prefix.
    const shared = "01ARZ3NDEKTSV4RRFFQ69G5FA";
    const idA = `ticket_${shared}1` as Ticket["id"];
    const idB = `ticket_${shared}2` as Ticket["id"];
    const a = makeTicket({ id: idA, root_id: idA, slug: "candidate-a" });
    const b = makeTicket({ id: idB, root_id: idB, slug: "candidate-b" });
    const slugTicket = makeTicket({ slug: shared.toLowerCase() });
    await createTicket(paths, a, ctx, createdEvent);
    await createTicket(paths, b, ctx, createdEvent);
    await createTicket(paths, slugTicket, ctx, createdEvent);

    // shared.toLowerCase() as a REF also happens to be a prefix of both
    // a.id's and b.id's bare ULID (since they share that literal
    // prefix) — without the "slug wins" rule this would be ambiguous.
    const resolved = await resolveTicketRef(paths, shared.toLowerCase());
    expect(resolved.id).toBe(slugTicket.id);
  });
});

describe("resolveTicketRef — unique short prefix, ambiguous prefix (git-style)", () => {
  it("resolves a unique short prefix", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    const shortRef = t.id.slice("ticket_".length, "ticket_".length + 8);
    await expect(resolveTicketRef(paths, shortRef)).resolves.toEqual(t);
  });

  it("an ambiguous short prefix errors git-style with exit code 5 and lists every candidate", async () => {
    const shared = "01ARZ3NDEKTSV4RRFFQ69G5FA";
    const idA = `ticket_${shared}1` as Ticket["id"];
    const idB = `ticket_${shared}2` as Ticket["id"];
    const a = makeTicket({ id: idA, root_id: idA, name: "Alpha ticket", slug: "alpha-ticket" });
    const b = makeTicket({ id: idB, root_id: idB, name: "Beta ticket", slug: "beta-ticket" });
    await createTicket(paths, a, ctx, createdEvent);
    await createTicket(paths, b, ctx, createdEvent);

    let threw: unknown;
    try {
      await resolveTicketRef(paths, shared.slice(0, 10));
    } catch (err) {
      threw = err;
    }
    expect(threw).toMatchObject({ exitCode: 5 });
    const message = (threw as Error).message;
    expect(message).toMatch(/ambiguous/i);
    expect(message).toContain(a.id);
    expect(message).toContain(b.id);
    expect(message).toContain(a.name);
    expect(message).toContain(b.name);
    expect(message).toContain(a.slug);
    expect(message).toContain(b.slug);
  });

  it("ambiguousRefMessage is modeled on git's error format", () => {
    const a = makeIndexRow({
      id: "ticket_01ARZ3NDEKTSV4RRFFQ69G5FA1" as Ticket["id"],
      slug: "alpha",
      name: "Alpha",
    });
    const b = makeIndexRow({
      id: "ticket_01ARZ3NDEKTSV4RRFFQ69G5FA2" as Ticket["id"],
      slug: "beta",
      name: "Beta",
    });
    const message = ambiguousRefMessage("01ARZ", [a, b]);
    expect(message).toMatch(/^short ref "01ARZ" is ambiguous/);
    expect(message).toContain("hint: the candidates are:");
    expect(message).toContain('hint:   ticket_01ARZ3NDEKTSV4RRFFQ69G5FA1  "Alpha" (alpha)');
  });
});

describe("resolveTicketRef — external refs are not resolvable (D1)", () => {
  it("a jira: ref throws a distinct, clearly-worded USAGE_ERROR (exit 2), not NOT_FOUND", async () => {
    let threw: unknown;
    try {
      await resolveTicketRef(paths, "jira:PROJ-123");
    } catch (err) {
      threw = err;
    }
    expect(threw).toMatchObject({ exitCode: 2 });
    expect((threw as Error).message).toMatch(/external ref/i);
    expect((threw as Error).message).toMatch(/--parent/);
  });
});

describe("resolveTicketRef — auto-heals the index (exercises the A3 self-heal path via an ordinary read)", () => {
  it("resolves correctly even when index.jsonc has never been written", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    // paths.indexFile deliberately never created — a fresh clone, or a
    // repo where reindex has never run.
    await expect(resolveTicketRef(paths, t.slug)).resolves.toEqual(t);
  });
});
