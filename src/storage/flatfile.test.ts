import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, EventId, Ticket } from "../core/index.js";
import { newTicketId, ticketSchema } from "../core/index.js";
import {
  createEntityFileCanonical,
  ensureDbDirs,
  type EventContext,
  type MutationEventSpec,
  type RepoPaths,
} from "../repo/index.js";
import { FlatfileBackend } from "./flatfile.js";

// Wraps the REAL `readFile` (not a fake) so every read this test performs
// is genuine — only observed, per cascade.test.ts's identical convention
// (see that file's own doc comment for why this is the established way
// to prove "how many times did this actually re-read a file" in this
// codebase).
const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  readFileMock.mockImplementation(actual.readFile);
  return { ...actual, readFile: readFileMock };
});

const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };

function makeTicket(): Ticket {
  const id = newTicketId();
  return ticketSchema.parse({
    id,
    name: "Ticket",
    slug: `ticket-${id.slice(-10).toLowerCase()}`,
    spec: { summary: "s" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
  });
}

/** Hand-write an event directly into a CHOSEN month's shard — `ulid`'s
 * `seedTime` param (unlike `core/ids.ts`'s `newEventId`, which always
 * uses the real wall clock) is what lets a test control exactly which
 * shard an event lands in, so two events can be placed in two
 * deliberately different months. */
async function writeEventInMonth(
  paths: RepoPaths,
  ticketId: string,
  month: string, // "YYYY-MM"
  seedIso: string,
  note: string,
): Promise<Event> {
  const id = `event_${ulid(Date.parse(seedIso))}` as EventId;
  const event: Event = {
    id,
    actor: ctx.actor,
    session: null,
    verb: "ticket.updated",
    entity: { kind: "ticket", id: ticketId as never },
    payload: { progress: note },
    at: seedIso,
  };
  await createEntityFileCanonical(join(paths.eventsDir, month, `${id}.jsonc`), event);
  return event;
}

let scratch: string;
let paths: RepoPaths;
let backend: FlatfileBackend;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-flatfile-backend-test-"));
  paths = await ensureDbDirs(scratch);
  backend = new FlatfileBackend(paths);
  readFileMock.mockClear();
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("FlatfileBackend", () => {
  it("delegates ticket CRUD through to the repo layer", async () => {
    const ticket = makeTicket();
    await backend.createTicket(ticket, ctx, createdEvent);
    const read = await backend.readTicket(ticket.id);
    expect(read.id).toBe(ticket.id);
    expect(await backend.listTickets()).toHaveLength(1);
  });

  it("localTicketFilePath/localSessionFilePath point at the real on-disk files", async () => {
    const ticket = makeTicket();
    await backend.createTicket(ticket, ctx, createdEvent);
    expect(backend.localTicketFilePath?.(ticket.id)).toBe(
      join(paths.ticketsDir, `${ticket.id}.jsonc`),
    );
  });

  describe("listEventsTolerant: per-shard incremental cache (t-6tqw9)", () => {
    it("a second call with nothing changed re-reads NO event file in either shard", async () => {
      const ticket = makeTicket();
      await backend.createTicket(ticket, ctx, createdEvent);

      const jan = await writeEventInMonth(
        paths,
        ticket.id,
        "2024-01",
        "2024-01-15T00:00:00.000Z",
        "january note",
      );
      const feb = await writeEventInMonth(
        paths,
        ticket.id,
        "2024-02",
        "2024-02-15T00:00:00.000Z",
        "february note",
      );

      const first = await backend.listEventsTolerant();
      // 3 events total: createTicket's own sharded `ticket.created` event,
      // plus the two hand-placed jan/feb ones.
      expect(first).toHaveLength(3);
      expect(first.map((e) => e.id)).toEqual(expect.arrayContaining([jan.id, feb.id]));

      readFileMock.mockClear();
      const second = await backend.listEventsTolerant();
      expect(second.map((e) => e.id).sort()).toEqual(first.map((e) => e.id).sort());

      const eventFileReads = readFileMock.mock.calls.filter(([path]) =>
        String(path).startsWith(paths.eventsDir),
      );
      expect(eventFileReads).toHaveLength(0);
    });

    it("adding an event to ONE shard re-reads only that shard, not the other", async () => {
      const ticket = makeTicket();
      await backend.createTicket(ticket, ctx, createdEvent);
      await writeEventInMonth(paths, ticket.id, "2024-01", "2024-01-15T00:00:00.000Z", "jan #1");
      const feb = await writeEventInMonth(
        paths,
        ticket.id,
        "2024-02",
        "2024-02-15T00:00:00.000Z",
        "feb #1",
      );
      await backend.listEventsTolerant(); // warm the cache for both shards

      readFileMock.mockClear();
      const jan2 = await writeEventInMonth(
        paths,
        ticket.id,
        "2024-01",
        "2024-01-20T00:00:00.000Z",
        "jan #2",
      );
      const result = await backend.listEventsTolerant();

      expect(result.map((e) => e.id)).toEqual(expect.arrayContaining([jan2.id, feb.id]));

      const readsUnderJan = readFileMock.mock.calls.filter(([path]) =>
        String(path).startsWith(join(paths.eventsDir, "2024-01")),
      );
      const readsUnderFeb = readFileMock.mock.calls.filter(([path]) =>
        String(path).startsWith(join(paths.eventsDir, "2024-02")),
      );
      // February's shard was untouched — served entirely from cache.
      expect(readsUnderFeb).toHaveLength(0);
      // January's shard (now 2 files) WAS re-read.
      expect(readsUnderJan.length).toBeGreaterThan(0);
    });

    it("a mutation through the backend invalidates the cache — a read-after-write is always real", async () => {
      const ticket = makeTicket();
      await backend.createTicket(ticket, ctx, createdEvent);
      await writeEventInMonth(paths, ticket.id, "2024-01", "2024-01-15T00:00:00.000Z", "jan #1");
      const before = await backend.listEventsTolerant();

      await backend.appendEvent(
        ctx,
        { kind: "ticket", id: ticket.id },
        { verb: "ticket.updated", payload: { progress: "a brand-new note" } },
      );

      const after = await backend.listEventsTolerant();
      expect(after.length).toBe(before.length + 1);
    });
  });
});
