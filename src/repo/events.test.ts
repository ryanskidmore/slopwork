import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../core/clock.js";
import { type Event, eventSchema, newEventId, newTicketId } from "../core/index.js";
import * as eventsModule from "./events.js";
import {
  type EventContext,
  createEvent,
  eventFilePath,
  listEventIds,
  listEvents,
  queryEvents,
  readEvent,
  withMutationEvent,
} from "./events.js";
import { ensureDbDirs } from "./paths.js";
import type { RepoPaths } from "./paths.js";

function makeEvent(overrides: Partial<Event> = {}): Event {
  return eventSchema.parse({
    id: newEventId(),
    actor: { name: "ryan", kind: "human" },
    session: null,
    verb: "ticket.created",
    entity: { kind: "ticket", id: newTicketId() },
    at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

let scratch: string;
let paths: RepoPaths;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-events-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("createEvent / readEvent", () => {
  it("round-trips a full event", async () => {
    const event = makeEvent();
    await createEvent(paths, event);
    await expect(readEvent(paths, event.id)).resolves.toEqual(event);
  });

  it("readEvent throws NOT_FOUND for a missing id", async () => {
    await expect(readEvent(paths, newEventId())).rejects.toMatchObject({ exitCode: 4 });
  });
});

// A4 immutability requirement (design.md §4.1 item 4, and this work
// item's brief: "there should be no supported path to modify or delete
// an event"). Asserted here at the unit level too (not just
// tests/acceptance/A4.test.ts): this module's exports are the entire
// supported surface for events, and it has no update/delete function.
describe("immutability", () => {
  it("this module exports no updateEvent or deleteEvent", () => {
    expect("updateEvent" in eventsModule).toBe(false);
    expect("deleteEvent" in eventsModule).toBe(false);
  });
});

describe("listEventIds / listEvents — cursor ordering", () => {
  it("returns ids/events in ULID (= chronological) ascending order, ignoring temp debris", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const e = makeEvent();
      await createEvent(paths, e);
      ids.push(e.id);
    }
    await writeFile(join(paths.eventsDir, ".tmp-abc-event_z.jsonc"), "partial");

    const listedIds = await listEventIds(paths);
    expect(listedIds).toEqual([...ids].sort());

    const events = await listEvents(paths);
    expect(events.map((e) => e.id)).toEqual([...ids].sort());
  });

  it("a large same-millisecond batch is still strictly ordered with no duplicates (A2's shared monotonic factory)", async () => {
    const COUNT = 300;
    for (let i = 0; i < COUNT; i++) {
      await createEvent(paths, makeEvent());
    }
    const events = await listEvents(paths);
    expect(events).toHaveLength(COUNT);
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const cur = events[i];
      expect(prev).toBeDefined();
      expect(cur).toBeDefined();
      expect(cur && prev && cur.id > prev.id).toBe(true);
    }
    expect(new Set(events.map((e) => e.id)).size).toBe(COUNT);
  });

  it("is stable under repeated reads", async () => {
    for (let i = 0; i < 10; i++) {
      await createEvent(paths, makeEvent());
    }
    const first = await listEvents(paths);
    const second = await listEvents(paths);
    expect(second).toEqual(first);
  });
});

describe("eventFilePath", () => {
  it("is <eventsDir>/<id>.jsonc", () => {
    const id = newEventId();
    expect(eventFilePath(paths, id)).toBe(join(paths.eventsDir, `${id}.jsonc`));
  });
});

describe("withMutationEvent — the emit-on-mutation hook", () => {
  const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
  const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

  it("runs the write, then emits exactly one event carrying ctx/verb/entity/payload", async () => {
    let wrote = false;
    const event = await withMutationEvent(
      paths,
      ctx,
      { kind: "ticket", id: newTicketId() },
      { verb: "ticket.updated", payload: { note: "hi" } },
      async () => {
        wrote = true;
      },
      clock,
    );

    expect(wrote).toBe(true);
    expect(event.actor).toEqual(ctx.actor);
    expect(event.session).toBeNull();
    expect(event.verb).toBe("ticket.updated");
    expect(event.payload).toEqual({ note: "hi" });
    expect(event.at).toBe("2026-07-23T12:00:00.000Z");

    const onDisk = await listEvents(paths);
    expect(onDisk).toEqual([event]);
  });

  it("defaults payload to {} when omitted", async () => {
    const event = await withMutationEvent(
      paths,
      ctx,
      { kind: "ticket", id: newTicketId() },
      { verb: "ticket.created" },
      async () => {},
      clock,
    );
    expect(event.payload).toEqual({});
  });

  it("emits no event when write() throws", async () => {
    await expect(
      withMutationEvent(
        paths,
        ctx,
        { kind: "ticket", id: newTicketId() },
        { verb: "ticket.created" },
        async () => {
          throw new Error("boom");
        },
        clock,
      ),
    ).rejects.toThrow("boom");
    await expect(listEvents(paths)).resolves.toEqual([]);
  });

  it("N calls under a tight loop (simulating a multi-mutation transaction) produce N durable, distinctly-ordered events", async () => {
    const N = 5;
    const emitted: Event[] = [];
    for (let i = 0; i < N; i++) {
      const event = await withMutationEvent(
        paths,
        ctx,
        { kind: "ticket", id: newTicketId() },
        { verb: "ticket.updated", payload: { i } },
        async () => {},
        clock,
      );
      emitted.push(event);
    }
    const onDisk = await listEvents(paths);
    expect(onDisk).toHaveLength(N);
    expect(onDisk.map((e) => e.id)).toEqual(emitted.map((e) => e.id));
    expect(new Set(onDisk.map((e) => e.id)).size).toBe(N);
  });
});

