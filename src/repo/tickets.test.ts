import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Ticket, type TicketId, newTicketId, ticketSchema } from "../core/index.js";
import type { EventContext, MutationEventSpec } from "./events.js";
import { listEvents } from "./events.js";
import { ensureDbDirs } from "./paths.js";
import type { RepoPaths } from "./paths.js";
import {
  createTicket,
  deleteTicket,
  listTicketIds,
  listTickets,
  listTicketsTolerant,
  readTicket,
  ticketFilePath,
  updateTicket,
} from "./tickets.js";

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "Add auth provider",
    slug: `add-auth-provider-${id.slice(-6).toLowerCase()}`,
    spec: { summary: "Add an auth provider" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

// A4: createTicket/updateTicket now require an EventContext + a
// MutationEventSpec on every call (repo/events.ts) — these are the
// fixture defaults for tests below that aren't specifically exercising
// event-emission behavior.
const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };
const updatedEvent: MutationEventSpec = { verb: "ticket.updated" };

let scratch: string;
let paths: RepoPaths;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-tickets-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("ticketFilePath", () => {
  it("is <ticketsDir>/<id>.jsonc", () => {
    const id = newTicketId();
    expect(ticketFilePath(paths, id)).toBe(join(paths.ticketsDir, `${id}.jsonc`));
  });
});

describe("createTicket / readTicket", () => {
  it("round-trips a full ticket", async () => {
    const ticket = makeTicket();
    await createTicket(paths, ticket, ctx, createdEvent);
    await expect(readTicket(paths, ticket.id)).resolves.toEqual(ticket);
  });

  it("readTicket throws NOT_FOUND for an id with no file", async () => {
    await expect(readTicket(paths, newTicketId())).rejects.toMatchObject({ exitCode: 4 });
  });

  it("readTicket surfaces a clear, actionable error for a hand-corrupted file", async () => {
    const id = newTicketId();
    await writeFile(ticketFilePath(paths, id), "{ this is not valid jsonc");
    let threw: unknown;
    try {
      await readTicket(paths, id);
    } catch (err) {
      threw = err;
    }
    expect(threw).toMatchObject({ exitCode: 1 });
    expect((threw as Error).message).toContain(ticketFilePath(paths, id));
  });

  // A4 (co-located unit-level spot check; the general property across the
  // whole mutation surface lives in tests/acceptance/A4.test.ts).
  it("emits exactly one ticket.created event, attributed to the given actor/session/entity", async () => {
    const ticket = makeTicket();
    const sessionCtx: EventContext = { actor: { name: "agent-1", kind: "agent" }, session: null };
    const event = await createTicket(paths, ticket, sessionCtx, {
      verb: "ticket.created",
      payload: { method: "new" },
    });

    const events = await listEvents(paths);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
    expect(event.verb).toBe("ticket.created");
    expect(event.actor).toEqual(sessionCtx.actor);
    expect(event.session).toBeNull();
    expect(event.entity).toEqual({ kind: "ticket", id: ticket.id });
    expect(event.payload).toEqual({ method: "new" });
  });
});

describe("updateTicket", () => {
  it("applies a patch and preserves hand-added comments where possible", async () => {
    const ticket = makeTicket({ priority: 2 });
    await createTicket(paths, ticket, ctx, createdEvent);

    // Simulate a human hand-annotating the file after creation.
    const path = ticketFilePath(paths, ticket.id);
    const original = await readFile(path, "utf8");
    await writeFile(path, `// triaged\n${original}`);

    const after = { ...ticket, priority: 0 };
    await updateTicket(
      paths,
      ticket.id,
      [{ path: ["priority"], value: 0 }],
      after,
      ctx,
      updatedEvent,
    );

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("// triaged");
    await expect(readTicket(paths, ticket.id)).resolves.toEqual(after);
  });

  it("emits exactly one event (on top of the create's own), with the caller-supplied verb", async () => {
    const ticket = makeTicket({ priority: 2 });
    await createTicket(paths, ticket, ctx, createdEvent);
    const after = { ...ticket, priority: 0 };
    const sessionCtx: EventContext = { actor: { name: "agent-2", kind: "agent" }, session: null };
    const event = await updateTicket(
      paths,
      ticket.id,
      [{ path: ["priority"], value: 0 }],
      after,
      sessionCtx,
      { verb: "ticket.updated" },
    );

    const events = await listEvents(paths);
    expect(events).toHaveLength(2); // the create's event, then this one
    expect(events[1]).toEqual(event);
    expect(event.verb).toBe("ticket.updated");
    expect(event.entity).toEqual({ kind: "ticket", id: ticket.id });
  });

  it("throws NOT_FOUND against a nonexistent ticket and emits no event", async () => {
    const fakeAfter = makeTicket();
    await expect(
      updateTicket(
        paths,
        newTicketId(),
        [{ path: ["priority"], value: 0 }],
        fakeAfter,
        ctx,
        updatedEvent,
      ),
    ).rejects.toMatchObject({ exitCode: 4 });
    await expect(listEvents(paths)).resolves.toEqual([]);
  });
});

