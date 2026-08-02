import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Session, Ticket, TicketId } from "../../src/core/index.js";
import {
  newSessionId,
  newTicketId,
  sessionSchema,
  shortTicketCode,
  slugify,
  ticketSchema,
} from "../../src/core/index.js";
import type { DbIndex, RepoPaths } from "../../src/repo/index.js";
import {
  buildIndex,
  createEntityFileCanonical,
  ensureDbDirs,
  rebuildIndex,
  sessionFilePath,
  ticketFilePath,
  writeIndex,
} from "../../src/repo/index.js";
import { perfBudgetMs } from "../support/perf-scale.js";

// D4: status
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "One screen, < 1s on 1k tickets"
//
// Fixtures are built via the repo layer DIRECTLY (`ensureDbDirs` + a
// hand-written config.yaml + `createEntityFileCanonical` straight onto
// ticket/session files, no event emission) — this work item's brief calls
// this out as "fastest for 1000 tickets", and matching D3.test.ts's own
// established convention for fixtures that don't need `slop new`'s
// ceremony. The `status` command itself is always driven as a real CLI:
// every assertion below spawns the compiled `dist/slop` binary, per
// README.md's testing convention.
//
// Review-state tickets are written directly with `state: "review"` and a
// `review: {mr, requested_at, by}` field — `slop review --mr` (C3) does
// not exist yet, so this is the only way to exercise the "awaiting review
// w/ MR links" section end-to-end today, exactly as the brief directs.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
  // Same "build if missing" convention as A1.test.ts / D2.test.ts / D3.test.ts.
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
// Fixture + spawn helpers
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const CONFIG_YAML = [
  "project: d4-fixture",
  "user: d4-tester",
  "defaults:",
  "  stale_after: 60m",
  "  review_stale_after: 24h",
  "",
].join("\n");

/** Build a bare repo directly through the repo layer — no `slop init`, matching D3.test.ts's convention. */
async function makeScratchRepo(prefix: string): Promise<RepoPaths> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  const paths = await ensureDbDirs(dir);
  writeFileSync(join(dir, ".slop", "config.yaml"), CONFIG_YAML, "utf8");
  return paths;
}

/** `spawnSync` against the compiled binary, harness env vars stripped so
 * actor/harness-dependent behavior stays deterministic even when this
 * suite runs inside a real agent harness — same convention as
 * B1.test.ts/D2.test.ts's `runSlop`. `extraEnv` is how tests pin
 * `SLOP_FAKE_NOW` (this file's clock seam — see status.ts's module
 * doc). */
function runSlop(
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync(binaryPath, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      OPENCODE: undefined,
      CODEX_SANDBOX: undefined,
      CODEX_SANDBOX_NETWORK_DISABLED: undefined,
      ...extraEnv,
    },
  });
}

function status(dir: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) {
  return runSlop(["status", ...args], dir, extraEnv);
}

interface StatusJsonSession {
  id: string;
  actor: string;
  harness: string;
  started_at: string;
  age_ms: number;
  age_human: string;
}

interface StatusJsonInProgress {
  id: string;
  slug: string;
  name: string;
  priority: number;
  session: StatusJsonSession | null;
}

interface StatusJsonReview {
  id: string;
  slug: string;
  name: string;
  mr: string | null;
  requested_at: string;
  by: string;
  age_ms: number;
  age_human: string;
  review_stale: boolean;
}

interface StatusJsonStale {
  id: string;
  slug: string;
  name: string;
  state: "in_progress" | "review";
}

interface StatusJsonOutput {
  generated_at: string;
  counts: {
    draft: number;
    open: number;
    in_progress: number;
    review: number;
    done: number;
    dropped: number;
    total: number;
  };
  derived: { blocked: number | null; stale: number };
  in_progress: StatusJsonInProgress[];
  review: StatusJsonReview[];
  stale: StatusJsonStale[];
  problems: { id: string; message: string }[];
}

function statusJson(dir: string, extraEnv: NodeJS.ProcessEnv = {}): StatusJsonOutput {
  const result = status(dir, ["--json"], extraEnv);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as StatusJsonOutput;
}

// ---------------------------------------------------------------------------
// Entity builders — direct repo-layer writes, no event emission (this
// suite never asserts on events, so the extra I/O would only slow fixture
// setup down for nothing).
// ---------------------------------------------------------------------------

const NOW = "2026-07-23T10:00:00.000Z";
let ticketCounter = 0;

