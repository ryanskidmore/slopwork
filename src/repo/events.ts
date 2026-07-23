/**
 * Event entity CRUD over `<root>/.slop/db/events/event_<ulid>.jsonc`
 * (design.md §3). Events are immutable (design.md §4.1 item 4) — there is
 * deliberately no `updateEvent`; A4 (event writer) only ever creates new
 * event files, never edits one in place. `deleteEvent` exists purely as a
 * CRUD primitive (e.g. for test cleanup) — nothing in the normal command
 * surface deletes events.
 */
import { join } from "node:path";
import { type Event, type EventId, eventSchema, isEventId } from "../core/index.js";
import {
  createEntityFileCanonical,
  deleteEntityFile,
  listEntityIds,
  readEntityFile,
} from "./entity-file.js";
import type { RepoPaths } from "./paths.js";

export function eventFilePath(paths: RepoPaths, id: EventId): string {
  return join(paths.eventsDir, `${id}.jsonc`);
}

export async function readEvent(paths: RepoPaths, id: EventId): Promise<Event> {
  return readEntityFile(eventFilePath(paths, id), eventSchema);
}

/** New event file. Always canonical (machine-only, write-once — jsonc.ts's module doc). */
export async function createEvent(paths: RepoPaths, event: Event): Promise<void> {
  await createEntityFileCanonical(eventFilePath(paths, event.id), event);
}

export async function deleteEvent(paths: RepoPaths, id: EventId): Promise<void> {
  await deleteEntityFile(eventFilePath(paths, id));
}

/** Event ids present on disk, ascending — this *is* the event-ordering
 * cursor design.md §3 refers to ("event ordering cursors on the event
 * ULID itself"), since ULIDs sort chronologically as plain strings. */
export async function listEventIds(paths: RepoPaths): Promise<EventId[]> {
  return listEntityIds(paths.eventsDir, isEventId);
}

/** Every event on disk, read and validated, in cursor order. */
export async function listEvents(paths: RepoPaths): Promise<Event[]> {
  const ids = await listEventIds(paths);
  return Promise.all(ids.map((id) => readEvent(paths, id)));
}
