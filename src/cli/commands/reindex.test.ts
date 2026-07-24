import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  newSessionId,
  newTicketId,
  type Session,
  sessionSchema,
  type Ticket,
  ticketSchema,
} from "../../core/index.js";
import type { EventContext, MutationEventSpec } from "../../repo/events.js";
import {
  createSession,
  createTicket,
  ensureDbDirs,
  listEvents,
  readSession,
  ticketFilePath,
} from "../../repo/index.js";
import type { RepoPaths } from "../../repo/index.js";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { runReindex } from "./reindex.js";

// A4: createTicket/createSession require an EventContext + a
// MutationEventSpec — these fixtures don't exercise event behavior.
const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };
const startedEvent: MutationEventSpec = { verb: "session.started" };

function makeSession(overrides: Partial<Session> = {}): Session {
  return sessionSchema.parse({
    id: newSessionId(),
    ticket: newTicketId(),
    actor: { name: "ryan", kind: "human" },
    harness: { kind: "other", session_id: null },
    git: { branch: null, commit_at_start: null },
    started_at: "2026-07-23T09:00:00.000Z",
    ...overrides,
  });
}

// src/cli/commands/reindex.test.ts -> ../../.. -> repo root -> src/cli/index.ts
const cliEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "Ticket",
    slug: `ticket-${id.slice(-8).toLowerCase()}`,
    spec: { summary: "s" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

function spawnReindex(cwd: string, args: string[] = []): SpawnSyncReturns<string> {
  return spawnSync("bun", [cliEntry, "reindex", ...args], { cwd, encoding: "utf8" });
}

let scratch: string;
let paths: RepoPaths;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-reindex-cmd-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// `slop reindex` — the recovery path for a corrupt db. Adversarial-review
// Finding 3: a single unreadable ticket file used to make this exact
// command throw, disabling the recovery path in precisely the situation
// it exists for. These tests exercise the real compiled-from-source CLI
// (spawned via `bun`, same convention as tests/acceptance/A1.test.ts's
// compiled-binary tests), not the action function in isolation, so the
// exit code / stdout / stderr contract is verified end to end.
describe("slop reindex — fault tolerance (adversarial-review Finding 3)", () => {
  it("with no corrupt files: rebuilds cleanly, prints a summary, and exits 0", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);

    const { status, stdout, stderr } = spawnReindex(scratch);
    expect(status).toBe(0);
    expect(stdout).toContain("reindexed: 1 ticket(s)");
    expect(stderr).toBe("");
  });

  it("one corrupt ticket among several: rebuilds the good ones, reports the bad one actionably, exits 1", async () => {
    const good1 = makeTicket();
    const good2 = makeTicket();
    await createTicket(paths, good1, ctx, createdEvent);
    await createTicket(paths, good2, ctx, createdEvent);
    const badId = newTicketId();
    const badPath = ticketFilePath(paths, badId);
    await writeFile(badPath, '{ "id": "not even close to valid" }');

    const { status, stdout, stderr } = spawnReindex(scratch);

    expect(status).toBe(1);
    expect(stdout).toContain("2 ticket(s) rebuilt");
    expect(stdout).toContain("1 skipped due to errors");
    expect(stderr).toContain(badPath);
    // Actionable — the underlying error detail survived, not just the path.
    expect(stderr.length).toBeGreaterThan(badPath.length + 20);

    // Best-effort persisted: the good tickets are actually in the
    // rebuilt index.jsonc's `tickets` rows on disk, not just reported in
    // stdout. The bad id legitimately DOES appear elsewhere in the file
    // (the persisted `problems` list, by design — see db-index.ts) so
    // this checks the `tickets` rows specifically, not a raw substring
    // match over the whole file.
    const onDiskIndex = JSON.parse(await readFile(paths.indexFile, "utf8")) as {
      tickets: { id: string }[];
      problems: { id: string }[];
    };
    const rebuiltIds = onDiskIndex.tickets.map((t) => t.id).sort();
    expect(rebuiltIds).toEqual([good1.id, good2.id].sort());
    expect(onDiskIndex.problems.map((p) => p.id)).toEqual([badId]);
  });

  it("several corrupt tickets: every one is reported in the same pass, not just the first", async () => {
    const good = makeTicket();
    await createTicket(paths, good, ctx, createdEvent);
    const bad1 = newTicketId();
    const bad2 = newTicketId();
    await writeFile(ticketFilePath(paths, bad1), "{ not even valid jsonc {{{");
    await writeFile(ticketFilePath(paths, bad2), '{ "id": "still not valid" }');

    const { status, stdout, stderr } = spawnReindex(scratch);

    expect(status).toBe(1);
    expect(stderr).toContain(ticketFilePath(paths, bad1));
    expect(stderr).toContain(ticketFilePath(paths, bad2));
    expect(stdout).toContain("2 skipped due to errors");
  });

  it("--strict fails fast on the first bad file, exits non-zero, and leaves index.jsonc untouched", async () => {
    const good = makeTicket();
    await createTicket(paths, good, ctx, createdEvent);
    const badId = newTicketId();
    await writeFile(ticketFilePath(paths, badId), "{ not even valid jsonc {{{");

    const before = await readFile(paths.indexFile, "utf8").catch(() => null);
    expect(before).toBeNull(); // never built yet

    const { status, stderr } = spawnReindex(scratch, ["--strict"]);

    expect(status).not.toBe(0);
    expect(stderr).toContain(ticketFilePath(paths, badId));

    // Strict mode aborts before ever writing an index.
    const after = await readFile(paths.indexFile, "utf8").catch(() => null);
    expect(after).toBeNull();
  });

  it("--strict succeeds normally (exit 0) when nothing is corrupt", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);

    const { status, stdout } = spawnReindex(scratch, ["--strict"]);
    expect(status).toBe(0);
    expect(stdout).toContain("reindexed: 1 ticket(s)");
  });
});

