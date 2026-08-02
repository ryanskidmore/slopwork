import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../core/clock.js";
import { newSessionId, newTicketId, type Session, sessionSchema } from "../core/index.js";
import type { EventContext, MutationEventSpec } from "../repo/events.js";
import { createSession, ensureDbDirs, type RepoPaths } from "../repo/index.js";
import { sessionFilePath } from "../repo/sessions.js";
import { FlatfileBackend } from "../storage/flatfile.js";
import { buildHealedSession, findOrphanedActiveSessions } from "./repair.js";

const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const startedEvent: MutationEventSpec = { verb: "session.started" };

function makeSession(overrides: Partial<Session> = {}): Session {
  return sessionSchema.parse({
    id: newSessionId(),
    ticket: newTicketId(),
    actor: { name: "ryan", kind: "human" },
    harness: { kind: "claude-code", session_id: null },
    git: { branch: "main", commit_at_start: "abc" },
    started_at: "2026-07-23T09:00:00.000Z",
    ...overrides,
  });
}

let scratch: string;
let paths: RepoPaths;
let backend: FlatfileBackend;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-repair-test-"));
  paths = await ensureDbDirs(scratch);
  backend = new FlatfileBackend(paths);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("findOrphanedActiveSessions", () => {
  it("flags an ended_at:null session that no ticket's active_session references", async () => {
    const session = makeSession();
    await createSession(paths, session, ctx, startedEvent);

    const scan = await findOrphanedActiveSessions(backend, new Set());
    expect(scan.orphans.map((s) => s.id)).toEqual([session.id]);
    expect(scan.problems).toEqual([]);
  });

  it("does NOT flag a session referenced by some ticket's active_session", async () => {
    const session = makeSession();
    await createSession(paths, session, ctx, startedEvent);

    const scan = await findOrphanedActiveSessions(backend, new Set([session.id]));
    expect(scan.orphans).toEqual([]);
  });

  it("does NOT flag an already-ended session, referenced or not — an ended session was never 'stranded'", async () => {
    const session = makeSession({ ended_at: "2026-07-23T10:00:00.000Z" });
    await createSession(paths, session, ctx, startedEvent);

    const scan = await findOrphanedActiveSessions(backend, new Set());
    expect(scan.orphans).toEqual([]);
  });

  it("handles multiple sessions: only the unreferenced ended_at:null one is flagged", async () => {
    const referenced = makeSession();
    const orphan = makeSession();
    const ended = makeSession({ ended_at: "2026-07-23T10:00:00.000Z" });
    await createSession(paths, referenced, ctx, startedEvent);
    await createSession(paths, orphan, ctx, startedEvent);
    await createSession(paths, ended, ctx, startedEvent);

    const scan = await findOrphanedActiveSessions(backend, new Set([referenced.id]));
    expect(scan.orphans.map((s) => s.id)).toEqual([orphan.id]);
  });

  it("returns empty (never throws) when there are no sessions at all", async () => {
    const scan = await findOrphanedActiveSessions(backend, new Set());
    expect(scan.orphans).toEqual([]);
    expect(scan.problems).toEqual([]);
  });

  it("reports a corrupt session file as a problem, tolerantly — does not take the whole scan down and does not misreport it as an orphan", async () => {
    const good = makeSession();
    await createSession(paths, good, ctx, startedEvent);
    const badId = newSessionId();
    await writeFile(sessionFilePath(paths, badId), "{ not even valid jsonc {{{");

    const scan = await findOrphanedActiveSessions(backend, new Set());
    expect(scan.orphans.map((s) => s.id)).toEqual([good.id]);
    expect(scan.problems).toHaveLength(1);
    expect(scan.problems[0]?.id).toBe(badId);
    expect(scan.problems[0]?.path).toBe(sessionFilePath(paths, badId));
  });
});

describe("buildHealedSession", () => {
  const clock = fixedClock(new Date("2026-07-24T12:00:00.000Z"));

  it("sets ended_at to now and a synthesized end_summary explaining the auto-heal", () => {
    const session = makeSession();
    const healed = buildHealedSession(session, clock);
    expect(healed.ended_at).toBe("2026-07-24T12:00:00.000Z");
    expect(healed.end_summary).toMatch(/auto-healed/i);
    expect(healed.end_summary).toMatch(/reindex --heal/);
  });

  it("leaves every other field untouched", () => {
    const session = makeSession();
    const healed = buildHealedSession(session, clock);
    expect(healed.id).toBe(session.id);
    expect(healed.ticket).toBe(session.ticket);
    expect(healed.actor).toEqual(session.actor);
    expect(healed.harness).toEqual(session.harness);
    expect(healed.started_at).toBe(session.started_at);
  });

  it("overwrites a pre-existing (human-authored or otherwise) end_summary — an orphan by definition never had a real one for THIS ending", () => {
    const session = makeSession({ end_summary: "some stale note" });
    const healed = buildHealedSession(session, clock);
    expect(healed.end_summary).not.toBe("some stale note");
    expect(healed.end_summary).toMatch(/auto-healed/i);
  });
});