describe("queryEvents — the cursor D3's `slop events --since` builds on", () => {
  const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };

  it("with no query, returns everything in ULID order", async () => {
    const a = makeEvent();
    const b = makeEvent();
    await createEvent(paths, a);
    await createEvent(paths, b);
    const result = await queryEvents(paths);
    expect(result.map((e) => e.id)).toEqual([a, b].map((e) => e.id).sort());
  });

  it("since is exclusive: only events strictly after the given id", async () => {
    const events: Event[] = [];
    for (let i = 0; i < 5; i++) {
      const e = makeEvent();
      await createEvent(paths, e);
      events.push(e);
    }
    const sorted = [...events].sort((x, y) => (x.id < y.id ? -1 : 1));
    const cursor = sorted[1];
    expect(cursor).toBeDefined();
    if (!cursor) throw new Error("unreachable");
    const page = await queryEvents(paths, { since: cursor.id });
    expect(page.map((e) => e.id)).toEqual(sorted.slice(2).map((e) => e.id));
    expect(page.some((e) => e.id === cursor.id)).toBe(false);
  });

  it("filters by ticket entity", async () => {
    const ticketA = newTicketId();
    const ticketB = newTicketId();
    const onA = makeEvent({ entity: { kind: "ticket", id: ticketA } });
    const onB = makeEvent({ entity: { kind: "ticket", id: ticketB } });
    const sessionEvent = makeEvent({
      entity: { kind: "session", id: "session_01ARZ3NDEKTSV4RRFFQ69G5FAX" },
    });
    await createEvent(paths, onA);
    await createEvent(paths, onB);
    await createEvent(paths, sessionEvent);

    const page = await queryEvents(paths, { ticket: ticketA });
    expect(page.map((e) => e.id)).toEqual([onA.id]);
  });

  it("limit caps the page, applied after since/ticket filtering, preserving order", async () => {
    const events: Event[] = [];
    for (let i = 0; i < 5; i++) {
      const e = makeEvent();
      await createEvent(paths, e);
      events.push(e);
    }
    const sorted = [...events].sort((x, y) => (x.id < y.id ? -1 : 1));
    const page = await queryEvents(paths, { limit: 2 });
    expect(page.map((e) => e.id)).toEqual(sorted.slice(0, 2).map((e) => e.id));
  });

  it("composes since + ticket + limit together", async () => {
    const ticketA = newTicketId();
    const onA: Event[] = [];
    for (let i = 0; i < 4; i++) {
      const e = makeEvent({ entity: { kind: "ticket", id: ticketA } });
      await createEvent(paths, e);
      onA.push(e);
      await createEvent(paths, makeEvent()); // noise on a different ticket
    }
    const sortedOnA = [...onA].sort((x, y) => (x.id < y.id ? -1 : 1));
    const cursor = sortedOnA[0];
    expect(cursor).toBeDefined();
    if (!cursor) throw new Error("unreachable");
    const page = await queryEvents(paths, { since: cursor.id, ticket: ticketA, limit: 1 });
    expect(page).toHaveLength(1);
    expect(page[0]?.id).toBe(sortedOnA[1]?.id);
    expect(page.every((e) => e.entity.kind === "ticket" && e.entity.id === ticketA)).toBe(true);
  });

  it("uses withMutationEvent-produced events too — a realistic end-to-end page", async () => {
    const ticket = newTicketId();
    const first = await withMutationEvent(
      paths,
      ctx,
      { kind: "ticket", id: ticket },
      { verb: "ticket.created" },
      async () => {},
    );
    const second = await withMutationEvent(
      paths,
      ctx,
      { kind: "ticket", id: ticket },
      { verb: "ticket.updated" },
      async () => {},
    );
    const page = await queryEvents(paths, { since: first.id });
    expect(page.map((e) => e.id)).toEqual([second.id]);
  });
});
