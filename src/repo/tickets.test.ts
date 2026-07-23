import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Ticket, type TicketId, newTicketId, ticketSchema } from "../core/index.js";
import { ensureDbDirs } from "./paths.js";
import type { RepoPaths } from "./paths.js";
import {
  createTicket,
  deleteTicket,
  listTicketIds,
  listTickets,
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
    await createTicket(paths, ticket);
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
});

describe("updateTicket", () => {
  it("applies a patch and preserves hand-added comments where possible", async () => {
    const ticket = makeTicket({ priority: 2 });
    await createTicket(paths, ticket);

    // Simulate a human hand-annotating the file after creation.
    const path = ticketFilePath(paths, ticket.id);
    const original = await readFile(path, "utf8");
    await writeFile(path, `// triaged\n${original}`);

    const after = { ...ticket, priority: 0 };
    await updateTicket(paths, ticket.id, [{ path: ["priority"], value: 0 }], after);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("// triaged");
    await expect(readTicket(paths, ticket.id)).resolves.toEqual(after);
  });
});

describe("deleteTicket", () => {
  it("removes the ticket file", async () => {
    const ticket = makeTicket();
    await createTicket(paths, ticket);
    await deleteTicket(paths, ticket.id);
    await expect(readTicket(paths, ticket.id)).rejects.toMatchObject({ exitCode: 4 });
  });
});

describe("listTicketIds / listTickets", () => {
  it("lists ids ascending (ULID order = chronological) and ignores non-entity files", async () => {
    const ids: TicketId[] = [];
    for (let i = 0; i < 3; i++) {
      const t = makeTicket();
      await createTicket(paths, t);
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
    await createTicket(paths, a);
    await createTicket(paths, b);
    const all = await listTickets(paths);
    expect(all.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("listTickets throws a clear error naming the file if any ticket is corrupt", async () => {
    const good = makeTicket();
    await createTicket(paths, good);
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
