import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newSessionId, newTicketId, type Session, sessionSchema } from "../core/index.js";
import { ensureDbDirs } from "./paths.js";
import type { RepoPaths } from "./paths.js";
import {
  createSession,
  deleteSession,
  listSessionIds,
  listSessions,
  readSession,
  sessionFilePath,
  updateSession,
} from "./sessions.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return sessionSchema.parse({
    id: newSessionId(),
    ticket: newTicketId(),
    actor: { name: "ryan", kind: "human" },
    harness: { kind: "claude-code", session_id: null },
    git: { branch: "main", commit_at_start: null },
    started_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

let scratch: string;
let paths: RepoPaths;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-sessions-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("createSession / readSession", () => {
  it("round-trips a full session", async () => {
    const session = makeSession();
    await createSession(paths, session);
    await expect(readSession(paths, session.id)).resolves.toEqual(session);
  });

  it("readSession throws NOT_FOUND for a missing id", async () => {
    await expect(readSession(paths, newSessionId())).rejects.toMatchObject({ exitCode: 4 });
  });
});

describe("updateSession", () => {
  it("applies a plan-revision-shaped patch", async () => {
    const session = makeSession();
    await createSession(paths, session);
    const after: Session = {
      ...session,
      plan: [{ version: 1, steps: [{ text: "step 1", checked: false }], created_at: session.started_at }],
    };
    await updateSession(paths, session.id, [{ path: ["plan"], value: after.plan }], after);
    await expect(readSession(paths, session.id)).resolves.toEqual(after);
  });

  it("throws NOT_FOUND against a nonexistent session", async () => {
    const fakeAfter = makeSession();
    await expect(
      updateSession(paths, newSessionId(), [{ path: ["end_summary"], value: "x" }], fakeAfter),
    ).rejects.toMatchObject({ exitCode: 4 });
  });
});

describe("deleteSession", () => {
  it("removes the file", async () => {
    const session = makeSession();
    await createSession(paths, session);
    await deleteSession(paths, session.id);
    await expect(readSession(paths, session.id)).rejects.toMatchObject({ exitCode: 4 });
  });
});

describe("listSessionIds / listSessions", () => {
  it("filters out non-session files and sorts ascending", async () => {
    const a = makeSession();
    const b = makeSession();
    await createSession(paths, a);
    await createSession(paths, b);
    await writeFile(join(paths.sessionsDir, ".tmp-x-session_y.jsonc"), "partial");

    const ids = await listSessionIds(paths);
    expect(ids).toEqual([a.id, b.id].sort());
    const all = await listSessions(paths);
    expect(all.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("sessionFilePath", () => {
  it("is <sessionsDir>/<id>.jsonc", () => {
    const id = newSessionId();
    expect(sessionFilePath(paths, id)).toBe(join(paths.sessionsDir, `${id}.jsonc`));
  });
});
