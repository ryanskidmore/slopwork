import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/core/clock.js";
import { newSessionId, newTicketId, shortTicketCode, ticketSchema } from "../../src/core/index.js";
import type { Ticket } from "../../src/core/index.js";
import type { DbIndex, RepoPaths } from "../../src/repo/index.js";
import {
  buildIndex,
  createEntityFileCanonical,
  ensureDbDirs,
  rebuildIndex,
  ticketFilePath,
} from "../../src/repo/index.js";

// C5: Staleness
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "Clock-injected tests; stale review ticket surfaces with MR link"
//
// Fixtures are built via the repo layer DIRECTLY (`ensureDbDirs` + a
// hand-written config.yaml + `createEntityFileCanonical` straight onto
// ticket files) — matching D4.test.ts's own convention for review-state
// tickets (`review --mr` is C3, not built yet, so this is the only way to
// get one), and reused here for in_progress fixtures too so every
// timestamp (last_activity_at / review.requested_at) is exactly
// controlled. `status` and `ready --resumable` themselves are always
// driven as a real CLI (spawned `dist/slop`), with the shared
// `SLOP_FAKE_NOW` clock override (G5, t-uy8vo) pinning "now" for
// deterministic assertions — this IS the "clock-injected tests" the
// criterion names.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
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

// design.md §3's documented defaults — matching B4.test.ts/D4.test.ts's
// own fixture config.yaml.
const CONFIG_YAML = [
  "project: c5-fixture",
  "user: c5-tester",
  "defaults:",
  "  stale_after: 60m",
  "  review_stale_after: 24h",
  "",
].join("\n");

async function makeScratchRepo(prefix: string): Promise<RepoPaths> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  const paths = await ensureDbDirs(dir);
  writeFileSync(join(dir, ".slop", "config.yaml"), CONFIG_YAML, "utf8");
  return paths;
}

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

function status(dir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return runSlop(["status", "--json"], dir, extraEnv);
}

function ready(dir: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return runSlop(["ready", "--json", ...args], dir, extraEnv);
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
  derived: { blocked: number | null; stale: number };
  review: StatusJsonReview[];
  stale: StatusJsonStale[];
}

function statusJson(dir: string, extraEnv: NodeJS.ProcessEnv = {}): StatusJsonOutput {
  const result = status(dir, extraEnv);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as StatusJsonOutput;
}

interface ReadyJsonRow {
  id: string;
  slug: string;
  name: string;
  state: string;
  priority: number;
  labels: string[];
  why: string;
  mr?: string | null;
}

interface ReadyJsonOutput {
  ready: ReadyJsonRow[];
  resumable_requested: boolean;
  resumable: ReadyJsonRow[];
}

function readyJson(dir: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): ReadyJsonOutput {
  const result = ready(dir, args, extraEnv);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ReadyJsonOutput;
}

// ---------------------------------------------------------------------------
// Entity builders — direct repo-layer writes (see module doc).
// ---------------------------------------------------------------------------

const BASE_TIME = "2026-07-23T10:00:00.000Z";
let ticketCounter = 0;

