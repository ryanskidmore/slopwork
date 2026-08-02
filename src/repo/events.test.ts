import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { fixedClock } from "../core/clock.js";
import {
  type Event,
  type EventId,
  eventSchema,
  newEventId,
  newSessionId,
  newTicketId,
} from "../core/index.js";
import { writeCanonical } from "../core/jsonc.js";
import * as eventsModule from "./events.js";
import {
  type EventContext,
  createEvent,
  eventFilePath,
  eventShardMonth,
  listEventIds,
  listEventShardDirs,
  listEvents,
  migrateFlatEventsToShards,
  queryEvents,
  readEvent,
  ticketEventContext,
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

/**
 * G2 (shard-event-storage): a full, valid `Event` whose id's OWN embedded
 * ULID timestamp is `atMs` — NOT "now". `newEventId` (core/ids.ts) always
 * mints against the real wall clock and has no seed-time parameter, so
 * it's useless for deliberately landing an event in an arbitrary/old
 * shard month; this instead mints the raw ULID body directly via the
 * `ulid` package's own seed-time overload, distinct from core/ids.ts's
 * shared monotonic factory.
 */
function makeEventAt(atMs: number, overrides: Partial<Event> = {}): Event {
  return eventSchema.parse({
    id: `event_${ulid(atMs)}`,
    actor: { name: "ryan", kind: "human" },
    session: null,
    verb: "ticket.created",
    entity: { kind: "ticket", id: newTicketId() },
    at: new Date(atMs).toISOString(),
    ...overrides,
  });
}

/** Plant `event` directly at its FLAT path — simulating an old,
 * never-migrated event, bypassing {@link createEvent} (which always
 * shards a brand-new write). */
async function plantFlat(paths: RepoPaths, event: Event): Promise<void> {
  await writeFile(eventFilePath(paths, event.id), writeCanonical(event));
}

/** Plant `event` directly at its already-sharded path — simulating an
 * event some EARLIER run already sharded (or wrote there directly),
 * bypassing {@link createEvent} so the test controls the exact on-disk
 * state independently of whatever `createEvent` itself would do. */
async function plantSharded(paths: RepoPaths, event: Event): Promise<void> {
  const dir = join(paths.eventsDir, eventShardMonth(event.id));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${event.id}.jsonc`), writeCanonical(event));
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

describe("ticketEventContext", () => {
  const actor = { name: "ryan", kind: "human" } as const;

  it("attributes ticket work to the ticket snapshot's active session", () => {
    const activeSession = newSessionId();
    expect(ticketEventContext(actor, { active_session: activeSession })).toEqual({
      actor,
      session: activeSession,
    });
  });

  it("preserves null for ticket work performed outside a session", () => {
    expect(ticketEventContext(actor, { active_session: null })).toEqual({ actor, session: null });
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

// G2 (shard-event-storage, t-6tqw9): a brand-new event now lands in
// `events/<eventShardMonth(id)>/`, never flat.
describe("createEvent — shards a brand-new event by its own id's month", () => {
  it("writes into events/<eventShardMonth(id)>/<id>.jsonc, not flat", async () => {
    const event = makeEvent();
    await createEvent(paths, event);

    const shardPath = join(paths.eventsDir, eventShardMonth(event.id), `${event.id}.jsonc`);
    await expect(stat(shardPath)).resolves.toBeDefined();
    await expect(stat(eventFilePath(paths, event.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a brand-new shard directory for free (atomicWriteFile's mkdir self-heal), with no separate directory-creation step of its own", async () => {
    const event = makeEvent();
    // Sanity: the shard directory genuinely doesn't exist yet.
    const shardDir = join(paths.eventsDir, eventShardMonth(event.id));
    await expect(stat(shardDir)).rejects.toMatchObject({ code: "ENOENT" });

    await createEvent(paths, event);
    await expect(stat(shardDir).then((s) => s.isDirectory())).resolves.toBe(true);
  });

  it("two events minted in the same month land in the SAME shard directory", async () => {
    const a = makeEvent();
    const b = makeEvent();
    await createEvent(paths, a);
    await createEvent(paths, b);
    expect(eventShardMonth(a.id)).toBe(eventShardMonth(b.id));

    const shardDir = join(paths.eventsDir, eventShardMonth(a.id));
    const names = (await readdir(shardDir)).sort();
    expect(names).toEqual([`${a.id}.jsonc`, `${b.id}.jsonc`].sort());
  });
});

// G2: every read primitive merges the flat layout (old events, never
// migrated) and any number of `events/YYYY-MM/` shards transparently —
// no caller needs to know or care which layout a given id is in.
describe("reads merge the flat and sharded layouts transparently", () => {
  it("readEvent finds an event whichever layout it actually lives in", async () => {
    const flatEvent = makeEventAt(new Date("2020-03-10T00:00:00.000Z").getTime());
    await plantFlat(paths, flatEvent);
    const shardedEvent = makeEvent(); // createEvent always shards
    await createEvent(paths, shardedEvent);

    await expect(readEvent(paths, flatEvent.id)).resolves.toEqual(flatEvent);
    await expect(readEvent(paths, shardedEvent.id)).resolves.toEqual(shardedEvent);
  });

  it("listEventIds / listEvents return the union of flat + every shard, as one seamlessly-ordered collection", async () => {
    const flatOld = makeEventAt(new Date("2019-11-01T00:00:00.000Z").getTime());
    const flatNewer = makeEventAt(new Date("2019-11-02T00:00:00.000Z").getTime());
    await plantFlat(paths, flatOld);
    await plantFlat(paths, flatNewer);

    const shardedA = makeEventAt(new Date("2021-05-01T00:00:00.000Z").getTime());
    const shardedB = makeEventAt(new Date("2022-09-01T00:00:00.000Z").getTime());
    await createEvent(paths, shardedA);
    await createEvent(paths, shardedB);

    const expectedIds = [flatOld, flatNewer, shardedA, shardedB].map((e) => e.id).sort();
    await expect(listEventIds(paths)).resolves.toEqual(expectedIds);

    const events = await listEvents(paths);
    expect(events.map((e) => e.id)).toEqual(expectedIds);
  });

  it("readEvent throws the same NOT_FOUND, naming the FLAT path, when an id exists in neither layout", async () => {
    const missing = newEventId();
    await expect(readEvent(paths, missing)).rejects.toMatchObject({ exitCode: 4 });
    await expect(readEvent(paths, missing)).rejects.toThrow(eventFilePath(paths, missing));
  });

  it("a genuine parse error at the id's ACTUAL (sharded) location propagates as-is — never masked by a spurious flat-fallback retry", async () => {
    const poisoned = makeEvent();
    const shardPath = join(paths.eventsDir, eventShardMonth(poisoned.id), `${poisoned.id}.jsonc`);
    await mkdir(join(paths.eventsDir, eventShardMonth(poisoned.id)), { recursive: true });
    await writeFile(shardPath, "{ not valid jsonc {{{");

    // A NOT_FOUND (exit 4) here would mean the existence check picked the
    // flat path instead and reported "missing" — the real bug this test
    // guards against. The real error is GENERIC_ERROR (exit 1).
    await expect(readEvent(paths, poisoned.id)).rejects.toMatchObject({ exitCode: 1 });
  });

  it("a genuine parse error at the id's ACTUAL (flat) location propagates as-is too", async () => {
    const poisoned = makeEvent();
    await writeFile(eventFilePath(paths, poisoned.id), "{ not valid jsonc {{{");
    await expect(readEvent(paths, poisoned.id)).rejects.toMatchObject({ exitCode: 1 });
  });
});

describe("listEventShardDirs", () => {
  it("is empty for a fresh repo with no shards at all", async () => {
    await expect(listEventShardDirs(paths)).resolves.toEqual([]);
  });

  it("returns every shard subdirectory as an absolute path, sorted ascending", async () => {
    const older = makeEventAt(new Date("2021-02-01T00:00:00.000Z").getTime());
    const newer = makeEventAt(new Date("2023-08-01T00:00:00.000Z").getTime());
    await createEvent(paths, newer); // deliberately created out of order
    await createEvent(paths, older);

    await expect(listEventShardDirs(paths)).resolves.toEqual([
      join(paths.eventsDir, eventShardMonth(older.id)),
      join(paths.eventsDir, eventShardMonth(newer.id)),
    ]);
  });

  it("ignores a stray FILE (not a directory) whose name happens to match the YYYY-MM shape", async () => {
    await writeFile(join(paths.eventsDir, "2026-08"), "not a directory");
    await expect(listEventShardDirs(paths)).resolves.toEqual([]);
  });

  it("ignores directories that don't match the exact YYYY-MM shape", async () => {
    await mkdir(join(paths.eventsDir, "not-a-shard"), { recursive: true });
    await mkdir(join(paths.eventsDir, "2026-8"), { recursive: true }); // not zero-padded
    await mkdir(join(paths.eventsDir, "20268"), { recursive: true });
    await expect(listEventShardDirs(paths)).resolves.toEqual([]);
  });

  it("propagates ENOTDIR (never silently 'empty') when paths.eventsDir itself is a plain file — same non-swallowed-error property readDirSafe already guarantees elsewhere", async () => {
    await rm(paths.eventsDir, { recursive: true, force: true });
    await writeFile(paths.eventsDir, "oops, a file where a directory should be");
    await expect(listEventShardDirs(paths)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

describe("migrateFlatEventsToShards", () => {
  it("is a no-op on a repo with nothing flat to migrate", async () => {
    await expect(migrateFlatEventsToShards(paths)).resolves.toEqual({ moved: 0, shards: [] });
  });

  it("moves every flat event file into events/<eventShardMonth(id)>/, preserving its content exactly", async () => {
    const a = makeEventAt(new Date("2020-06-15T00:00:00.000Z").getTime());
    const b = makeEventAt(new Date("2020-06-20T00:00:00.000Z").getTime()); // same month as a
    const c = makeEventAt(new Date("2021-01-05T00:00:00.000Z").getTime()); // different month
    await plantFlat(paths, a);
    await plantFlat(paths, b);
    await plantFlat(paths, c);

    const result = await migrateFlatEventsToShards(paths);
    expect(result.moved).toBe(3);
    expect(result.shards).toEqual([eventShardMonth(a.id), eventShardMonth(c.id)].sort());

    // Nothing left flat...
    for (const event of [a, b, c]) {
      await expect(stat(eventFilePath(paths, event.id))).rejects.toMatchObject({ code: "ENOENT" });
    }
    // ...and every event reads back correctly from its new shard, byte for
    // byte the same content it had flat.
    for (const event of [a, b, c]) {
      const shardPath = join(paths.eventsDir, eventShardMonth(event.id), `${event.id}.jsonc`);
      const raw = await readFile(shardPath, "utf8");
      expect(eventSchema.parse(JSON.parse(raw))).toEqual(event);
    }
    await expect(readEvent(paths, a.id)).resolves.toEqual(a);
  });

  it("a mix of already-sharded + flat events ends up fully sharded, without touching or double-counting the pre-existing shard file", async () => {
    // `preexisting` is already sharded BEFORE migration runs (planted
    // directly, bypassing createEvent) — migration must leave it alone.
    const preexisting = makeEventAt(new Date("2020-06-01T00:00:00.000Z").getTime());
    await plantSharded(paths, preexisting);

    // `flatSameMonth` is flat, and its own id's month is the SAME month
    // `preexisting` already occupies — migration must move it in
    // alongside `preexisting`, not overwrite/duplicate/skip it.
    const flatSameMonth = makeEventAt(new Date("2020-06-15T00:00:00.000Z").getTime());
    await plantFlat(paths, flatSameMonth);

    // `flatOtherMonth` is flat, in a totally different month.
    const flatOtherMonth = makeEventAt(new Date("2022-03-01T00:00:00.000Z").getTime());
    await plantFlat(paths, flatOtherMonth);

    const result = await migrateFlatEventsToShards(paths);

    // Only the two FLAT files were moved this run — the pre-existing
    // sharded one was never touched, so it's not counted.
    expect(result.moved).toBe(2);
    expect(result.shards).toEqual(
      [eventShardMonth(flatSameMonth.id), eventShardMonth(flatOtherMonth.id)].sort(),
    );

    // Every event — old and new — is findable now, fully sharded.
    const allIds = [preexisting, flatSameMonth, flatOtherMonth].map((e) => e.id).sort();
    await expect(listEventIds(paths)).resolves.toEqual(allIds);

    // The shared shard directory holds BOTH events that belong in it —
    // the pre-existing one wasn't clobbered by the newly-moved one.
    const sharedDir = join(paths.eventsDir, eventShardMonth(preexisting.id));
    const namesInSharedDir = (await readdir(sharedDir)).sort();
    expect(namesInSharedDir).toEqual(
      [`${preexisting.id}.jsonc`, `${flatSameMonth.id}.jsonc`].sort(),
    );
  });

  it("is idempotent: a second call after a successful migration is a no-op", async () => {
    const a = makeEventAt(new Date("2020-06-15T00:00:00.000Z").getTime());
    const b = makeEventAt(new Date("2021-01-05T00:00:00.000Z").getTime());
    await plantFlat(paths, a);
    await plantFlat(paths, b);

    const first = await migrateFlatEventsToShards(paths);
    expect(first.moved).toBe(2);

    const second = await migrateFlatEventsToShards(paths);
    expect(second).toEqual({ moved: 0, shards: [] });

    // And the events are still all there, untouched by the no-op second run.
    const allIds = [a, b].map((e) => e.id).sort();
    await expect(listEventIds(paths)).resolves.toEqual(allIds);
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

// Perf fix regression coverage: `queryEvents` used to read+parse EVERY
// event file on disk before applying `since`/`limit` at all (full scan,
// then filter). These tests plant "poisoned" event files — well-formed
// `event_<ulid>.jsonc` names, but bodies that fail JSONC parsing — so that
// merely *reading* one throws. A bounded implementation must never touch a
// poisoned file that `since`/`limit` rules out; the old full-scan
// implementation would have thrown trying to parse it. That makes these
// tests fail against the pre-fix code (evidence: reverting the `queryEvents`
// body to `listEvents` + filter-afterward makes both throw) and pass
// against the fix.
describe("queryEvents — bounded reads (perf: since/limit bound what gets read, not just returned)", () => {
  it("`since` skips reading/parsing every file at or before the cursor", async () => {
    // Plant poisoned files that sort BEFORE the cursor. A read-everything
    // implementation reads every id before ever consulting `since`, so it
    // would try (and fail) to parse these.
    const poisonedIds: EventId[] = [];
    for (let i = 0; i < 20; i++) {
      const id = newEventId();
      await writeFile(eventFilePath(paths, id), "{ this is not valid jsonc", "utf8");
      poisonedIds.push(id);
    }
    const cursor = poisonedIds[poisonedIds.length - 1];
    if (!cursor) throw new Error("unreachable");

    // Real, well-formed events AFTER the cursor — these are what a bounded
    // `since` query should actually return.
    const good: Event[] = [];
    for (let i = 0; i < 5; i++) {
      const e = makeEvent();
      await createEvent(paths, e);
      good.push(e);
    }

    const page = await queryEvents(paths, { since: cursor });
    expect(page.map((e) => e.id)).toEqual(good.map((e) => e.id).sort());
  });

  it("`limit` (no ticket filter) stops before ever reading a later file", async () => {
    const good: Event[] = [];
    for (let i = 0; i < 5; i++) {
      const e = makeEvent();
      await createEvent(paths, e);
      good.push(e);
    }
    // A poisoned file sorting AFTER every good event, past the requested
    // window — a bounded `limit` must never reach it.
    const poisonedId = newEventId();
    await writeFile(eventFilePath(paths, poisonedId), "{ this is not valid jsonc", "utf8");

    const page = await queryEvents(paths, { limit: 5 });
    expect(page.map((e) => e.id)).toEqual(good.map((e) => e.id).sort());
  });

  it("`ticket` + `limit` together stop as soon as the limit is satisfied, never reading past the last match", async () => {
    const ticketA = newTicketId();
    const onA: Event[] = [];
    for (let i = 0; i < 3; i++) {
      const e = makeEvent({ entity: { kind: "ticket", id: ticketA } });
      await createEvent(paths, e);
      onA.push(e);
    }
    // A poisoned file sorting after the 3rd (last needed) match — `limit:
    // 2` should never reach it.
    const poisonedId = newEventId();
    await writeFile(eventFilePath(paths, poisonedId), "{ this is not valid jsonc", "utf8");

    const sortedOnA = [...onA].sort((x, y) => (x.id < y.id ? -1 : 1));
    const page = await queryEvents(paths, { ticket: ticketA, limit: 2 });
    expect(page.map((e) => e.id)).toEqual(sortedOnA.slice(0, 2).map((e) => e.id));
  });

  it("bounded results are identical to a full-scan-then-filter over the same (unpoisoned) data", async () => {
    const ticketA = newTicketId();
    const events: Event[] = [];
    for (let i = 0; i < 8; i++) {
      const e = makeEvent(i % 2 === 0 ? { entity: { kind: "ticket", id: ticketA } } : {});
      await createEvent(paths, e);
      events.push(e);
    }
    const sorted = [...events].sort((x, y) => (x.id < y.id ? -1 : 1));
    const cursor = sorted[1];
    if (!cursor) throw new Error("unreachable");

    // Reference: read everything, then filter/slice by hand — the exact
    // semantics the old implementation had, reproduced here (not called)
    // purely as the expected shape.
    const everything = await listEvents(paths);
    const expected = everything
      .filter((e) => e.id > cursor.id)
      .filter((e) => e.entity.kind === "ticket" && e.entity.id === ticketA)
      .slice(0, 2);

    const page = await queryEvents(paths, { since: cursor.id, ticket: ticketA, limit: 2 });
    expect(page).toEqual(expected);
  });
});
