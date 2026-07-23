import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Event, eventSchema, newEventId, newTicketId } from "../core/index.js";
import { ensureDbDirs } from "./paths.js";
import type { RepoPaths } from "./paths.js";
import { createEvent, deleteEvent, eventFilePath, listEventIds, listEvents, readEvent } from "./events.js";

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

describe("deleteEvent", () => {
  it("removes the file", async () => {
    const event = makeEvent();
    await createEvent(paths, event);
    await deleteEvent(paths, event.id);
    await expect(readEvent(paths, event.id)).rejects.toMatchObject({ exitCode: 4 });
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
});

describe("eventFilePath", () => {
  it("is <eventsDir>/<id>.jsonc", () => {
    const id = newEventId();
    expect(eventFilePath(paths, id)).toBe(join(paths.eventsDir, `${id}.jsonc`));
  });
});
