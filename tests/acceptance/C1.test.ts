import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SessionId, Ticket } from "../../src/core/index.js";
import {
  newSessionId,
  newTicketId,
  sessionSchema,
  specSchema,
  ticketSchema,
} from "../../src/core/index.js";
import type { EventContext, MutationEventSpec, RepoPaths } from "../../src/repo/index.js";
import {
  createSession,
  createTicket,
  ensureDbDirs,
  listEvents,
  listSessions,
  readSession,
  readTicket,
} from "../../src/repo/index.js";

// C1: Sessions
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "Two concurrent `start`s: second warns; `--takeover` logs event;
//   context pack under budget"
//
// Fixtures are built directly against the repo layer (ensureDbDirs +
// createTicket/createSession + a hand-written minimal config.yaml) rather
// than via `slop init` — faster and gives exact control over ticket/session
// state (draft tickets, pre-seeded sessions with specific timestamps,
// tickets with long spec.details_md) without an extra process spawn per
// fixture. Every actual `start`/`stop`/`context` invocation under test
// still goes through the REAL compiled `dist/slop` binary (D5's "vitest
// workers are Node, not Bun" — this project's own convention for anything
// that must be exercised as a genuine OS process, e.g. the concurrency
// test below).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
  // Same "build if missing" convention as A1.test.ts/D1.test.ts/D5.test.ts.
  if (!existsSync(binaryPath)) {
    execFileSync("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  }
  if (!existsSync(binaryPath)) {
    throw new Error(
      `${binaryPath} is still missing after attempting "bun run build". ` +
        'Run "bun run build" manually and re-run the tests.',
    );
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

async function makeRepo(): Promise<{ dir: string; paths: RepoPaths }> {
  const dir = await mkdtemp(join(tmpdir(), "slop-c1-"));
  scratchDirs.push(dir);
  const paths = await ensureDbDirs(dir);
  await writeFile(join(dir, ".slop", "config.yaml"), "project: c1-test\n", "utf8");
  return { dir, paths };
}

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const d = scratchDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

const ctx: EventContext = { actor: { name: "fixture", kind: "human" }, session: null };
const ticketCreated: MutationEventSpec = { verb: "ticket.created" };
const sessionStarted: MutationEventSpec = { verb: "session.started" };

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "Fixture ticket",
    slug: `ticket-${id.slice(-10).toLowerCase()}`,
    spec: { summary: "s" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "fixture", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

/** Every harness-identity env var any of the three real harnesses set
 * (spikes/findings.md §1) — stripped by default so this suite's own
 * ambient environment (which may itself be a real Claude Code session,
 * per findings.md §1.1's own reproduced dump) never leaks into a test
 * asserting on detection. Mirrors tests/acceptance/D1.test.ts's `runSlop`. */
const HARNESS_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "OPENCODE",
  "OPENCODE_PID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
] as const;

function slopEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, SLOP_ACTOR: "c1-test-actor" };
  for (const key of HARNESS_ENV_KEYS) env[key] = undefined;
  for (const [k, v] of Object.entries(overrides)) env[k] = v;
  return env;
}

function runSlop(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string | undefined> = {},
) {
  return spawnSync(binaryPath, args, { cwd, encoding: "utf8", env: slopEnv(envOverrides) });
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  finishedAt: number;
}

function collect(proc: ChildProcess): Promise<SpawnResult> {
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  return new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code) => {
      resolve({ code, stdout, stderr, startedAt, finishedAt: Date.now() });
    });
  });
}

async function snapshotDb(paths: RepoPaths): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const dir of [paths.ticketsDir, paths.sessionsDir, paths.eventsDir]) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.sort()) {
      snapshot[join(dir, name)] = await readFile(join(dir, name), "utf8");
    }
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Clause 1: "Two concurrent `start`s: second warns"
// ---------------------------------------------------------------------------