// ---------------------------------------------------------------------------
// In-process coverage of `runReindex` itself (real v8 coverage, no
// subprocess) — same scenarios as the spawned suite above, driven directly
// against a temp repo via withCwd/captureOutput (tests/support/cli-harness.ts).
// ---------------------------------------------------------------------------
describe("runReindex (in-process)", () => {
  it("rebuilds cleanly and prints a summary when nothing is corrupt", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);

    const out = captureOutput();
    try {
      await withCwd(scratch, () => runReindex({}));
      expect(out.stdout()).toContain("reindexed: 1 ticket(s)");
      expect(out.stderr()).toBe("");
    } finally {
      out.restore();
    }
  });

  it("throws a SlopError (GENERIC_ERROR) and still rebuilds the good tickets when one is corrupt", async () => {
    const good = makeTicket();
    await createTicket(paths, good, ctx, createdEvent);
    const badId = newTicketId();
    const badPath = ticketFilePath(paths, badId);
    await writeFile(badPath, '{ "id": "not even close to valid" }');

    const out = captureOutput();
    try {
      await expect(withCwd(scratch, () => runReindex({}))).rejects.toThrow(/unreadable ticket/i);
      expect(out.stdout()).toContain("1 ticket(s) rebuilt");
      expect(out.stdout()).toContain("1 skipped due to errors");
      expect(out.stderr()).toContain(badPath);
    } finally {
      out.restore();
    }

    const onDiskIndex = JSON.parse(await readFile(paths.indexFile, "utf8")) as {
      tickets: { id: string }[];
    };
    expect(onDiskIndex.tickets.map((t) => t.id)).toEqual([good.id]);
  });

  it("--strict (options.strict) fails fast and never writes index.jsonc", async () => {
    const badId = newTicketId();
    await writeFile(ticketFilePath(paths, badId), "{ not even valid jsonc {{{");

    const out = captureOutput();
    try {
      await expect(withCwd(scratch, () => runReindex({ strict: true }))).rejects.toThrow();
    } finally {
      out.restore();
    }

    const after = await readFile(paths.indexFile, "utf8").catch(() => null);
    expect(after).toBeNull();
  });

  it("reports swept stale temp files in the summary line", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    // A leftover temp file matching atomic-write.ts's naming convention
    // (`.tmp-<random>-<target-basename>`), backdated well past
    // DEFAULT_SWEEP_MIN_AGE_MS (60s) so sweepStaleTempFiles treats it as
    // stale rather than "another process might still be writing this".
    const staleTemp = join(paths.ticketsDir, `.tmp-deadbeef-${t.id}.jsonc`);
    await writeFile(staleTemp, "leftover");
    const old = new Date(Date.now() - 120_000);
    await utimes(staleTemp, old, old);

    const out = captureOutput();
    try {
      await withCwd(scratch, () => runReindex({}));
      expect(out.stdout()).toMatch(/swept 1 stale temp file/);
    } finally {
      out.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Orphaned active-session scan + --heal (ticket_01KYAPKRJ9RJRJRAV42WCTJET4)
// — sessions/repair.ts's own tests cover findOrphanedActiveSessions/
// buildHealedSession as pure functions; these exercise the CLI wiring:
// detection is always reported, --heal actually repairs, and a corrupt
// ticket read disables the scan rather than risk a false positive.
// ---------------------------------------------------------------------------
describe("runReindex — orphaned active-session scan + --heal", () => {
  it("reports an orphaned session (ended_at: null, no ticket references it) but does NOT touch it without --heal", async () => {
    await bootstrapRepo(scratch, { project: "p", user: "ryan" });
    const orphan = makeSession();
    await createSession(paths, orphan, ctx, startedEvent);

    const out = captureOutput();
    try {
      await withCwd(scratch, () => runReindex({}));
      expect(out.stdout()).toMatch(/1 orphaned active session\(s\) found/);
      expect(out.stdout()).toContain("--heal");
    } finally {
      out.restore();
    }

    const stillOnDisk = await readSession(paths, orphan.id);
    expect(stillOnDisk.ended_at).toBeNull();
    expect(stillOnDisk.end_summary).toBeNull();
  });

  it("--heal closes out the orphaned session: ended_at set, a synthesized end_summary, and a session.ended event with reason orphan_repair", async () => {
    await bootstrapRepo(scratch, { project: "p", user: "ryan" });
    const orphan = makeSession();
    await createSession(paths, orphan, ctx, startedEvent);

    const out = captureOutput();
    try {
      await withCwd(scratch, () => runReindex({ heal: true }));
      expect(out.stdout()).toMatch(/healed 1 orphaned active session\(s\)/);
    } finally {
      out.restore();
    }

    const healed = await readSession(paths, orphan.id);
    expect(healed.ended_at).not.toBeNull();
    expect(healed.end_summary).toMatch(/auto-healed/i);

    const events = await listEvents(paths);
    const healEvent = events.find(
      (e) =>
        e.entity.kind === "session" &&
        e.entity.id === orphan.id &&
        e.verb === "session.ended" &&
        e.payload.reason === "orphan_repair",
    );
    expect(healEvent).toBeDefined();
  });

  it("does NOT touch a session referenced by a ticket's active_session — only genuinely unreferenced ones are orphans", async () => {
    await bootstrapRepo(scratch, { project: "p", user: "ryan" });
    const session = makeSession();
    await createSession(paths, session, ctx, startedEvent);
    const ticket = makeTicket({
      state: "in_progress",
      active_session: session.id,
    });
    await createTicket(paths, ticket, ctx, createdEvent);

    const out = captureOutput();
    try {
      await withCwd(scratch, () => runReindex({ heal: true }));
      expect(out.stdout()).not.toMatch(/orphaned active session/);
    } finally {
      out.restore();
    }

    const stillReferenced = await readSession(paths, session.id);
    expect(stillReferenced.ended_at).toBeNull();
  });

  it("does NOT touch (or count) an already-ended session, referenced or not", async () => {
    await bootstrapRepo(scratch, { project: "p", user: "ryan" });
    const ended = makeSession({ ended_at: "2026-07-23T10:00:00.000Z", end_summary: "wrapped up" });
    await createSession(paths, ended, ctx, startedEvent);

    const out = captureOutput();
    try {
      await withCwd(scratch, () => runReindex({ heal: true }));
      expect(out.stdout()).not.toMatch(/orphaned active session/);
    } finally {
      out.restore();
    }

    const stillEnded = await readSession(paths, ended.id);
    expect(stillEnded.end_summary).toBe("wrapped up");
  });

  it("skips the orphan scan entirely (with a warning) when the ticket read itself had unreadable file(s) — never risks a false positive", async () => {
    await bootstrapRepo(scratch, { project: "p", user: "ryan" });
    const orphan = makeSession();
    await createSession(paths, orphan, ctx, startedEvent);
    const badId = newTicketId();
    await writeFile(ticketFilePath(paths, badId), "{ not even valid jsonc {{{");

    const out = captureOutput();
    try {
      await expect(withCwd(scratch, () => runReindex({ heal: true }))).rejects.toThrow();
      expect(out.stderr()).toMatch(/skipped the orphaned-active-session scan/i);
    } finally {
      out.restore();
    }

    // --heal never ran: the orphan is untouched.
    const stillOnDisk = await readSession(paths, orphan.id);
    expect(stillOnDisk.ended_at).toBeNull();
  });

  it("reports zero orphans cleanly (no extra note in the summary) when there are none", async () => {
    await bootstrapRepo(scratch, { project: "p", user: "ryan" });
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);

    const out = captureOutput();
    try {
      await withCwd(scratch, () => runReindex({}));
      expect(out.stdout()).not.toMatch(/orphaned active session/);
    } finally {
      out.restore();
    }
  });
});
