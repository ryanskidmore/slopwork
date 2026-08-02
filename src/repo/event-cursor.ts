/**
 * Merge-safe event polling checkpoints.
 *
 * A scalar ULID watermark cannot represent a Git-merged set: an event
 * created on another clone with an older clock may arrive after the
 * watermark and sort before it forever. This module therefore stores the
 * exact set of event ids a consumer has actually received. The opaque
 * token is constant-size; its gitignored local/server-side state grows
 * O(events seen), the unavoidable cost of exact no-miss polling across
 * arbitrary legacy ids with no trustworthy origin/sequence metadata.
 *
 * The token/state schema and parser are canonically DEFINED in
 * `core/storage-contract.ts` (the `StorageBackend` port's own vocabulary)
 * and re-exported here for compatibility; this module owns only the
 * flatfile I/O built on top of them.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { EXIT_CODES, type EventId } from "../core/index.js";
import {
  type EventPollCursor,
  eventPollCursorSchema,
  type EventPollCursorState,
  eventPollCursorStateSchema,
} from "../core/storage-contract.js";
import { SlopError } from "../core/errors.js";
import { writeCanonical } from "../core/jsonc.js";
import { atomicWriteFile } from "./atomic-write.js";
import { createEntityFileCanonical, readEntityFile } from "./entity-file.js";
import { withLock } from "./lock.js";
import type { RepoPaths } from "./paths.js";

export {
  EVENT_POLL_CURSOR_VERSION,
  type EventPollCursor,
  eventPollCursorSchema,
  type EventPollCursorState,
  eventPollCursorStateSchema,
  parseEventPollCursor,
} from "../core/storage-contract.js";

export function eventPollCursorFilePath(paths: RepoPaths, cursor: EventPollCursor): string {
  return join(paths.eventCursorsDir, `${cursor}.jsonc`);
}

export async function createEventPollCursor(paths: RepoPaths): Promise<EventPollCursor> {
  for (;;) {
    const cursor = eventPollCursorSchema.parse(`cursor_v1_${randomUUID().replaceAll("-", "")}`);
    const state: EventPollCursorState = { version: 1, cursor, seen: [] };
    try {
      await createEntityFileCanonical(eventPollCursorFilePath(paths, cursor), state);
      return cursor;
    } catch (err) {
      if (err instanceof SlopError && err.exitCode === EXIT_CODES.CONFLICT) continue;
      throw err;
    }
  }
}

export function readEventPollCursor(
  paths: RepoPaths,
  cursor: EventPollCursor,
): Promise<EventPollCursorState> {
  return readEntityFile(eventPollCursorFilePath(paths, cursor), eventPollCursorStateSchema);
}

export async function advanceEventPollCursor(
  paths: RepoPaths,
  cursor: EventPollCursor,
  returned: readonly EventId[],
  lockTimeoutMs?: number,
): Promise<EventPollCursorState> {
  if (returned.length === 0) return readEventPollCursor(paths, cursor);
  return withLock(
    paths.eventCursorLockFile,
    async () => {
      const current = await readEventPollCursor(paths, cursor);
      const seen = [...new Set([...current.seen, ...returned])].sort();
      const next: EventPollCursorState = { ...current, seen };
      await atomicWriteFile(eventPollCursorFilePath(paths, cursor), writeCanonical(next));
      return next;
    },
    { timeoutMs: lockTimeoutMs },
  );
}

export async function deleteEventPollCursor(
  paths: RepoPaths,
  cursor: EventPollCursor,
  lockTimeoutMs?: number,
): Promise<void> {
  await withLock(
    paths.eventCursorLockFile,
    async () => {
      await readEventPollCursor(paths, cursor);
      await rm(eventPollCursorFilePath(paths, cursor));
    },
    { timeoutMs: lockTimeoutMs },
  );
}
