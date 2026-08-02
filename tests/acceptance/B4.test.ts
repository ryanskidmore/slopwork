import { type SpawnSyncReturns, execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/core/clock.js";
import { type Ticket, newTicketId, ticketSchema } from "../../src/core/index.js";
import type { EventContext, MutationEventSpec, RepoPaths } from "../../src/repo/index.js";
import {
  buildIndex,
  createTicket,
  ensureDbDirs,
  listEvents,
  readTicket,
  updateTicket,
} from "../../src/repo/index.js";
import { FlatfileBackend } from "../../src/storage/flatfile.js";
import { cascadeOnClose } from "../../src/tickets/cascade.js";
import { TICKET_FIELDS, diffTicketPatch } from "../../src/tickets/patch.js";

// B4: Derivations
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "Cascade test: close 1, verify N flip + events; ready ordering =
//   priority then age"
//
// Two very different surfaces are exercised here, per the B4 brief:
//   - The done-cascade (`src/tickets/cascade.ts`) is tested at the
//     function level, directly against the repo layer (fixtures built via
//     `ensureDbDirs` + `createTicket`/`updateTicket`, exactly like
//     tests/acceptance/B3.test.ts's degree-cap fixtures) — `done`/`drop`
//     (C3) don't exist yet, so "closing" a ticket means writing its
//     terminal state directly, which is `cascadeOnClose`'s own documented
//     precondition. Every cascade call here runs under a REAL
//     `.slop/db/.lock` acquisition (`FlatfileBackend.transact`) for genuine
//     end-to-end coverage of the locking contract.
//   - `slop ready` itself (ordering, --label, --resumable, --json,
//     --budget, empty-result exit code) is driven as a real CLI: spawning
//     the compiled `dist/slop` binary, per this project's convention for
//     anything that must be exercised as a genuine process (B1.test.ts,
//     B3.test.ts, C1.test.ts, D2.test.ts, ...). Fixtures for these use
//     `slop init --yes` + `slop new` (+ `slop start` where a genuine
//     active session is needed) — the real end-to-end path an agent
//     driving `slop ready` hits, including index auto-heal.

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
// Shared fixture/spawn helpers
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function runSlop(args: string[], cwd: string, input?: string): SpawnSyncReturns<string> {
  return spawnSync(binaryPath, args, {
    cwd,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      OPENCODE: undefined,
      CODEX_SANDBOX: undefined,
      CODEX_SANDBOX_NETWORK_DISABLED: undefined,
    },
  });
}

/** A repo built via `slop init --yes` — the real end-to-end path for
 * everything `slop ready` itself is tested through below. */
async function makeCliFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "slop-b4-cli-"));
  scratchDirs.push(root);
  const init = runSlop(["init", "--yes", "--project", "b4-fixture", "--user", "ryan"], root);
  expect(init.status, init.stderr).toBe(0);
  return root;
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

function parseCreatedOutput(stdout: string): { id: string; slug: string } {
  const m = CREATED_LINE.exec(stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(`could not parse "created <id> (slug: <slug>)" out of stdout:\n${stdout}`);
  }
  return { id: m[1], slug: m[2] };
}

function newTicketCli(
  root: string,
  name: string,
  extraArgs: string[] = [],
): { id: string; slug: string } {
  const result = runSlop(["new", name, ...extraArgs], root);
  expect(result.status, result.stderr).toBe(0);
  return parseCreatedOutput(result.stdout);
}

function readyCli(root: string, extraArgs: string[] = []): SpawnSyncReturns<string> {
  return runSlop(["ready", ...extraArgs], root);
}

interface ReadyJsonRow {
  id: string;
  slug: string;
  name: string;
  state: string;
  priority: number;
  labels: string[];
  why: string;
}

interface ReadyJsonOutput {
  ready: ReadyJsonRow[];
  resumable_requested: boolean;
  resumable: ReadyJsonRow[];
  elided: string[];
  hint: string | null;
}

