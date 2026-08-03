import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Event, eventSchema, newEventId, newTicketId, type TicketId } from "../core/index.js";
import { writeCanonical } from "../core/jsonc.js";
import {
  EVENT_ARCHIVE_VERSION,
  eventArchiveFilePath,
  findEventInArchives,
  listAllArchivedEventBatches,
  listArchivedTicketIds,
  readTicketArchive,
  readTicketArchiveTolerant,
} from "./event-archive-format.js";
import { ensureDbDirs } from "./paths.js";
import type { RepoPaths } from "./paths.js";

function makeEvent(ticketId: TicketId, overrides: Partial<Event> = {}): Event {
  return eventSchema.parse({
    id: newEventId(),
    actor: { name: "ryan", kind: "human" },
    session: null,
    verb: "ticket.updated",
    entity: { kind: "ticket", id: ticketId },
    at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

let scratch: string;
let paths: RepoPaths;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-event-archive-format-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function writeArchive(ticketId: TicketId, events: Event[]): Promise<void> {
  await mkdir(paths.eventArchiveDir, { recursive: true });
  await writeFile(
    eventArchiveFilePath(paths, ticketId),
    writeCanonical({ version: EVENT_ARCHIVE_VERSION, ticket: ticketId, events }),
  );
}

describe("eventArchiveFilePath", () => {
  it("names <ticket_id>.jsonc under events/archive/", () => {
    const ticketId = newTicketId();
    expect(eventArchiveFilePath(paths, ticketId)).toBe(
      join(paths.eventArchiveDir, `${ticketId}.jsonc`),
    );
  });
});

describe("readTicketArchive", () => {
  it("returns [] when no archive file exists yet — the ordinary, expected case", async () => {
    await expect(readTicketArchive(paths, newTicketId())).resolves.toEqual([]);
  });

  it("round-trips a written archive's events, in order", async () => {
    const ticketId = newTicketId();
    const e1 = makeEvent(ticketId);
    const e2 = makeEvent(ticketId);
    await writeArchive(ticketId, [e1, e2]);
    await expect(readTicketArchive(paths, ticketId)).resolves.toEqual([e1, e2]);
  });

  it("throws a detailed error on a corrupt archive file (strict)", async () => {
    const ticketId = newTicketId();
    await mkdir(paths.eventArchiveDir, { recursive: true });
    await writeFile(eventArchiveFilePath(paths, ticketId), "{ not valid jsonc", "utf8");
    await expect(readTicketArchive(paths, ticketId)).rejects.toThrow(/invalid JSONC/);
  });
});

describe("readTicketArchiveTolerant", () => {
  it("[] with no problems when no archive exists", async () => {
    const ticketId = newTicketId();
    await expect(readTicketArchiveTolerant(paths, ticketId)).resolves.toEqual({
      dir: eventArchiveFilePath(paths, ticketId),
      events: [],
      problems: [],
    });
  });

  it("reports a read_error and excludes events for a corrupt archive, never throws", async () => {
    const ticketId = newTicketId();
    await mkdir(paths.eventArchiveDir, { recursive: true });
    await writeFile(eventArchiveFilePath(paths, ticketId), "{ not valid jsonc", "utf8");
    const result = await readTicketArchiveTolerant(paths, ticketId);
    expect(result.events).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.kind).toBe("read_error");
  });

  it("reports wrong_shard and excludes an event whose entity doesn't belong to this archive's ticket", async () => {
    const ticketId = newTicketId();
    const otherTicketId = newTicketId();
    const belongs = makeEvent(ticketId);
    const misfiled = makeEvent(otherTicketId);
    await writeArchive(ticketId, [belongs, misfiled]);

    const result = await readTicketArchiveTolerant(paths, ticketId);
    expect(result.events).toEqual([belongs]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.kind).toBe("wrong_shard");
    expect(result.problems[0]?.id).toBe(misfiled.id);
  });
});

describe("listArchivedTicketIds / listAllArchivedEventBatches", () => {
  it("lists every ticket id with an archive file, and merges their events", async () => {
    const ticketA = newTicketId();
    const ticketB = newTicketId();
    const eA = makeEvent(ticketA);
    const eB1 = makeEvent(ticketB);
    const eB2 = makeEvent(ticketB);
    await writeArchive(ticketA, [eA]);
    await writeArchive(ticketB, [eB1, eB2]);

    const ids = await listArchivedTicketIds(paths);
    expect([...ids].sort()).toEqual([ticketA, ticketB].sort());

    const batches = await listAllArchivedEventBatches(paths);
    const allEvents = batches.flatMap((b) => b.events);
    expect(allEvents.map((e) => e.id).sort()).toEqual([eA.id, eB1.id, eB2.id].sort());
  });

  it("[] when events/archive/ doesn't exist at all", async () => {
    await expect(listArchivedTicketIds(paths)).resolves.toEqual([]);
    await expect(listAllArchivedEventBatches(paths)).resolves.toEqual([]);
  });
});

describe("findEventInArchives", () => {
  it("finds an event by id across multiple archive files", async () => {
    const ticketA = newTicketId();
    const ticketB = newTicketId();
    const eA = makeEvent(ticketA);
    const eB = makeEvent(ticketB);
    await writeArchive(ticketA, [eA]);
    await writeArchive(ticketB, [eB]);

    await expect(findEventInArchives(paths, eB.id)).resolves.toEqual(eB);
    await expect(findEventInArchives(paths, eA.id)).resolves.toEqual(eA);
  });

  it("null for an id that exists nowhere", async () => {
    await expect(findEventInArchives(paths, newEventId())).resolves.toBeNull();
  });
});