function slugFor(name: string): string {
  ticketCounter += 1;
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${ticketCounter}`;
}

function makeTicket(overrides: Partial<Ticket> & { name: string; state: Ticket["state"] }): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    slug: slugFor(overrides.name),
    spec: { summary: "s" },
    priority: 2,
    root_id: id,
    active_session: null,
    provenance: { method: "new", created_by: { name: "fixture", kind: "agent" } },
    last_activity_at: BASE_TIME,
    created_at: BASE_TIME,
    updated_at: BASE_TIME,
    ...overrides,
  });
}

async function writeTicket(paths: RepoPaths, ticket: Ticket): Promise<void> {
  await createEntityFileCanonical(ticketFilePath(paths, ticket.id), ticket);
}

// ---------------------------------------------------------------------------

describe("C5: Staleness", () => {
  // -------------------------------------------------------------------------
  // "Clock-injected tests"
  // -------------------------------------------------------------------------

  describe('"Clock-injected tests"', () => {
    it('PROOF the index stores a stable DEADLINE, not a live boolean: rebuilding at two different "now"s leaves stale_at unchanged — only the read-time boolean, computed separately, differs', async () => {
      const paths = await makeScratchRepo("slop-c5-stable-deadline-");
      const t = makeTicket({
        name: "in progress ticket",
        state: "in_progress",
        last_activity_at: "2026-07-23T10:00:00.000Z",
      });
      await writeTicket(paths, t);

      // Two builds of the SAME on-disk ticket content, at two very
      // different "now"s (one well before the deadline, one well after).
      const earlyIndex: DbIndex = await buildIndex(
        paths,
        fixedClock(new Date("2026-07-23T10:05:00.000Z")),
      );
      const lateIndex: DbIndex = await buildIndex(
        paths,
        fixedClock(new Date("2026-08-01T00:00:00.000Z")),
      );

      const earlyRow = earlyIndex.tickets.find((r) => r.id === t.id);
      const lateRow = lateIndex.tickets.find((r) => r.id === t.id);

      // The clock the index was BUILT with never moves the stored
      // deadline — only ticket content (last_activity_at) + config do.
      expect(earlyRow?.stale_at).toBe("2026-07-23T11:00:00.000Z"); // +60m, this fixture's stale_after
      expect(lateRow?.stale_at).toBe(earlyRow?.stale_at);
      // built_at is the only thing that legitimately differs between the two.
      expect(earlyIndex.built_at).not.toBe(lateIndex.built_at);
    });

    describe("in_progress: stale_after boundary, via `status --json` + SLOP_FAKE_NOW", () => {
      it("NOT stale 1 second before the deadline", async () => {
        const paths = await makeScratchRepo("slop-c5-inprogress-before-");
        const t = makeTicket({
          name: "boundary ticket",
          state: "in_progress",
          last_activity_at: "2026-07-23T10:00:00.000Z", // deadline = 11:00:00 (+60m)
        });
        await writeTicket(paths, t);
        await rebuildIndex(paths);

        const json = statusJson(paths.root, { SLOP_FAKE_NOW: "2026-07-23T10:59:59.000Z" });
        expect(json.derived.stale).toBe(0);
        expect(json.stale).toEqual([]);
      });

      it("STALE 1 second after the deadline", async () => {
        const paths = await makeScratchRepo("slop-c5-inprogress-after-");
        const t = makeTicket({
          name: "boundary ticket",
          state: "in_progress",
          last_activity_at: "2026-07-23T10:00:00.000Z",
        });
        await writeTicket(paths, t);
        await rebuildIndex(paths);

        const json = statusJson(paths.root, { SLOP_FAKE_NOW: "2026-07-23T11:00:01.000Z" });
        expect(json.derived.stale).toBe(1);
        expect(json.stale).toEqual([
          {
            id: t.id,
            slug: t.slug,
            handle: shortTicketCode(t.id),
            name: t.name,
            state: "in_progress",
          },
        ]);
      });
    });

    describe("review: review_stale_after boundary, via `status --json` + SLOP_FAKE_NOW", () => {
      it("NOT review-stale 1 second before the deadline", async () => {
        const paths = await makeScratchRepo("slop-c5-review-before-");
        const t = makeTicket({
          name: "boundary review ticket",
          state: "review",
          review: {
            requested_at: "2026-07-22T10:00:00.000Z", // deadline = 2026-07-23T10:00:00 (+24h)
            by: { name: "ryan", kind: "human" },
            mr: "https://example.com/pr/1",
          },
        });
        await writeTicket(paths, t);
        await rebuildIndex(paths);

        const json = statusJson(paths.root, { SLOP_FAKE_NOW: "2026-07-23T09:59:59.000Z" });
        expect(json.derived.stale).toBe(0);
        expect(json.review[0]?.review_stale).toBe(false);
      });

      it("review-STALE 1 second after the deadline", async () => {
        const paths = await makeScratchRepo("slop-c5-review-after-");
        const t = makeTicket({
          name: "boundary review ticket",
          state: "review",
          review: {
            requested_at: "2026-07-22T10:00:00.000Z",
            by: { name: "ryan", kind: "human" },
            mr: "https://example.com/pr/1",
          },
        });
        await writeTicket(paths, t);
        await rebuildIndex(paths);

        const json = statusJson(paths.root, { SLOP_FAKE_NOW: "2026-07-23T10:00:01.000Z" });
        expect(json.derived.stale).toBe(1);
        expect(json.review[0]?.review_stale).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // "stale review ticket surfaces with MR link"
  // -------------------------------------------------------------------------

  describe('"stale review ticket surfaces with MR link"', () => {
    const STALE_MR = "https://github.com/example/repo/pull/42";
    const FRESH_MR = "https://github.com/example/repo/pull/43";

    async function makeReviewFixture(paths: RepoPaths) {
      const staleReview = makeTicket({
        name: "Payment refactor",
        state: "review",
        review: {
          requested_at: "2026-07-20T10:00:00.000Z", // days old — well past 24h
          by: { name: "ryan", kind: "human" },
          mr: STALE_MR,
        },
      });
      const freshReview = makeTicket({
        name: "Docs pass",
        state: "review",
        review: {
          requested_at: "2026-07-23T11:00:00.000Z", // 1h old — well under 24h
          by: { name: "maria", kind: "agent" },
          mr: FRESH_MR,
        },
      });
      await writeTicket(paths, staleReview);
      await writeTicket(paths, freshReview);
      await rebuildIndex(paths);
      return { staleReview, freshReview };
    }

    const FAKE_NOW = { SLOP_FAKE_NOW: "2026-07-23T12:00:00.000Z" };
    const FAKE_NOW_READY = { SLOP_FAKE_NOW: "2026-07-23T12:00:00.000Z" };

    it("`status --json`: the stale review ticket is marked review_stale AND still carries its mr link; the fresh one does not surface as stale", async () => {
      const paths = await makeScratchRepo("slop-c5-status-review-");
      const { staleReview, freshReview } = await makeReviewFixture(paths);

      const json = statusJson(paths.root, FAKE_NOW);

      const staleRow = json.review.find((r) => r.id === staleReview.id);
      expect(staleRow).toMatchObject({ mr: STALE_MR, review_stale: true });

      const freshRow = json.review.find((r) => r.id === freshReview.id);
      expect(freshRow).toMatchObject({ mr: FRESH_MR, review_stale: false });

      // The "Stale" listing itself also names the stale review ticket, and
      // ONLY the stale one.
      expect(json.stale.map((r) => r.id)).toEqual([staleReview.id]);
      expect(json.stale[0]).toMatchObject({ state: "review" });
    });

    it("`status` human output: shows the MR link AND a [STALE] marker together for the stale review ticket", async () => {
      const paths = await makeScratchRepo("slop-c5-status-human-");
      const { staleReview, freshReview } = await makeReviewFixture(paths);

      const result = runSlop(["status"], paths.root, FAKE_NOW);
      expect(result.status, result.stderr).toBe(0);

      const staleLine = result.stdout.split("\n").find((l) => l.includes(staleReview.slug));
      expect(staleLine).toBeDefined();
      expect(staleLine).toContain(STALE_MR);
      expect(staleLine).toContain("[STALE]");

      const freshLine = result.stdout.split("\n").find((l) => l.includes(freshReview.slug));
      expect(freshLine).toBeDefined();
      expect(freshLine).toContain(FRESH_MR);
      expect(freshLine).not.toContain("[STALE]");
    });

    it("`ready --resumable --json`: the stale review ticket (no active session) appears with its mr link", async () => {
      const paths = await makeScratchRepo("slop-c5-ready-review-");
      const { staleReview } = await makeReviewFixture(paths);

      const json = readyJson(paths.root, ["--resumable"], FAKE_NOW_READY);
      const row = json.resumable.find((r) => r.id === staleReview.id);
      expect(row).toBeDefined();
      expect(row?.mr).toBe(STALE_MR);
      expect(row?.state).toBe("review");
    });

    it("`ready --resumable` text output: shows the mr link for the stale review ticket", async () => {
      const paths = await makeScratchRepo("slop-c5-ready-review-text-");
      const { staleReview } = await makeReviewFixture(paths);

      const result = runSlop(["ready", "--resumable"], paths.root, FAKE_NOW_READY);
      expect(result.status, result.stderr).toBe(0);
      const line = result.stdout.split("\n").find((l) => l.includes(staleReview.slug));
      expect(line).toBeDefined();
      expect(line).toContain(STALE_MR);
    });
  });

  // -------------------------------------------------------------------------
  // Staleness feeds `ready --resumable`'s WIDENED predicate: a ticket that
  // still has an active session is only resumable once it's genuinely
  // stale (the documented rule — src/tickets/ready.ts's module doc).
  // -------------------------------------------------------------------------

  describe("ready --resumable widened by staleness (active-session tickets)", () => {
    const FAKE_NOW_READY = { SLOP_FAKE_NOW: "2026-07-23T12:00:00.000Z" };

    it("in_progress WITH an active session: excluded while fresh, included once stale, with reason in_progress_stale", async () => {
      const paths = await makeScratchRepo("slop-c5-resumable-inprogress-session-");
      const stale = makeTicket({
        name: "vanished agent",
        state: "in_progress",
        active_session: newSessionId(),
        last_activity_at: "2026-07-23T10:00:00.000Z", // deadline 11:00 — past by FAKE_NOW (12:00)
      });
      const fresh = makeTicket({
        name: "actively worked",
        state: "in_progress",
        active_session: newSessionId(),
        last_activity_at: "2026-07-23T11:55:00.000Z", // deadline 12:55 — not yet past
      });
      await writeTicket(paths, stale);
      await writeTicket(paths, fresh);
      await rebuildIndex(paths);

      const json = readyJson(paths.root, ["--resumable"], FAKE_NOW_READY);
      const ids = json.resumable.map((r) => r.id);
      expect(ids).toContain(stale.id);
      expect(ids).not.toContain(fresh.id);

      const staleRow = json.resumable.find((r) => r.id === stale.id);
      expect(staleRow?.why).toMatch(/stale/);
    });

    it("review WITH an active session: excluded while fresh, included (with mr link) once review-stale", async () => {
      const paths = await makeScratchRepo("slop-c5-resumable-review-session-");
      const mr = "https://github.com/example/repo/pull/99";
      const stale = makeTicket({
        name: "unwatched MR",
        state: "review",
        active_session: newSessionId(),
        review: {
          requested_at: "2026-07-20T10:00:00.000Z",
          by: { name: "ryan", kind: "human" },
          mr,
        },
      });
      const fresh = makeTicket({
        name: "actively watched MR",
        state: "review",
        active_session: newSessionId(),
        review: { requested_at: "2026-07-23T11:55:00.000Z", by: { name: "ryan", kind: "human" } },
      });
      await writeTicket(paths, stale);
      await writeTicket(paths, fresh);
      await rebuildIndex(paths);

      const json = readyJson(paths.root, ["--resumable"], FAKE_NOW_READY);
      const ids = json.resumable.map((r) => r.id);
      expect(ids).toContain(stale.id);
      expect(ids).not.toContain(fresh.id);

      const staleRow = json.resumable.find((r) => r.id === stale.id);
      expect(staleRow?.mr).toBe(mr);
      expect(staleRow?.why).toMatch(/stale/);
    });

    it("without --resumable, staleness never leaks into the strict `ready` set", async () => {
      const paths = await makeScratchRepo("slop-c5-ready-strict-");
      const staleInProgress = makeTicket({
        name: "stale in progress",
        state: "in_progress",
        last_activity_at: "2026-07-23T10:00:00.000Z",
      });
      await writeTicket(paths, staleInProgress);
      await rebuildIndex(paths);

      const json = readyJson(paths.root, [], FAKE_NOW_READY);
      expect(json.ready).toEqual([]);
      expect(json.resumable_requested).toBe(false);
      expect(json.resumable).toEqual([]);
    });
  });
});