function readyJson(root: string, extraArgs: string[] = []): ReadyJsonOutput {
  const result = readyCli(root, ["--json", ...extraArgs]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ReadyJsonOutput;
}

// ---------------------------------------------------------------------------
// Repo-layer fixture helpers (for the cascade + state-manipulation tests)
// ---------------------------------------------------------------------------

interface RepoFixture {
  root: string;
  paths: RepoPaths;
  backend: FlatfileBackend;
}

async function makeRepoFixture(): Promise<RepoFixture> {
  const root = await mkdtemp(join(tmpdir(), "slop-b4-repo-"));
  scratchDirs.push(root);
  const paths = await ensureDbDirs(root);
  const lines = [
    "project: b4-fixture",
    "user: ryan",
    "remotes:",
    "defaults:",
    "  stale_after: 60m",
    "  review_stale_after: 24h",
  ];
  await writeFile(join(paths.slopDir, "config.yaml"), `${lines.join("\n")}\n`, "utf8");
  return { root, paths, backend: new FlatfileBackend(paths) };
}

const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };
const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "Ticket",
    slug: `ticket-${id.slice(-10).toLowerCase()}`,
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

/** Directly flips a ticket's state to `done`/`dropped` via the repo layer
 * — `cascadeOnClose`'s documented precondition, reproduced here without
 * going through `done`/`drop` (C3, not yet implemented). Per the B4
 * brief: "Build fixtures via the repo layer." */
async function closeTicket(
  paths: RepoPaths,
  id: Ticket["id"],
  toState: "done" | "dropped",
): Promise<void> {
  const before = await readTicket(paths, id);
  const after: Ticket = { ...before, state: toState, active_session: null };
  await updateTicket(paths, id, diffTicketPatch(before, after, TICKET_FIELDS), after, ctx, {
    verb: toState === "done" ? "ticket.done" : "ticket.dropped",
  });
}

// ---------------------------------------------------------------------------

