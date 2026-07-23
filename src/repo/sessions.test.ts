import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Session, newSessionId, newTicketId, sessionSchema } from "../core/index.js";
import type { EventContext, MutationEventSpec } from "./events.js";
import { listEvents } from "./events.js";
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

// A4: createSession/updateSession now require an EventContext + a
// MutationEventSpec on every call (repo/events.ts) — these are the
// fixture defaults for tests below that aren't specifically exercising
// event-emission behavior.
const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const startedEvent: MutationEventSpec = { verb: "session.started" };

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
    await createSession(paths, session, ctx, startedEvent);
    await expect(readSession(paths, session.id)).resolves.toEqual(session);
  });

  it("readSession throws NOT_FOUND for a missing id", async () => {
    await expect(readSession(paths, newSessionId())).rejects.toMatchObject({ exitCode: 4 });
  });

  // A4 (co-located unit-level spot check; the general property across the
  // whole mutation surface lives in tests/acceptance/A4.test.ts).
  it("emits exactly one session.started event, self-referencing the new session's own id", async () => {
    const session = makeSession();
    // Realistic pattern: the session's id is minted before the write
    // (core/ids.ts's newSessionId), so a caller can self-reference it as
    // the event context's `session` — the event genuinely happens "under"
    // the session it's creating.
    const startCtx: EventContext = { actor: session.actor, session: session.id };
    const event = await createSession(paths, session, startCtx, { verb: "session.started" });

    const events = await listEvents(paths);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
    expect(event.verb).toBe("session.started");
    expect(event.actor).toEqual(session.actor);
    expect(event.session).toBe(session.id);
    expect(event.entity).toEqual({ kind: "session", id: session.id });
  });
});

describe("updateSession", () => {
  it("applies a plan-revision-shaped patch", async () => {
    const session = makeSession();
    await createSession(paths, session, ctx, startedEvent);
    const after: Session = {
      ...session,
      plan: [
        { version: 1, steps: [{ text: "step 1", checked: false }], created_at: session.started_at },
      ],
    };
    await updateSession(paths, session.id, [{ path: ["plan"], value: after.plan }], after, ctx, {
      verb: "plan.set",
    });
    await expect(readSession(paths, session.id)).resolves.toEqual(after);
  });

  it("emits exactly one event (on top of the create's own), with the caller-supplied verb", async () => {
    const session = makeSession();
    await createSession(paths, session, ctx, startedEvent);
    const after: Session = { ...session, end_summary: "done" };
    const sessionCtx: EventContext = { actor: session.actor, session: session.id };
    const event = await updateSession(
      paths,
      session.id,
      [{ path: ["end_summary"], value: "done" }],
      after,
      sessionCtx,
      { verb: "session.ended" },
    );

    const events = await listEvents(paths);
    expect(events).toHaveLength(2); // the create's event, then this one
    expect(events[1]).toEqual(event);
    expect(event.verb).toBe("session.ended");
    expect(event.entity).toEqual({ kind: "session", id: session.id });
  });

  it("throws NOT_FOUND against a nonexistent session and emits no event", async () => {
    const fakeAfter = makeSession();
    await expect(
      updateSession(
        paths,
        newSessionId(),
        [{ path: ["end_summary"], value: "x" }],
        fakeAfter,
        ctx,
        {
          verb: "session.ended",
        },
      ),
    ).rejects.toMatchObject({ exitCode: 4 });
    await expect(listEvents(paths)).resolves.toEqual([]);
  });
});

describe("deleteSession", () => {
  it("removes the file", async () => {
    const session = makeSession();
    await createSession(paths, session, ctx, startedEvent);
    await deleteSession(paths, session.id);
    await expect(readSession(paths, session.id)).rejects.toMatchObject({ exitCode: 4 });
  });
});

describe("listSessionIds / listSessions", () => {
  it("filters out non-session files and sorts ascending", async () => {
    const a = makeSession();
    const b = makeSession();
    await createSession(paths, a, ctx, startedEvent);
    await createSession(paths, b, ctx, startedEvent);
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
