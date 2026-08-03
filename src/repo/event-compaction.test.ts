import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Event,
  eventSchema,
  newEventId,
  newSessionId,
  newTicketId,
  type Session,
  sessionSchema,
  type TicketId,
} from "../core/index.js";
import { writeCanonical } from "../core/jsonc.js";
import {
  EVENT_ARCHIVE_VERSION,
  eventArchiveFilePath,
  readTicketArchive,
} from "./event-archive-format.js";
import { compactTicketEvents } from "./event-compaction.js";
import type { EventContext } from "./events.js";
import { createEvent, eventShardMonth, listEventShardDirs, listEvents } from "./events.js";
import { ensureDbDirs } from "./paths.js";
import type { RepoPaths } from "./paths.js";
import { createSession } from "./sessions.js";

function makeEvent(ticketId: TicketId, overrides: Partial<Event> = {}): Event {
  return eventSchema.parse({
    id: newEventId(),
    actor: { name: "ryan", kind: "human" },
    session: null,
    verb: "ticket.updated",
    entity: { kind: "ticket", id: ticketId },
    payload: { progress: "some note" },
    at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

function makeSession(ticketId: TicketId, overrides: Partial<Session> = {}): Session {
  return sessionSchema.parse({
    id: newSessionId(),
    ticket: ticketId,
    actor: { name: "ryan", kind: "human" },
    harness: { kind: "claude-code", session_id: null },
    git: { branch: "main", commit_at_start: null },
    started_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };

let scratch: string;
let paths: RepoPaths;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-event-compaction-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("compactTicketEvents", () => {
  it("folds a ticket's own events AND its session's events into one archive, removing the loose originals", async () => {
    const ticketId = newTicketId();
    const e1 = makeEvent(ticketId);
    const e2 = makeEvent(ticketId);
    await createEvent(paths, e1);
    await createEvent(paths, e2);

    const session = makeSession(ticketId);
    const sessionEvent = await createSession(paths, session, ctx, { verb: "session.started" });

    const result = await compactTicketEvents(paths, ticketId);

    expect(result.ticket).toBe(ticketId);
    expect(result.archived).toBe(3);
    expect(result.archiveTotal).toBe(3);

    const archived = await readTicketArchive(paths, ticketId);
    expect(archived.map((e) => e.id).sort()).toEqual([e1.id, e2.id, sessionEvent.id].sort());

    // Originals (always sharded, never flat — createEvent/withMutationEvent
    // always shard a brand-new write) are gone.
    expect(existsSync(join(paths.eventsDir, eventShardMonth(e1.id), `${e1.id}.jsonc`))).toBe(false);
    expect(existsSync(join(paths.eventsDir, eventShardMonth(e2.id), `${e2.id}.jsonc`))).toBe(false);

    // Nothing loose remains for this ticket at all.
    const remainingLoose = await listEvents(paths);
    expect(remainingLoose).toEqual([]);
  });

  it("is idempotent — a second call with nothing new reports archived: 0 and touches nothing", async () => {
    const ticketId = newTicketId();
    await createEvent(paths, makeEvent(ticketId));

    const first = await compactTicketEvents(paths, ticketId);
    expect(first.archived).toBe(1);

    const second = await compactTicketEvents(paths, ticketId);
    expect(second.archived).toBe(0);
    expect(second.archiveTotal).toBe(1);
    expect(second.shardsRemoved).toEqual([]);
  });

  it("folds in a residual loose event left by a cross-clone race, without duplicating what's already archived", async () => {
    const ticketId = newTicketId();
    const first = makeEvent(ticketId);
    await createEvent(paths, first);
    await compactTicketEvents(paths, ticketId);

    // Simulates another clone appending a progress note for this ticket
    // before it learned the ticket had closed and been compacted here.
    const residual = makeEvent(ticketId, { payload: { progress: "residual note" } });
    await createEvent(paths, residual);

    const second = await compactTicketEvents(paths, ticketId);
    expect(second.archived).toBe(1);
    expect(second.archiveTotal).toBe(2);

    const archived = await readTicketArchive(paths, ticketId);
    expect(archived.map((e) => e.id).sort()).toEqual([first.id, residual.id].sort());
    expect(
      existsSync(join(paths.eventsDir, eventShardMonth(residual.id), `${residual.id}.jsonc`)),
    ).toBe(false);
  });

  it("finishes deleting a stray loose original left by an interrupted prior compaction (already archived, never removed)", async () => {
    const ticketId = newTicketId();
    const event = makeEvent(ticketId);
    await createEvent(paths, event); // always sharded, never flat — see events.ts's module doc.
    const shardedPath = join(paths.eventsDir, eventShardMonth(event.id), `${event.id}.jsonc`);

    // Simulate a crash between "archive written" and "original deleted":
    // write the archive by hand, but leave the loose file in place.
    await mkdir(paths.eventArchiveDir, { recursive: true });
    await writeFile(
      eventArchiveFilePath(paths, ticketId),
      writeCanonical({ version: EVENT_ARCHIVE_VERSION, ticket: ticketId, events: [event] }),
    );
    expect(existsSync(shardedPath)).toBe(true);

    const result = await compactTicketEvents(paths, ticketId);
    // No NEW content — it was already archived — but the stray original
    // must still be cleaned up.
    expect(result.archived).toBe(0);
    expect(result.archiveTotal).toBe(1);
    expect(existsSync(shardedPath)).toBe(false);
  });

  it("removes a shard directory once compaction leaves it with zero remaining loose files", async () => {
    const ticketId = newTicketId();
    const event = makeEvent(ticketId);
    await createEvent(paths, event);
    const month = eventShardMonth(event.id);

    const before = await listEventShardDirs(paths);
    expect(before.map((d) => d.split("/").pop())).toContain(month);

    const result = await compactTicketEvents(paths, ticketId);
    expect(result.shardsRemoved).toEqual([month]);

    const after = await listEventShardDirs(paths);
    expect(after.map((d) => d.split("/").pop())).not.toContain(month);
  });

  it("does NOT remove a shard directory another ticket's loose event still lives in", async () => {
    const ticketA = newTicketId();
    const ticketB = newTicketId();
    const eventA = makeEvent(ticketA);
    const eventB = makeEvent(ticketB);
    await createEvent(paths, eventA);
    await createEvent(paths, eventB);
    const month = eventShardMonth(eventA.id);
    expect(eventShardMonth(eventB.id)).toBe(month); // same month — the whole point of this test.

    const result = await compactTicketEvents(paths, ticketA);
    expect(result.shardsRemoved).toEqual([]);

    const dir = join(paths.eventsDir, month);
    const remaining = await readdir(dir);
    expect(remaining).toEqual([`${eventB.id}.jsonc`]);
  });

  it("returns archived: 0 for a ticket with no events at all", async () => {
    const ticketId = newTicketId();
    const result = await compactTicketEvents(paths, ticketId);
    expect(result).toEqual({ ticket: ticketId, archived: 0, archiveTotal: 0, shardsRemoved: [] });
  });
});