describe("B4: Derivations", () => {
  // -------------------------------------------------------------------------
  // Clause 1: "Cascade test: close 1, verify N flip + events"
  // -------------------------------------------------------------------------

  describe('"Cascade test: close 1, verify N flip + events"', () => {
    it("closing a ticket that fans out to N blockees flips exactly those N to unblocked, with exactly N ticket.ready events", async () => {
      const { paths, backend } = await makeRepoFixture();
      const a = makeTicket();
      const b = makeTicket();
      const c = makeTicket();
      const closer = makeTicket({ blocks: [a.id, b.id, c.id] });
      for (const t of [a, b, c, closer]) await createTicket(paths, t, ctx, createdEvent);

      await closeTicket(paths, closer.id, "done");
      const result = await backend.transact((tx) =>
        cascadeOnClose(backend, tx, closer.id, ctx, clock),
      );

      expect(result.unblocked.slice().sort()).toEqual([a.id, b.id, c.id].sort());
      expect(result.events).toHaveLength(3);
      for (const event of result.events) {
        expect(event.verb).toBe("ticket.ready");
        expect(event.entity.kind).toBe("ticket");
        expect(event.payload).toEqual({ unblocked_by: closer.id });
      }
      expect(result.events.map((e) => e.entity.id).sort()).toEqual([a.id, b.id, c.id].sort());
    });

    it("a fan-out WITH a diamond: only the tickets with no OTHER live blocker flip; the diamond and a wrong-state blockee do not; the index reflects it; ticket.ready fires only for the right subset", async () => {
      const { paths, backend } = await makeRepoFixture();

      // Plain fan-out members — each blocked ONLY by `closer`.
      const plainA = makeTicket();
      const plainB = makeTicket();

      // Diamond: blocked by BOTH `closer` and `otherBlocker` (still live) —
      // closing `closer` alone must NOT unblock it. A naive
      // "decrement-and-flip-at-zero" implementation gets this wrong.
      const diamond = makeTicket();
      const otherBlocker = makeTicket({ blocks: [diamond.id] });

      // A blockee that is NOT open — its blocked_count legitimately drops
      // to 0, but it must still never be reported "unblocked" or get a
      // ticket.ready event, because it isn't a `ready` candidate at all
      // (design.md §2: ready requires state === open).
      const inProgressBlockee = makeTicket({ state: "in_progress" });

      const closer = makeTicket({
        blocks: [plainA.id, plainB.id, diamond.id, inProgressBlockee.id],
      });

      for (const t of [plainA, plainB, diamond, otherBlocker, inProgressBlockee, closer]) {
        await createTicket(paths, t, ctx, createdEvent);
      }

      await closeTicket(paths, closer.id, "done");
      const result = await backend.transact((tx) =>
        cascadeOnClose(backend, tx, closer.id, ctx, clock),
      );

      // --- exactly the right subset flips ---
      expect(result.unblocked.slice().sort()).toEqual([plainA.id, plainB.id].sort());

      // --- events: one ticket.ready per flipped ticket, none for the rest ---
      expect(result.events).toHaveLength(2);
      const readyEventTicketIds = result.events.map((e) => e.entity.id).sort();
      expect(readyEventTicketIds).toEqual([plainA.id, plainB.id].sort());
      expect(readyEventTicketIds).not.toContain(diamond.id);
      expect(readyEventTicketIds).not.toContain(inProgressBlockee.id);

      // --- cross-check against the FULL event log on disk, not just the
      // return value, so a bug that emitted an extra untracked event would
      // still be caught. ---
      const allEvents = await listEvents(paths);
      const allReadyEvents = allEvents.filter((e) => e.verb === "ticket.ready");
      expect(allReadyEvents).toHaveLength(2);
      expect(allReadyEvents.map((e) => e.entity.id).sort()).toEqual([plainA.id, plainB.id].sort());

      // --- the index reflects the new blocked_counts ---
      const index = await buildIndex(paths, clock);
      const rowFor = (id: string) => index.tickets.find((r) => r.id === id);

      expect(rowFor(plainA.id)?.blocked_count).toBe(0);
      expect(rowFor(plainA.id)?.ready).toBe(true);
      expect(rowFor(plainB.id)?.blocked_count).toBe(0);
      expect(rowFor(plainB.id)?.ready).toBe(true);

      // The diamond still has `otherBlocker` live: blocked_count 1, NOT ready.
      expect(rowFor(diamond.id)?.blocked_count).toBe(1);
      expect(rowFor(diamond.id)?.ready).toBe(false);

      // in_progress blockee: blocked_count 0 now (closer AND, well, only
      // closer blocked it), but never "ready" — wrong state.
      expect(rowFor(inProgressBlockee.id)?.blocked_count).toBe(0);
      expect(rowFor(inProgressBlockee.id)?.ready).toBe(false);
    });

    it("a diamond becomes unblocked once its LAST live blocker closes (two separate cascades)", async () => {
      const { paths, backend } = await makeRepoFixture();
      const target = makeTicket();
      const first = makeTicket({ blocks: [target.id] });
      const second = makeTicket({ blocks: [target.id] });
      for (const t of [target, first, second]) await createTicket(paths, t, ctx, createdEvent);

      await closeTicket(paths, first.id, "done");
      const afterFirst = await backend.transact((tx) =>
        cascadeOnClose(backend, tx, first.id, ctx, clock),
      );
      expect(afterFirst.unblocked).toEqual([]);
      expect(afterFirst.events).toEqual([]);

      await closeTicket(paths, second.id, "done");
      const afterSecond = await backend.transact((tx) =>
        cascadeOnClose(backend, tx, second.id, ctx, clock),
      );
      expect(afterSecond.unblocked).toEqual([target.id]);
      expect(afterSecond.events).toHaveLength(1);
      expect(afterSecond.events[0]?.verb).toBe("ticket.ready");
      expect(afterSecond.events[0]?.payload).toEqual({ unblocked_by: second.id });

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === target.id);
      expect(row?.blocked_count).toBe(0);
      expect(row?.ready).toBe(true);
    });

    it("a DROPPED blocker also stops blocking, exactly like done", async () => {
      const { paths, backend } = await makeRepoFixture();
      const target = makeTicket();
      const closer = makeTicket({ blocks: [target.id] });
      await createTicket(paths, target, ctx, createdEvent);
      await createTicket(paths, closer, ctx, createdEvent);

      await closeTicket(paths, closer.id, "dropped");
      const result = await backend.transact((tx) =>
        cascadeOnClose(backend, tx, closer.id, ctx, clock),
      );
      expect(result.unblocked).toEqual([target.id]);
      expect(result.events).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Clause 2: "ready ordering = priority then age"
  // -------------------------------------------------------------------------

  describe('"ready ordering = priority then age"', () => {
    it("orders strictly by priority (0 urgent .. 3 low), then by age (older first) within a priority, ties included", async () => {
      const root = await makeCliFixture();

      // Deliberately created out of "final order" to prove sorting, not
      // insertion order, drives the result. Two tickets share priority 1
      // (older-p1, newer-p1) to pin the age tiebreak.
      const p3 = newTicketCli(root, "low priority", ["--priority", "3"]);
      const olderP1 = newTicketCli(root, "older mid priority", ["--priority", "1"]);
      const p0 = newTicketCli(root, "urgent", ["--priority", "0"]);
      const newerP1 = newTicketCli(root, "newer mid priority", ["--priority", "1"]);
      const p2 = newTicketCli(root, "default priority", ["--priority", "2"]);

      const expectedOrder = [p0.id, olderP1.id, newerP1.id, p2.id, p3.id];

      const json = readyJson(root);
      expect(json.ready.map((r) => r.id)).toEqual(expectedOrder);

      // Cross-check the human-text rendering shows the same order (ids
      // appear in the text output too).
      const text = readyCli(root).stdout;
      const positions = expectedOrder.map((id) => text.indexOf(id));
      for (let i = 1; i < positions.length; i++) {
        expect(positions[i]).toBeGreaterThan(positions[i - 1] as number);
      }
    });

    it("age uses creation order even when tickets share every OTHER visible field", async () => {
      const root = await makeCliFixture();
      const first = newTicketCli(root, "same priority A", ["--priority", "2"]);
      const second = newTicketCli(root, "same priority B", ["--priority", "2"]);
      const third = newTicketCli(root, "same priority C", ["--priority", "2"]);

      const json = readyJson(root);
      const ids = json.ready.map((r) => r.id);
      expect(ids).toEqual([first.id, second.id, third.id]);
    });
  });

  // -------------------------------------------------------------------------
  // Supplementary: the `ready` query surface (design.md §2, §4.2)
  // -------------------------------------------------------------------------

  describe("ready query surface", () => {
    it("drafts never appear in ready", async () => {
      const root = await makeCliFixture();
      const draft = newTicketCli(root, "a draft", ["--draft"]);
      const open = newTicketCli(root, "an open ticket");

      const json = readyJson(root);
      const ids = json.ready.map((r) => r.id);
      expect(ids).toContain(open.id);
      expect(ids).not.toContain(draft.id);
    });

    it("review/in_progress/done/dropped tickets never appear in strict `ready`, even with 0 blockers", async () => {
      const { paths, root } = await makeRepoFixture();
      const inProgress = makeTicket({ state: "in_progress" });
      const review = makeTicket({
        state: "review",
        review: { requested_at: "2026-07-23T10:00:00.000Z", by: { name: "ryan", kind: "human" } },
      });
      const done = makeTicket({ state: "done" });
      const dropped = makeTicket({ state: "dropped" });
      const open = makeTicket({ state: "open" });
      for (const t of [inProgress, review, done, dropped, open]) {
        await createTicket(paths, t, ctx, createdEvent);
      }

      const json = readyJson(root);
      const ids = json.ready.map((r) => r.id);
      expect(ids).toEqual([open.id]);
    });

    it("a ticket with an active session (real `slop start`) never appears in ready", async () => {
      const root = await makeCliFixture();
      const { id } = newTicketCli(root, "will be started");
      const start = runSlop(["start", id], root);
      expect(start.status, start.stderr).toBe(0);

      const json = readyJson(root);
      expect(json.ready.map((r) => r.id)).not.toContain(id);
    });

    it("--label filters to tickets carrying that exact label", async () => {
      const root = await makeCliFixture();
      const withLabel = newTicketCli(root, "labelled", ["--label", "area:auth"]);
      const withoutLabel = newTicketCli(root, "unlabelled");

      const json = readyJson(root, ["--label", "area:auth"]);
      const ids = json.ready.map((r) => r.id);
      expect(ids).toEqual([withLabel.id]);
      expect(ids).not.toContain(withoutLabel.id);
    });

    describe("--resumable", () => {
      it("surfaces in_progress/review tickets with NO active session, and is additive to the strict ready set", async () => {
        const { paths, root } = await makeRepoFixture();
        const stoppedInProgress = makeTicket({ state: "in_progress", active_session: null });
        const stoppedReview = makeTicket({
          state: "review",
          active_session: null,
          review: { requested_at: "2026-07-23T10:00:00.000Z", by: { name: "ryan", kind: "human" } },
        });
        const openTicket = makeTicket({ state: "open" });
        for (const t of [stoppedInProgress, stoppedReview, openTicket]) {
          await createTicket(paths, t, ctx, createdEvent);
        }

        // Without --resumable: only the strictly-ready open ticket.
        const withoutFlag = readyJson(root);
        expect(withoutFlag.ready.map((r) => r.id)).toEqual([openTicket.id]);
        expect(withoutFlag.resumable_requested).toBe(false);
        expect(withoutFlag.resumable).toEqual([]);

        // With --resumable: same ready set, PLUS both stopped tickets.
        const withFlag = readyJson(root, ["--resumable"]);
        expect(withFlag.ready.map((r) => r.id)).toEqual([openTicket.id]);
        expect(withFlag.resumable_requested).toBe(true);
        expect(withFlag.resumable.map((r) => r.id).sort()).toEqual(
          [stoppedInProgress.id, stoppedReview.id].sort(),
        );
        for (const row of withFlag.resumable) {
          expect(row.why.length).toBeGreaterThan(0);
        }
      });

      it("does NOT surface an in_progress ticket that still has an active session (real `slop start`)", async () => {
        const root = await makeCliFixture();
        const { id } = newTicketCli(root, "actively worked");
        const start = runSlop(["start", id], root);
        expect(start.status, start.stderr).toBe(0);

        const json = readyJson(root, ["--resumable"]);
        expect(json.resumable.map((r) => r.id)).not.toContain(id);
        expect(json.ready.map((r) => r.id)).not.toContain(id);
      });

      it("never surfaces done/dropped tickets even under --resumable", async () => {
        const { paths, root } = await makeRepoFixture();
        const done = makeTicket({ state: "done" });
        const dropped = makeTicket({ state: "dropped" });
        await createTicket(paths, done, ctx, createdEvent);
        await createTicket(paths, dropped, ctx, createdEvent);

        const json = readyJson(root, ["--resumable"]);
        expect(json.resumable).toEqual([]);
      });
    });

    describe("--json shape", () => {
      it("carries id, slug, name, priority, labels, state, and why for every row", async () => {
        const root = await makeCliFixture();
        newTicketCli(root, "shaped ticket", ["--priority", "1", "--label", "area:x"]);

        const json = readyJson(root);
        expect(json.ready).toHaveLength(1);
        const row = json.ready[0];
        expect(row).toBeDefined();
        expect(typeof row?.id).toBe("string");
        expect(typeof row?.slug).toBe("string");
        expect(row?.name).toBe("shaped ticket");
        expect(row?.priority).toBe(1);
        expect(row?.labels).toEqual(["area:x"]);
        expect(row?.state).toBe("open");
        expect(row?.why.length).toBeGreaterThan(0);
      });
    });

    describe("--budget", () => {
      it("bounds output size in characters and reports what was elided", async () => {
        const root = await makeCliFixture();
        for (let i = 0; i < 5; i++) newTicketCli(root, `budget candidate ${i}`);

        const full = readyCli(root).stdout;
        const budget = Math.floor(full.length / 2);
        const result = readyCli(root, ["--budget", String(budget)]);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.length).toBeLessThanOrEqual(budget);
        expect(result.stdout).toMatch(/omitted to fit --budget/);
      });

      it("--budget also bounds --json output, and stays valid JSON", async () => {
        const root = await makeCliFixture();
        for (let i = 0; i < 5; i++) newTicketCli(root, `budget json candidate ${i}`);

        const full = readyCli(root, ["--json"]).stdout;
        const budget = Math.floor(full.length * 0.6);
        const result = readyCli(root, ["--json", "--budget", String(budget)]);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.length).toBeLessThanOrEqual(budget);
        const parsed = JSON.parse(result.stdout) as ReadyJsonOutput;
        expect(parsed.elided.length).toBeGreaterThan(0);
        expect(parsed.ready.length).toBeLessThan(5);
      });
    });

    describe("empty result", () => {
      it("exits 0 with a clear message hinting at `slop status`, for both text and --json", async () => {
        const root = await makeCliFixture();

        const text = readyCli(root);
        expect(text.status).toBe(0);
        expect(text.stdout.toLowerCase()).toContain("nothing ready");
        expect(text.stdout).toMatch(/slop status/);

        const json = readyJson(root);
        expect(json.ready).toEqual([]);
        expect(json.hint).toMatch(/slop status/);
      });
    });
  });
});