describe("C1: Sessions", () => {
  describe('"Two concurrent `start`s: second warns"', () => {
    it("spawns two REAL racing processes against the same ticket: exactly one wins, the other warns " +
      "and exits non-zero with an actionable message, and the db is left consistent — repeated, " +
      "and never accidentally serialised", async () => {
      const ITERATIONS = 8;
      let sawGenuineOverlap = false;

      for (let i = 0; i < ITERATIONS; i++) {
        const { dir, paths } = await makeRepo();
        const ticket = makeTicket({ name: `Race ticket ${i}` });
        await createTicket(paths, ticket, ctx, ticketCreated);

        // Spawned back-to-back, with NO await between them, so the OS
        // starts both processes as close to simultaneously as this
        // process can arrange — this is what makes the race real rather
        // than accidentally serialised (see the overlap assertion below,
        // which proves it rather than just hoping for it).
        const procA = spawn(binaryPath, ["start", ticket.slug], {
          cwd: dir,
          env: slopEnv({ SLOP_ACTOR: "agent-a" }),
        });
        const procB = spawn(binaryPath, ["start", ticket.slug], {
          cwd: dir,
          env: slopEnv({ SLOP_ACTOR: "agent-b" }),
        });

        const [resultA, resultB] = await Promise.all([collect(procA), collect(procB)]);

        // Proof the two invocations genuinely overlapped in wall-clock
        // time (rather than one finishing before the other even started)
        // — if this were never true across every iteration, the test
        // could be passing vacuously off pure lock-based serialisation
        // with no actual OS-level concurrency behind it.
        const overlapped =
          Math.max(resultA.startedAt, resultB.startedAt) <
          Math.min(resultA.finishedAt, resultB.finishedAt);
        if (overlapped) sawGenuineOverlap = true;

        const codes = [resultA.code, resultB.code].sort((a, b) => (a ?? -1) - (b ?? -1));
        expect(codes, `iteration ${i}: codes were ${JSON.stringify(codes)}`).toEqual([0, 6]);

        const winner = resultA.code === 0 ? resultA : resultB;
        const loser = resultA.code === 0 ? resultB : resultA;
        expect(winner.stdout).toContain("started");
        expect(loser.stderr).toMatch(/already has an active session/i);
        expect(loser.stderr).toMatch(/--takeover/);

        // The db is left consistent: exactly one session was created, it
        // is active, and the ticket points at exactly it — no half
        // -written state from the loser.
        const sessions = await listSessions(paths);
        expect(sessions, `iteration ${i}`).toHaveLength(1);
        expect(sessions[0]?.ended_at).toBeNull();
        const finalTicket = await readTicket(paths, ticket.id);
        expect(finalTicket.state).toBe("in_progress");
        expect(finalTicket.active_session).toBe(sessions[0]?.id);
      }

      expect(
        sawGenuineOverlap,
        "no iteration showed the two processes genuinely overlapping in wall-clock time — " +
          "this would mean the test could pass vacuously via accidental serialisation",
      ).toBe(true);
    }, 60_000);
  });

  // ---------------------------------------------------------------------------
  // Clause 2: "`--takeover` logs event"
  // ---------------------------------------------------------------------------

  describe('"`--takeover` logs event"', () => {
    it("emits session.takeover with correct actor/session/entity; the previous session ends; the new one is active", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket({ name: "Takeover ticket" });
      await createTicket(paths, ticket, ctx, ticketCreated);

      const first = runSlop(["start", ticket.slug], dir, { SLOP_ACTOR: "first-agent" });
      expect(first.status, first.stderr).toBe(0);

      const afterFirst = await readTicket(paths, ticket.id);
      const firstSessionId = afterFirst.active_session as SessionId;
      expect(firstSessionId).not.toBeNull();

      // Without --takeover: refuses (also exercises clause 1's message
      // shape via a second, deterministic path).
      const blocked = runSlop(["start", ticket.slug], dir, { SLOP_ACTOR: "second-agent" });
      expect(blocked.status).not.toBe(0);
      expect(blocked.status).toBe(6);
      expect(blocked.stderr).toMatch(/already has an active session/i);

      // With --takeover: seizes it, logged.
      const taken = runSlop(["start", ticket.slug, "--takeover"], dir, {
        SLOP_ACTOR: "second-agent",
      });
      expect(taken.status, taken.stderr).toBe(0);

      const events = await listEvents(paths);
      const takeoverEvents = events.filter((e) => e.verb === "session.takeover");
      expect(takeoverEvents).toHaveLength(1);
      const event = takeoverEvents[0];
      if (!event) throw new Error("unreachable");
      expect(event.actor.name).toBe("second-agent");
      expect(event.entity).toEqual({ kind: "session", id: firstSessionId });

      const previousSession = await readSession(paths, firstSessionId);
      expect(previousSession.ended_at).not.toBeNull();
      expect(previousSession.end_summary).toContain("second-agent");

      const afterTakeover = await readTicket(paths, ticket.id);
      expect(afterTakeover.state).toBe("in_progress");
      expect(afterTakeover.active_session).not.toBe(firstSessionId);
      const newSessionId = afterTakeover.active_session as SessionId;
      const newSession = await readSession(paths, newSessionId);
      expect(newSession.ended_at).toBeNull();
      expect(newSession.actor.name).toBe("second-agent");

      // The takeover event is recorded "under" the new session, and
      // describes ending the OLD one — both correct per the entity it
      // mutates (the previous session) and the session context it runs
      // under (the new one).
      expect(event.session).toBe(newSessionId);
    });
  });

  // ---------------------------------------------------------------------------
  // Clause 3: "context pack under budget"
  // ---------------------------------------------------------------------------

  describe('"context pack under budget"', () => {
    it("`slop context --budget N` genuinely respects N for several values, including one small enough to force real elision, and stays coherent", async () => {
      const { dir, paths } = await makeRepo();
      const longDetails = "Lorem ipsum dolor sit amet consectetur. ".repeat(150);
      const ticket = makeTicket({
        name: "Budget ticket",
        spec: specSchema.parse({
          summary: "The summary line",
          details_md: longDetails,
          acceptance: ["it works"],
        }),
      });
      await createTicket(paths, ticket, ctx, ticketCreated);

      for (let i = 0; i < 3; i++) {
        const session = sessionSchema.parse({
          id: newSessionId(),
          ticket: ticket.id,
          actor: { name: `agent-${i}`, kind: "agent" },
          harness: { kind: "claude-code", session_id: null },
          git: { branch: "main", commit_at_start: "abc" },
          started_at: `2026-07-${10 + i}T09:00:00.000Z`,
        });
        await createSession(paths, session, ctx, sessionStarted);
      }

      const full = runSlop(["context", ticket.slug], dir);
      expect(full.status, full.stderr).toBe(0);
      expect(full.stdout.length).toBeGreaterThan(1500);

      for (const budget of [100, 500, 1500]) {
        const result = runSlop(["context", ticket.slug, "--budget", String(budget)], dir);
        expect(result.status, `budget=${budget}: ${result.stderr}`).toBe(0);
        // The command appends exactly one trailing newline; the rendered
        // pack body itself is what must respect budget.
        expect(result.stdout.length, `budget=${budget}`).toBeLessThanOrEqual(budget + 1);
      }

      // Small enough to force real elision (sessions AND details_md) —
      // still exits cleanly, still names what was dropped, still shows the
      // ticket's own name (coherent, not a garbled mid-word cut).
      const tiny = runSlop(["context", ticket.slug, "--budget", "300"], dir);
      expect(tiny.status, tiny.stderr).toBe(0);
      expect(tiny.stdout).toContain("Elided for --budget");
      expect(tiny.stdout).toContain(ticket.name);
    });

    it("context makes NO state change whatsoever — the db is byte-identical before and after, budgeted or not", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket({
        spec: specSchema.parse({ summary: "s", details_md: "some details here" }),
      });
      await createTicket(paths, ticket, ctx, ticketCreated);

      const before = await snapshotDb(paths);
      const plain = runSlop(["context", ticket.slug], dir);
      expect(plain.status, plain.stderr).toBe(0);
      const budgeted = runSlop(["context", ticket.slug, "--budget", "40"], dir);
      expect(budgeted.status, budgeted.stderr).toBe(0);
      const after = await snapshotDb(paths);

      expect(after).toEqual(before);
    });
  });

  // ---------------------------------------------------------------------------
  // Also cover: harness sniff, --harness override, unknown -> other, git
  // capture + degradation, draft refusal, stop.
  // ---------------------------------------------------------------------------

  describe("harness sniff", () => {
    it("claude-code: CLAUDECODE=1 + CLAUDE_CODE_SESSION_ID both land on the session entity", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);

      const result = runSlop(["start", ticket.slug], dir, {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "fake-session-uuid-123",
      });
      expect(result.status, result.stderr).toBe(0);

      const t = await readTicket(paths, ticket.id);
      const session = await readSession(paths, t.active_session as SessionId);
      expect(session.harness).toEqual({ kind: "claude-code", session_id: "fake-session-uuid-123" });
    });

    it("--harness overrides env sniffing even when the env disagrees", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);

      const result = runSlop(["start", ticket.slug, "--harness", "opencode"], dir, {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "should-be-ignored",
      });
      expect(result.status, result.stderr).toBe(0);

      const t = await readTicket(paths, ticket.id);
      const session = await readSession(paths, t.active_session as SessionId);
      expect(session.harness).toEqual({ kind: "opencode", session_id: null });
    });

    it("no detectable harness -> 'other' with session_id null, no error, but a stderr warning", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);

      const result = runSlop(["start", ticket.slug], dir);
      expect(result.status, result.stderr).toBe(0);

      const t = await readTicket(paths, ticket.id);
      const session = await readSession(paths, t.active_session as SessionId);
      expect(session.harness).toEqual({ kind: "other", session_id: null });
      expect(result.stderr).toMatch(/could not detect a known harness/i);
    });
  });

  describe("git branch/commit capture", () => {
    it("captures branch and commit_at_start in a real git repo", async () => {
      const { dir, paths } = await makeRepo();
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "a@b.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
      writeFileSync(join(dir, "f.txt"), "hi");
      execFileSync("git", ["add", "f.txt"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });

      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      const result = runSlop(["start", ticket.slug], dir);
      expect(result.status, result.stderr).toBe(0);

      const t = await readTicket(paths, ticket.id);
      const session = await readSession(paths, t.active_session as SessionId);
      expect(session.git.branch).not.toBeNull();
      expect(session.git.commit_at_start).toMatch(/^[0-9a-f]{40}$/);
    });

    it("degrades gracefully on detached HEAD: branch null, commit still captured, warns but does not block", async () => {
      const { dir, paths } = await makeRepo();
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "a@b.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
      writeFileSync(join(dir, "f.txt"), "hi");
      execFileSync("git", ["add", "f.txt"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });
      execFileSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: dir });

      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      const result = runSlop(["start", ticket.slug], dir);
      expect(result.status, result.stderr).toBe(0);

      const t = await readTicket(paths, ticket.id);
      const session = await readSession(paths, t.active_session as SessionId);
      expect(session.git.branch).toBeNull();
      expect(session.git.commit_at_start).not.toBeNull();
      expect(result.stderr).toMatch(/detached/i);
    });

    it("degrades gracefully with no commits yet: commit_at_start null, does not block", async () => {
      const { dir, paths } = await makeRepo();
      execFileSync("git", ["init", "-q"], { cwd: dir });

      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      const result = runSlop(["start", ticket.slug], dir);
      expect(result.status, result.stderr).toBe(0);

      const t = await readTicket(paths, ticket.id);
      const session = await readSession(paths, t.active_session as SessionId);
      expect(session.git.commit_at_start).toBeNull();
      expect(result.stderr).toMatch(/no commits yet/i);
    });

    it("degrades gracefully outside any git repository at all: both null, does not block", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      const result = runSlop(["start", ticket.slug], dir);
      expect(result.status, result.stderr).toBe(0);

      const t = await readTicket(paths, ticket.id);
      const session = await readSession(paths, t.active_session as SessionId);
      expect(session.git).toEqual({ branch: null, commit_at_start: null });
      expect(result.stderr).toMatch(/no git information/i);
    });
  });

  describe("start refuses a draft (D13)", () => {
    it("exits CONFLICT (6), names D13, and creates no session", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket({ state: "draft" });
      await createTicket(paths, ticket, ctx, ticketCreated);

      const result = runSlop(["start", ticket.slug], dir);
      expect(result.status).toBe(6);
      expect(result.stderr).toMatch(/draft/i);

      const sessions = await listSessions(paths);
      expect(sessions).toHaveLength(0);
      const t = await readTicket(paths, ticket.id);
      expect(t.state).toBe("draft");
    });
  });

  describe("`slop stop`", () => {
    it("returns the ticket to open, clears active_session, and records the handoff note", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);

      const started = runSlop(["start", ticket.slug], dir);
      expect(started.status, started.stderr).toBe(0);

      const stopped = runSlop(["stop", ticket.slug, "--note", "handed off cleanly"], dir);
      expect(stopped.status, stopped.stderr).toBe(0);

      const t = await readTicket(paths, ticket.id);
      expect(t.state).toBe("open");
      expect(t.active_session).toBeNull();

      const sessions = await listSessions(paths);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.ended_at).not.toBeNull();
      expect(sessions[0]?.end_summary).toBe("handed off cleanly");
      // C4's seam — stop never fabricates a transcript reference.
      expect(sessions[0]?.transcript_ref).toBeNull();
    });

    it("nudges (stderr warning) but does not block when --note is omitted", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      runSlop(["start", ticket.slug], dir);

      const stopped = runSlop(["stop", ticket.slug], dir);
      expect(stopped.status, stopped.stderr).toBe(0);
      expect(stopped.stderr).toMatch(/no --note/i);
    });

    it("refuses (CONFLICT, 6) when there is no active session to stop", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      const result = runSlop(["stop", ticket.slug], dir);
      expect(result.status).toBe(6);
    });
  });
});