function makeTicket(overrides: Partial<Ticket> & { name: string; state: Ticket["state"] }): Ticket {
  const id = overrides.id ?? newTicketId();
  ticketCounter += 1;
  return ticketSchema.parse({
    id,
    slug: `${slugify(overrides.name)}-${ticketCounter}`,
    spec: { summary: "s" },
    priority: 2,
    root_id: id,
    active_session: null,
    provenance: { method: "new", created_by: { name: "fixture", kind: "agent" } },
    last_activity_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  });
}

function makeSession(overrides: Partial<Session> & { ticket: TicketId }): Session {
  return sessionSchema.parse({
    id: newSessionId(),
    actor: { name: "fixture-agent", kind: "agent" },
    harness: { kind: "claude-code", session_id: null },
    git: { branch: "main", commit_at_start: null },
    started_at: NOW,
    ...overrides,
  });
}

async function writeTicket(paths: RepoPaths, ticket: Ticket): Promise<void> {
  await createEntityFileCanonical(ticketFilePath(paths, ticket.id), ticket);
}

async function writeSession(paths: RepoPaths, session: Session): Promise<void> {
  await createEntityFileCanonical(sessionFilePath(paths, session.id), session);
}

// ---------------------------------------------------------------------------

describe("D4: status", () => {
  // -------------------------------------------------------------------------
  // The quoted acceptance criterion itself.
  // -------------------------------------------------------------------------

  describe('"One screen, < 1s on 1k tickets"', () => {
    it("1000 tickets: the real spawned `status` command completes well under budget, and the output stays bounded (not 1000 rows)", async () => {
      const paths = await makeScratchRepo("slop-d4-perf-");

      const total = 1000;
      const writes: Promise<void>[] = [];
      for (let i = 0; i < total; i++) {
        let state: Ticket["state"];
        if (i < 5) state = "in_progress";
        else if (i < 10) state = "review";
        else if (i < 30) state = "open";
        else if (i < 40) state = "draft";
        else if (i < 900) state = "done";
        else state = "dropped";

        const ticket = makeTicket({
          name: `Perf ticket ${i}`,
          state,
          review:
            state === "review"
              ? {
                  requested_at: NOW,
                  by: { name: "ryan", kind: "human" },
                  mr: `https://example.com/pr/${i}`,
                }
              : undefined,
        });
        writes.push(writeTicket(paths, ticket));
      }
      await Promise.all(writes);

      // The index must already be fresh+persisted BEFORE the timed run —
      // exactly what a real repo's index looks like after ordinary use
      // (any prior `slop` command would have triggered `loadIndex`'s
      // auto-heal already). Without this, the timed run's own first
      // `loadIndex` call would eat the one-time "parse all 1000 ticket
      // files" cost this work item exists to avoid paying on every call.
      await rebuildIndex(paths);

      const startedAt = performance.now();
      const result = status(paths.root);
      const elapsedMs = performance.now() - startedAt;

      expect(result.status, result.stderr).toBe(0);

      // Real measured number goes in this work item's report. Bounded
      // well under 1s so a loaded CI box doesn't flake, but still a real
      // bound — not a rubber stamp. `perfBudgetMs` scales this (via
      // SLOP_TEST_PERF_SCALE) for runs KNOWN to be racing other full-suite
      // runs on the same machine — see tests/support/perf-scale.ts's doc
      // for the concurrent-repro evidence that motivated this (t-ebgqb).
      // The default (scale 1) is this exact, unchanged 800ms, so CI and
      // solo local runs still enforce the real bound.
      expect(elapsedMs).toBeLessThan(perfBudgetMs(800));

      const lineCount = result.stdout.trim().split("\n").length;
      // Genuinely "one screen": nowhere near 1000 rows (one per ticket
      // would be 1000+ lines; this fixture's few in_progress/review
      // tickets plus ~10 count/section-header lines stays well under 50).
      expect(lineCount).toBeLessThan(50);

      expect(result.stdout).toMatch(/total\s+1000/);
    }, 30_000);

    it("the human view caps any one section, regardless of how many tickets qualify (the mechanism, not just fixture luck)", async () => {
      const paths = await makeScratchRepo("slop-d4-cap-");

      const total = 25;
      for (let i = 0; i < total; i++) {
        const ticket = makeTicket({
          name: `Review ticket ${i}`,
          state: "review",
          review: { requested_at: NOW, by: { name: "ryan", kind: "human" } },
        });
        await writeTicket(paths, ticket);
      }
      await rebuildIndex(paths);

      const result = status(paths.root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Awaiting review (25, longest-waiting first):");
      // STATUS_LIST_CAP (tickets/status.ts) = 10.
      expect(result.stdout).toContain("… and 15 more");
      const reviewLines = result.stdout
        .split("\n")
        .filter((line) => line.includes("(no MR link yet)"));
      expect(reviewLines).toHaveLength(10);

      const lineCount = result.stdout.trim().split("\n").length;
      expect(lineCount).toBeLessThan(50);
    });
  });

  // -------------------------------------------------------------------------
  // Counts by state
  // -------------------------------------------------------------------------

  describe("counts by state", () => {
    it("counts each state correctly across a mixed fixture, plus a total", async () => {
      const paths = await makeScratchRepo("slop-d4-counts-");
      const states: Array<[Ticket["state"], number]> = [
        ["draft", 2],
        ["open", 3],
        ["in_progress", 1],
        ["review", 1],
        ["done", 4],
        ["dropped", 1],
      ];
      for (const [state, count] of states) {
        for (let i = 0; i < count; i++) {
          const ticket = makeTicket({
            name: `${state} ticket ${i}`,
            state,
            review:
              state === "review"
                ? { requested_at: NOW, by: { name: "ryan", kind: "human" } }
                : undefined,
          });
          await writeTicket(paths, ticket);
        }
      }
      await rebuildIndex(paths);

      const human = status(paths.root);
      expect(human.status, human.stderr).toBe(0);
      expect(human.stdout).toMatch(/draft\s+2/);
      expect(human.stdout).toMatch(/open\s+3/);
      expect(human.stdout).toMatch(/in_progress\s+1/);
      expect(human.stdout).toMatch(/review\s+1/);
      expect(human.stdout).toMatch(/done\s+4/);
      expect(human.stdout).toMatch(/dropped\s+1/);
      expect(human.stdout).toMatch(/total\s+12/);

      const json = statusJson(paths.root);
      expect(json.counts).toEqual({
        draft: 2,
        open: 3,
        in_progress: 1,
        review: 1,
        done: 4,
        dropped: 1,
        total: 12,
      });
    });
  });

  // -------------------------------------------------------------------------
  // In-progress with sessions + age
  // -------------------------------------------------------------------------

  describe("in-progress tickets with sessions and age", () => {
    it("shows the active session's actor + harness and a deterministic humanised age, sorted oldest-session-first", async () => {
      const paths = await makeScratchRepo("slop-d4-inprogress-");

      const olderId = newTicketId();
      const olderSession = makeSession({
        ticket: olderId,
        actor: { name: "ryan", kind: "human" },
        harness: { kind: "claude-code", session_id: null },
        started_at: "2026-07-23T08:00:00.000Z", // 2h before FAKE_NOW
      });
      const olderTicket = makeTicket({
        id: olderId,
        name: "Auth provider work",
        state: "in_progress",
        active_session: olderSession.id,
      });

      const newerId = newTicketId();
      const newerSession = makeSession({
        ticket: newerId,
        actor: { name: "maria", kind: "agent" },
        harness: { kind: "opencode", session_id: null },
        started_at: "2026-07-23T09:45:00.000Z", // 15m before FAKE_NOW
      });
      const newerTicket = makeTicket({
        id: newerId,
        name: "Flaky test fix",
        state: "in_progress",
        active_session: newerSession.id,
      });

      await writeTicket(paths, olderTicket);
      await writeSession(paths, olderSession);
      await writeTicket(paths, newerTicket);
      await writeSession(paths, newerSession);
      await rebuildIndex(paths);

      const fakeNow = { SLOP_FAKE_NOW: "2026-07-23T10:00:00.000Z" };

      const human = status(paths.root, [], fakeNow);
      expect(human.status, human.stderr).toBe(0);
      expect(human.stdout).toContain("In progress (2, oldest session first):");
      expect(human.stdout).toContain("ryan (claude-code)");
      expect(human.stdout).toContain("2h");
      expect(human.stdout).toContain("maria (opencode)");
      expect(human.stdout).toContain("15m");
      // Oldest (2h) session must be listed before the newer (15m) one.
      expect(human.stdout.indexOf(olderTicket.slug)).toBeLessThan(
        human.stdout.indexOf(newerTicket.slug),
      );

      const json = statusJson(paths.root, fakeNow);
      expect(json.in_progress).toHaveLength(2);
      expect(json.in_progress.map((r) => r.id)).toEqual([olderTicket.id, newerTicket.id]);
      expect(json.in_progress[0]?.session).toMatchObject({
        actor: "ryan",
        harness: "claude-code",
        started_at: olderSession.started_at,
        age_ms: 2 * 3_600_000,
        age_human: "2h",
      });
      expect(json.in_progress[1]?.session).toMatchObject({
        actor: "maria",
        harness: "opencode",
        age_ms: 15 * 60_000,
        age_human: "15m",
      });
    });

    it("an in_progress ticket with no active_session on file still renders, without crashing", async () => {
      const paths = await makeScratchRepo("slop-d4-inprogress-nosession-");
      const ticket = makeTicket({ name: "Orphaned in-progress ticket", state: "in_progress" });
      await writeTicket(paths, ticket);
      await rebuildIndex(paths);

      const human = status(paths.root);
      expect(human.status, human.stderr).toBe(0);
      expect(human.stdout).toContain("(no active session on file)");

      const json = statusJson(paths.root);
      expect(json.in_progress).toHaveLength(1);
      expect(json.in_progress[0]?.session).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Awaiting review with MR links
  // -------------------------------------------------------------------------

  describe("awaiting review with MR links", () => {
    it("lists review-state tickets with their MR link and a deterministic wait age, sorted longest-waiting-first", async () => {
      const paths = await makeScratchRepo("slop-d4-review-");

      const withMr = makeTicket({
        name: "Payment refactor",
        state: "review",
        review: {
          requested_at: "2026-07-22T10:00:00.000Z", // 24h (1d) before FAKE_NOW
          by: { name: "ryan", kind: "human" },
          mr: "https://github.com/example/repo/pull/42",
        },
      });
      const withoutMr = makeTicket({
        name: "Docs pass",
        state: "review",
        review: {
          requested_at: "2026-07-23T09:00:00.000Z", // 1h before FAKE_NOW
          by: { name: "maria", kind: "agent" },
        },
      });

      await writeTicket(paths, withMr);
      await writeTicket(paths, withoutMr);
      await rebuildIndex(paths);

      const fakeNow = { SLOP_FAKE_NOW: "2026-07-23T10:00:00.000Z" };

      const human = status(paths.root, [], fakeNow);
      expect(human.status, human.stderr).toBe(0);
      expect(human.stdout).toContain("Awaiting review (2, longest-waiting first):");
      expect(human.stdout).toContain("https://github.com/example/repo/pull/42");
      expect(human.stdout).toContain("(no MR link yet)");
      expect(human.stdout).toContain("1d");
      expect(human.stdout).toContain("1h");
      // Longest-waiting (1d) must be listed before the shorter wait (1h).
      expect(human.stdout.indexOf(withMr.slug)).toBeLessThan(human.stdout.indexOf(withoutMr.slug));

      const json = statusJson(paths.root, fakeNow);
      expect(json.review).toHaveLength(2);
      expect(json.review.map((r) => r.id)).toEqual([withMr.id, withoutMr.id]);
      expect(json.review[0]).toMatchObject({
        mr: "https://github.com/example/repo/pull/42",
        by: "ryan",
        age_ms: 24 * 3_600_000,
        age_human: "1d",
      });
      expect(json.review[1]).toMatchObject({
        mr: null,
        by: "maria",
        age_ms: 3_600_000,
        age_human: "1h",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Derived blocked/stale overlays: graceful pre-B4 degrade for `blocked`
  // (still nullable); `stale` (C5) is ALWAYS live-computed — see
  // tests/acceptance/C5.test.ts for the full clock-injected staleness
  // acceptance coverage. This describe block keeps only what's still D4's
  // own concern: rendering, once populated/computed.
  // -------------------------------------------------------------------------

  describe("derived blocked/stale overlays", () => {
    it("blocked degrades gracefully (never crash) when the index's blocked_count is still null (pre-B4)", async () => {
      const paths = await makeScratchRepo("slop-d4-derived-null-");
      await writeTicket(paths, makeTicket({ name: "Some open ticket", state: "open" }));

      // Force blocked_count back to null regardless of how far B4 has
      // actually landed in this checkout — same fingerprint-preserving
      // hand-mutation technique as the "once populated" test below.
      const index: DbIndex = await buildIndex(paths);
      const mutated: DbIndex = {
        ...index,
        tickets: index.tickets.map((row) => ({ ...row, blocked_count: null, ready: null })),
      };
      await writeIndex(paths, mutated);

      const human = status(paths.root);
      expect(human.status, human.stderr).toBe(0);
      expect(human.stdout).toMatch(/blocked\s+—\s+\(not yet computed — B4\)/);
      // stale (C5) is always live-computed — no "not yet computed" state.
      expect(human.stdout).toContain("Stale (0):");

      const json = statusJson(paths.root);
      expect(json.derived.blocked).toBeNull();
      expect(json.derived.stale).toBe(0);
      expect(json.stale).toEqual([]);
    });

    it("renders real blocked counts (B4) and real, live-computed stale counts/listing (C5) from a real fixture + SLOP_FAKE_NOW", async () => {
      const paths = await makeScratchRepo("slop-d4-derived-populated-");
      // Stale threshold in this fixture's config.yaml is 60m — see CONFIG_YAML.
      const staleInProgress = makeTicket({
        name: "Stuck ticket",
        state: "in_progress",
        last_activity_at: "2026-07-23T08:00:00.000Z", // 2h before FAKE_NOW — past the 60m deadline
      });
      const freshInProgress = makeTicket({
        name: "Fresh ticket",
        state: "in_progress",
        last_activity_at: "2026-07-23T09:50:00.000Z", // 10m before FAKE_NOW — under the 60m deadline
      });
      const blockedOpen = makeTicket({ name: "Blocked ticket", state: "open" });
      const blocker = makeTicket({ name: "Blocker", state: "open", blocks: [blockedOpen.id] });
      await writeTicket(paths, staleInProgress);
      await writeTicket(paths, freshInProgress);
      await writeTicket(paths, blockedOpen);
      await writeTicket(paths, blocker);
      await rebuildIndex(paths);

      const fakeNow = { SLOP_FAKE_NOW: "2026-07-23T10:00:00.000Z" };

      const human = status(paths.root, [], fakeNow);
      expect(human.status, human.stderr).toBe(0);
      expect(human.stdout).toMatch(/blocked\s+1(?!\d)/);
      expect(human.stdout).toMatch(/stale\s+1(?!\d)/);
      expect(human.stdout).toContain("Stale (1):");
      expect(human.stdout).toContain(staleInProgress.slug);
      expect(human.stdout).not.toContain(
        `${freshInProgress.slug}  ${freshInProgress.id}  in_progress`,
      );

      const json = statusJson(paths.root, fakeNow);
      expect(json.derived).toEqual({ blocked: 1, stale: 1 });
      expect(json.stale).toEqual([
        {
          id: staleInProgress.id,
          slug: staleInProgress.slug,
          handle: shortTicketCode(staleInProgress.id),
          name: staleInProgress.name,
          state: "in_progress",
        },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // --json shape
  // -------------------------------------------------------------------------

  describe("--json", () => {
    it("has the documented stable shape", async () => {
      const paths = await makeScratchRepo("slop-d4-json-shape-");
      await writeTicket(paths, makeTicket({ name: "Just one ticket", state: "open" }));
      await rebuildIndex(paths);

      const json = statusJson(paths.root);
      expect(typeof json.generated_at).toBe("string");
      expect(json.counts).toEqual({
        draft: 0,
        open: 1,
        in_progress: 0,
        review: 0,
        done: 0,
        dropped: 0,
        total: 1,
      });
      // blocked (B4) stays nullable (pinned precisely by the "derived
      // blocked/stale overlays" tests above); stale (C5) is always a
      // real number now — never null.
      expect(json.derived.blocked === null || typeof json.derived.blocked === "number").toBe(true);
      expect(typeof json.derived.stale).toBe("number");
      expect(json.in_progress).toEqual([]);
      expect(json.review).toEqual([]);
      expect(Array.isArray(json.stale)).toBe(true);
      expect(json.problems).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Empty repo
  // -------------------------------------------------------------------------

  describe("empty repo", () => {
    it('prints a clean "no tickets yet" message and exits 0', async () => {
      const paths = await makeScratchRepo("slop-d4-empty-");
      const result = status(paths.root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.toLowerCase()).toContain("no tickets yet");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
    });

    it("--json on an empty repo returns a valid, all-zero shape (not the human message)", async () => {
      const paths = await makeScratchRepo("slop-d4-empty-json-");
      const json = statusJson(paths.root);
      expect(json.counts.total).toBe(0);
      expect(json.derived).toEqual({ blocked: null, stale: 0 });
      expect(json.in_progress).toEqual([]);
      expect(json.review).toEqual([]);
      expect(json.stale).toEqual([]);
    });
  });
});