describe("deleteTicket", () => {
  it("removes the ticket file", async () => {
    const ticket = makeTicket();
    await createTicket(paths, ticket, ctx, createdEvent);
    await deleteTicket(paths, ticket.id);
    await expect(readTicket(paths, ticket.id)).rejects.toMatchObject({ exitCode: 4 });
  });
});

describe("listTicketIds / listTickets", () => {
  it("lists ids ascending (ULID order = chronological) and ignores non-entity files", async () => {
    const ids: TicketId[] = [];
    for (let i = 0; i < 3; i++) {
      const t = makeTicket();
      await createTicket(paths, t, ctx, createdEvent);
      ids.push(t.id);
    }
    await writeFile(join(paths.ticketsDir, ".tmp-abc-ticket_x.jsonc"), "partial");
    await writeFile(join(paths.ticketsDir, "not-a-ticket.txt"), "x");

    const listed = await listTicketIds(paths);
    expect(listed).toEqual([...ids].sort());
  });

  it("returns an empty list against a freshly-initialized (empty) repo", async () => {
    await expect(listTicketIds(paths)).resolves.toEqual([]);
    await expect(listTickets(paths)).resolves.toEqual([]);
  });

  it("listTickets returns fully validated tickets", async () => {
    const a = makeTicket();
    const b = makeTicket();
    await createTicket(paths, a, ctx, createdEvent);
    await createTicket(paths, b, ctx, createdEvent);
    const all = await listTickets(paths);
    expect(all.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("listTickets throws a clear error naming the file if any ticket is corrupt", async () => {
    const good = makeTicket();
    await createTicket(paths, good, ctx, createdEvent);
    const badId = newTicketId();
    await writeFile(ticketFilePath(paths, badId), '{ "id": "not even close to valid" }');

    let threw: unknown;
    try {
      await listTickets(paths);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toContain(ticketFilePath(paths, badId));
  });
});

describe("listTicketsTolerant (adversarial-review Finding 3)", () => {
  it("returns an empty result against a freshly-initialized (empty) repo", async () => {
    await expect(listTicketsTolerant(paths)).resolves.toEqual({ tickets: [], problems: [] });
  });

  it("returns every ticket, with an empty problems list, when nothing is corrupt", async () => {
    const a = makeTicket();
    const b = makeTicket();
    await createTicket(paths, a, ctx, createdEvent);
    await createTicket(paths, b, ctx, createdEvent);
    const { tickets, problems } = await listTicketsTolerant(paths);
    expect(tickets.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(problems).toEqual([]);
  });

  it("never throws on a corrupt ticket file — returns the good tickets and records the bad one in problems, with the same high-quality error listTickets would have thrown", async () => {
    const good = makeTicket();
    await createTicket(paths, good, ctx, createdEvent);
    const badId = newTicketId();
    const badPath = ticketFilePath(paths, badId);
    await writeFile(badPath, '{ "id": "not even close to valid" }');

    const { tickets, problems } = await listTicketsTolerant(paths);

    expect(tickets.map((t) => t.id)).toEqual([good.id]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ id: badId, path: badPath });
    expect(problems[0]?.message).toContain(badPath);
  });

  it("records every bad file in one pass, not just the first", async () => {
    const good = makeTicket();
    await createTicket(paths, good, ctx, createdEvent);
    const bad1 = newTicketId();
    const bad2 = newTicketId();
    await writeFile(ticketFilePath(paths, bad1), "{ not even valid jsonc {{{");
    await writeFile(ticketFilePath(paths, bad2), '{ "id": "still not valid" }');

    const { tickets, problems } = await listTicketsTolerant(paths);

    expect(tickets.map((t) => t.id)).toEqual([good.id]);
    expect(problems.map((p) => p.id).sort()).toEqual([bad1, bad2].sort());
  });
});
