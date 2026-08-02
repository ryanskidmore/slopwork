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
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { EXIT_CODES, eventIdSchema, type EventId } from "../core/index.js";
import { SlopError } from "../cli/errors.js";
import { writeCanonical } from "../core/jsonc.js";
import { atomicWriteFile } from "./atomic-write.js";
import { createEntityFileCanonical, readEntityFile } from "./entity-file.js";
import { withLock } from "./lock.js";
import type { RepoPaths } from "./paths.js";

export const EVENT_POLL_CURSOR_VERSION = 1 as const;
export const eventPollCursorSchema = z
  .string()
  .regex(/^cursor_v1_[0-9a-f]{32}$/, "expected cursor_v1_<32 lowercase hex characters>")
  .brand<"EventPollCursor">();
export type EventPollCursor = z.infer<typeof eventPollCursorSchema>;

export const eventPollCursorStateSchema = z
  .object({
    version: z.literal(EVENT_POLL_CURSOR_VERSION),
    cursor: eventPollCursorSchema,
    seen: z.array(eventIdSchema),
  })
  .superRefine((state, ctx) => {
    if (new Set(state.seen).size !== state.seen.length) {
      ctx.addIssue({ code: "custom", path: ["seen"], message: "event ids must be unique" });
    }
    for (let i = 1; i < state.seen.length; i++) {
      if ((state.seen[i - 1] ?? "") >= (state.seen[i] ?? "")) {
        ctx.addIssue({ code: "custom", path: ["seen"], message: "event ids must be sorted" });
        break;
      }
    }
  });
export type EventPollCursorState = z.infer<typeof eventPollCursorStateSchema>;

export function parseEventPollCursor(raw: string): EventPollCursor {
  const parsed = eventPollCursorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SlopError(
      `invalid event polling cursor "${raw}"; expected cursor_v1_<32 lowercase hex characters>`,
      EXIT_CODES.USAGE_ERROR,
    );
  }
  return parsed.data;
}

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
