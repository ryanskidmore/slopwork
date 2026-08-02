import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_CODES, newEventId } from "../core/index.js";
import {
  advanceEventPollCursor,
  createEventPollCursor,
  deleteEventPollCursor,
  eventPollCursorFilePath,
  parseEventPollCursor,
  readEventPollCursor,
} from "./event-cursor.js";
import { ensureDbDirs } from "./paths.js";
import type { RepoPaths } from "./paths.js";

let scratch: string;
let paths: RepoPaths;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-event-cursor-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => rm(scratch, { recursive: true, force: true }));

describe("event polling cursor state", () => {
  it("creates a bounded opaque v1 token backed by empty durable state", async () => {
    const cursor = await createEventPollCursor(paths);
    expect(cursor).toMatch(/^cursor_v1_[0-9a-f]{32}$/);
    expect(await readEventPollCursor(paths, cursor)).toEqual({ version: 1, cursor, seen: [] });
  });

  it("concurrent process-shaped advances union ids without lost updates", async () => {
    const cursor = await createEventPollCursor(paths);
    const a = newEventId();
    const b = newEventId();
    await Promise.all([
      advanceEventPollCursor(paths, cursor, [a]),
      advanceEventPollCursor(paths, cursor, [b]),
    ]);
    expect((await readEventPollCursor(paths, cursor)).seen).toEqual([a, b].sort());
  });

  it("validates serialized tokens and corrupt state loudly", async () => {
    expect(() => parseEventPollCursor("event_01AAAAAAAAAAAAAAAAAAAAAAAA")).toThrow(
      /invalid event polling cursor/,
    );
    const cursor = await createEventPollCursor(paths);
    await writeFile(eventPollCursorFilePath(paths, cursor), '{"version":1,"seen":[]}\n');
    await expect(readEventPollCursor(paths, cursor)).rejects.toMatchObject({
      exitCode: EXIT_CODES.GENERIC_ERROR,
    });
  });

  it("deletes retired state and subsequently fails with NOT_FOUND", async () => {
    const cursor = await createEventPollCursor(paths);
    await deleteEventPollCursor(paths, cursor);
    await expect(readEventPollCursor(paths, cursor)).rejects.toMatchObject({
      exitCode: EXIT_CODES.NOT_FOUND,
    });
  });
});
