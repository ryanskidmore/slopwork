import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Ticket, TicketId } from "../../src/core/index.js";
import { newTicketId, ticketSchema } from "../../src/core/index.js";
import type { EventContext, MutationEventSpec, RepoPaths } from "../../src/repo/index.js";
import {
  createTicket,
  ensureDbDirs,
  listEvents,
  listSessions,
  listTickets,
  loadIndex,
  readTicket,
  repoPaths,
} from "../../src/repo/index.js";
import type { MergeSimReport } from "./e2-merge-sim.js";
import { checkHardInvariants, formatReport, runMergeSimulation } from "./e2-merge-sim.js";

// E2: Concurrency + merge hardening
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "Scripted git merge of divergent `.slop/db` → zero manual conflicts
//   except same-ticket edits; index rebuilds clean"
//
// This is the last critical-path item before E3 (… → C3 → E2 → E3) and the
// single most important piece of evidence for design.md §3's storage bet:
// "ULID filenames → create-conflicts impossible; events immutable →
// conflict-free; index gitignored → the always-conflicting file doesn't
// exist; same-ticket edits → ordinary small JSONC diffs."
//
// The merge simulation itself (real `git` + the compiled `dist/slop`
// binary, two clones diverging for real) lives in the reusable, ALSO
// -standalone-runnable `tests/acceptance/e2-merge-sim.ts` (see its module
// doc for the full mechanics and for the one real, precisely-scoped defect
// it uncovered). This file runs it once in `beforeAll` and asserts on the
// structured report it returns, then covers the second half of E2's brief
// — parallel-start races and lock contention under real multi-process
// concurrency — directly, spawning real `dist/slop` processes exactly like
// A3's kill-9/fencing tests and C1's parallel-start test do.
//
// C1.test.ts already proves the pairwise "two concurrent starts" guarantee
// in detail; this file does not repeat that coverage. What it adds is the
// N-way (N=4) generalisation explicitly called for by design.md's own
// scale target ("2–3 agents on parallel streams") and by this work item's
// brief ("make the guarantee explicit here"), plus lock-contention coverage
// A3/C1 don't have at all: real concurrent multi-file transactions
// (`split`, and a `done`-cascade converging on one shared ticket) racing
// each other for `.slop/db/.lock`.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
  // Same "build if missing" convention as every other acceptance suite.
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
// Shared fixture/spawn helpers (same conventions as A3.test.ts/C1.test.ts)
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const d = scratchDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

/** Every harness-identity env var a real harness (including the one this
 * very agent may be running under) sets — stripped so detection inside
 * every spawned `dist/slop` process is never contaminated by this
 * process's own ambient environment. Same list every other suite uses. */
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
  "CODEX_HOME",
] as const;

function slopEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of HARNESS_ENV_KEYS) env[key] = undefined;
  for (const [k, v] of Object.entries(overrides)) env[k] = v;
  return env;
}

function runSlop(args: string[], cwd: string, actor: string) {
  return spawnSync(binaryPath, args, { cwd, encoding: "utf8", env: slopEnv({ SLOP_ACTOR: actor }) });
}

function mustRunSlop(args: string[], cwd: string, actor: string) {
  const r = runSlop(args, cwd, actor);
  if (r.status !== 0) {
    throw new Error(`slop ${args.join(" ")} failed (exit ${r.status}):\n${r.stderr}`);
  }
  return r;
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  finishedAt: number;
}

/** Collect a spawned process's exit code/output, timestamped so callers can
 * prove genuine wall-clock overlap rather than accidental serialisation —
 * the same pattern C1.test.ts's own parallel-start test uses. */
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

/** Did at least one pair of results genuinely overlap in wall-clock time?
 * Guards every concurrency test below against passing vacuously off
 * accidental serialisation. */
function hasGenuineOverlap(results: readonly SpawnResult[]): boolean {
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i];
      const b = results[j];
      if (!a || !b) continue;
      if (Math.max(a.startedAt, b.startedAt) < Math.min(a.finishedAt, b.finishedAt)) return true;
    }
  }
  return false;
}

const ctx: EventContext = { actor: { name: "fixture", kind: "human" }, session: null };
const ticketCreated: MutationEventSpec = { verb: "ticket.created" };

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

/** A minimal repo built directly against the repo layer (fast, exact
 * control) — the same fixture shape C1.test.ts uses for its own
 * parallel-start race. */
async function makeRepo(): Promise<{ dir: string; paths: RepoPaths }> {
  const dir = await mkdtemp(join(tmpdir(), "slop-e2-repo-"));
  scratchDirs.push(dir);
  const paths = await ensureDbDirs(dir);
  await writeFile(join(dir, ".slop", "config.yaml"), "project: e2-test\n", "utf8");
  return { dir, paths };
}

/** A repo built via the real `slop init --yes` CLI path — used by the
 * lock-contention tests below, which need `slop new`/`split`/`done`'s full
 * command bodies, not just direct repo-layer fixture writes. */
async function makeCliRepo(): Promise<{ dir: string; paths: RepoPaths }> {
  const dir = await mkdtemp(join(tmpdir(), "slop-e2-cli-"));
  scratchDirs.push(dir);
  const init = mustRunSlop(["init", "--yes", "--project", "e2-cli-fixture", "--user", "ryan"], dir, "ryan");
  expect(init.status, init.stderr).toBe(0);
  return { dir, paths: repoPaths(dir) };
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

function newTicketCli(
  dir: string,
  actor: string,
  name: string,
  extraArgs: string[] = [],
): { id: TicketId; slug: string } {
  const result = mustRunSlop(["new", name, ...extraArgs], dir, actor);
  const m = CREATED_LINE.exec(result.stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(`could not parse "created <id> (slug: <slug>)" out of:\n${result.stdout}`);
  }
  return { id: m[1] as TicketId, slug: m[2] };
}

// ---------------------------------------------------------------------------
// The merge simulation
// ---------------------------------------------------------------------------

describe("E2: Concurrency + merge hardening", () => {
  describe("the merge simulation (design.md §3's storage bet, put to the test)", () => {
    let report: MergeSimReport;

    beforeAll(async () => {
      report = await runMergeSimulation();
      // The legible, self-explanatory summary this work item's report
      // quotes verbatim — printed once, here, so `bun run test`'s own
      // output already contains the full evidence trail.
      for (const line of formatReport(report)) {
        // eslint/biome: this is intentional, human-facing test evidence,
        // not debug scaffolding left behind by accident.
        console.log(line);
      }
    }, 120_000);

    it("new tickets, sessions, and events created independently on both clones merge with zero conflicts (ULID filenames make create-conflicts impossible; events are immutable)", () => {
      expect(report.newA.id).not.toBe(report.newB.id);
      expect(report.blockerA.id).not.toBe(report.blockerB.id);
      expect(report.conflictedRelPaths.some((p) => p.includes(report.newA.id))).toBe(false);
      expect(report.conflictedRelPaths.some((p) => p.includes(report.newB.id))).toBe(false);
      expect(report.conflictedRelPaths.some((p) => p.includes(report.blockerA.id))).toBe(false);
      expect(report.conflictedRelPaths.some((p) => p.includes(report.blockerB.id))).toBe(false);
      // No event file, and no session file, EVER appears in the conflict
      // set — the two claims design.md §3 makes about them directly.
      expect(report.conflictedRelPaths.every((p) => !p.includes("/events/"))).toBe(true);
      expect(report.conflictedRelPaths.every((p) => !p.includes("/sessions/"))).toBe(true);
    });

    it('the SAME-field edit on the shared ticket produces the one legitimate, expected conflict — proving git is discriminating, not rubber-stamping everything', () => {
      expect(report.mergeAttempt.status).not.toBe(0);
      expect(report.sameFieldConflict).not.toBeNull();
      const text = (report.sameFieldConflict?.hunks ?? [])
        .map((h) => [...h.ours, ...h.theirs].join("\n"))
        .join("\n");
      expect(text).toContain('"priority": 3');
      expect(text).toContain('"priority": 0');
    });

    // KNOWN DEFECT, found by this simulation, reported precisely per E2's
    // ground rules (repo-layer/command-body fixes are out of scope for
    // this work item — see tests/acceptance/e2-merge-sim.ts's module doc
    // for the full root-cause writeup and repro). This test encodes the
    // acceptance bar's OWN literal wording — "edits to different
    // fields/tickets — must merge cleanly with no conflict markers" — and
    // is wrapped in `it.fails` because that wording is not met TODAY:
    // every `slop update` unconditionally bumps `updated_at`
    // (src/tickets/update.ts's buildUpdate), always the file's last
    // field, so two clones editing DIFFERENT fields of the same ticket at
    // two different real moments still collide on that one line. Once a
    // scoped fix lands (e.g. only touching `updated_at` when something
    // beyond bookkeeping actually changed, or a smarter merge driver),
    // this test will start reporting as an unexpected PASS — vitest's
    // `it.fails` semantics turn that into a visible failure here, which
    // is the intended signal to delete this `it.fails` wrapper.
    it.fails(
      "[KNOWN DEFECT] editing DIFFERENT fields of a shared ticket should ALSO merge with zero conflicts (this work item's own acceptance bar) — currently blocked by the `updated_at` bump on every write",
      () => {
        expect(report.diffFieldConflict).toBeNull();
      },
    );

    it("characterizes the known defect precisely: the different-field conflict is confined to EXACTLY one hunk, and that hunk is ONLY the `updated_at` line — both clones' real intended edits merge correctly, unconflicted, everywhere else in the file", () => {
      expect(report.diffFieldConflict).not.toBeNull();
      const obs = report.diffFieldConflict;
      if (!obs) throw new Error("unreachable — asserted not-null above");
      expect(obs.hunks).toHaveLength(1);
      const hunk = obs.hunks[0];
      if (!hunk) throw new Error("unreachable");
      const hunkText = [...hunk.ours, ...hunk.theirs].join("\n");
      expect(hunkText).toMatch(/"updated_at":/);
      expect(hunkText).not.toMatch(/"name":|"priority":/);
      // Both clones' real, intended field changes ARE present in the raw
      // conflicted file text, entirely OUTSIDE any conflict hunk — proof
      // the diff-minimal JSONC write strategy (S3's spike decision) works
      // exactly as designed; only the timestamp bookkeeping field collides.
      expect(obs.rawText).toContain("Renamed by clone A");
      expect(obs.rawText).toContain('"priority": 1');
    });

    it("after resolving the conflict(s) and committing, `slop reindex` rebuilds clean", () => {
      expect(report.resolveAndCommit.status).toBe(0);
      expect(report.graph.reindexStatus).toBe(0);
      expect(report.graph.reindexProblemCount).toBe(0);
    });

    it("graph integrity holds after the merge: no dangling refs, the shared dependent ticket recomputes ready with blocked_count 0, both blockers are done", () => {
      expect(report.graph.danglingRefs).toEqual([]);
      expect(report.graph.dependentRow).not.toBeNull();
      expect(report.graph.dependentRow?.blocked_count).toBe(0);
      expect(report.graph.dependentRow?.ready).toBe(true);
      expect([...(report.graph.dependentRow?.blocked_by ?? [])].sort()).toEqual(
        [report.blockerA.id, report.blockerB.id].sort(),
      );
      expect(report.graph.blockerAState).toBe("done");
      expect(report.graph.blockerBState).toBe("done");
      // Each clone's own independent, partial-view done-cascade fired
      // legitimately once (each only ever saw ITS OWN blocker of
      // `dependent`) — two real, non-duplicate, non-lost notifications
      // survive the merge intact; recompute-from-truth (db-index.ts) is
      // what makes `blocked_count`/`ready` correct regardless of how many
      // `ticket.ready` events exist on file.
      expect(report.graph.dependentReadyTicketReadyEventCount).toBe(2);
    });

    it("the merged event stream remains totally ordered by event ULID (design.md §3: cursor ordering on the event ULID itself)", () => {
      expect(report.graph.eventsSortedByIdAscending).toBe(true);
      expect(report.graph.totalEvents).toBeGreaterThan(0);
    });

    it("index.jsonc (D14) was never part of the merge: gitignored on both clones, genuinely diverged locally, never tracked before or after", () => {
      expect(report.trackedFilesA.some((f) => f.endsWith("index.jsonc"))).toBe(false);
      expect(report.trackedFilesB.some((f) => f.endsWith("index.jsonc"))).toBe(false);
      expect(report.trackedFilesA.some((f) => f.includes(".slop/transcripts/"))).toBe(false);
      expect(report.trackedFilesB.some((f) => f.includes(".slop/transcripts/"))).toBe(false);
      expect(report.graph.indexFileTrackedByGitPostMerge).toBe(false);
      expect(report.localIndexDivergedBeforeMerge).toBe(true);
    });

    it("no hard invariant regressed beyond the one documented, narrowly-scoped `updated_at` defect", () => {
      expect(checkHardInvariants(report)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrency hardening
  // ---------------------------------------------------------------------------

  describe("concurrency hardening", () => {
    describe("parallel-start races (extends C1's pairwise case to real N-way contention)", () => {
      it("4 real `dist/slop start` processes race the SAME ticket at once: exactly one wins, the other 3 warn and exit 6, exactly one session is created, and the db is left coherent", async () => {
        const N = 4;
        const { dir, paths } = await makeRepo();
        const ticket = makeTicket({ name: "N-way race ticket" });
        await createTicket(paths, ticket, ctx, ticketCreated);

        const procs: ChildProcess[] = [];
        for (let i = 0; i < N; i++) {
          procs.push(
            spawn(binaryPath, ["start", ticket.slug], {
              cwd: dir,
              env: slopEnv({ SLOP_ACTOR: `agent-${i}` }),
            }),
          );
        }
        const results = await Promise.all(procs.map(collect));

        expect(
          hasGenuineOverlap(results),
          "no two of the 4 processes overlapped in wall-clock time — this run could pass vacuously off accidental serialisation",
        ).toBe(true);

        const codes = results.map((r) => r.code).sort((a, b) => (a ?? -1) - (b ?? -1));
        expect(codes).toEqual([0, 6, 6, 6]);

        const winners = results.filter((r) => r.code === 0);
        expect(winners).toHaveLength(1);
        expect(winners[0]?.stdout).toContain("started");
        for (const loser of results.filter((r) => r.code === 6)) {
          expect(loser.stderr).toMatch(/already has an active session/i);
          expect(loser.stderr).toMatch(/--takeover/);
        }

        const sessions = await listSessions(paths);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.ended_at).toBeNull();
        const finalTicket = await readTicket(paths, ticket.id);
        expect(finalTicket.state).toBe("in_progress");
        expect(finalTicket.active_session).toBe(sessions[0]?.id);
      }, 30_000);
    });

    describe("lock contention: concurrent multi-file transactions against one db", () => {
      it("5 real `dist/slop split` processes, each targeting a DIFFERENT parent ticket, contend for the SAME `.slop/db/.lock` at once: every split lands intact, no corruption, no lost children", async () => {
        const N = 5;
        const { dir, paths } = await makeCliRepo();

        const targets = Array.from({ length: N }, (_, i) =>
          newTicketCli(dir, "ryan", `Split target ${i}`),
        );

        const procs = targets.map((t, i) =>
          spawn(binaryPath, ["split", t.slug, `${t.slug} child a`, `${t.slug} child b`], {
            cwd: dir,
            env: slopEnv({ SLOP_ACTOR: `agent-${i}` }),
          }),
        );
        const results = await Promise.all(procs.map(collect));

        expect(
          hasGenuineOverlap(results),
          "no two of the 5 split processes overlapped in wall-clock time",
        ).toBe(true);

        for (const [i, r] of results.entries()) {
          expect(r.code, `split #${i} stderr: ${r.stderr}`).toBe(0);
        }

        // Every ticket on disk parses and validates (listTickets throws on
        // any corrupt/invalid file — a clean return is itself the "no
        // corruption" proof), and every target has exactly its 2 children,
        // correctly parented — no lost or cross-wired child across 5
        // processes hammering the same lock concurrently.
        const tickets = await listTickets(paths);
        expect(tickets).toHaveLength(N + 2 * N);
        for (const target of targets) {
          const children = tickets.filter((t) => t.parent === target.id);
          expect(children, `target ${target.slug}`).toHaveLength(2);
          for (const child of children) {
            // Split children carry their target as both `parent` and
            // `discovered_from` (tickets/split.ts's own documented
            // provenance edge) — asserted here as the "no cross-wiring
            // under contention" proof: every child's discovered_from must
            // point at ITS OWN target, never another process's.
            expect(child.discovered_from).toEqual([target.id]);
            expect(child.root_id).toBe(target.id);
          }
        }
      }, 30_000);

      it("4 real `dist/slop done` processes, each closing a DIFFERENT blocker of the SAME shared dependent ticket, fired concurrently: no lost updates, blocked_count/ready recompute correctly, and exactly one `ticket.ready` is credited (the lock serializes the cascades)", async () => {
        const N = 4;
        const { dir, paths } = await makeCliRepo();

        const dependent = newTicketCli(dir, "ryan", "Shared dependent (lock contention)");
        const workers = Array.from({ length: N }, (_, i) =>
          newTicketCli(dir, "ryan", `Worker ${i}`, ["--blocks", dependent.slug]),
        );

        // start + review sequentially (fast, and not the part under test —
        // the CONCURRENT step below is what exercises real lock contention).
        for (const [i, w] of workers.entries()) {
          mustRunSlop(["start", w.slug], dir, `agent-${i}`);
          mustRunSlop(["review", w.slug, "--mr", `https://example.com/pr/${i}`], dir, `agent-${i}`);
        }

        const procs = workers.map((w, i) =>
          spawn(binaryPath, ["done", w.slug, "--note", `done from agent-${i}`], {
            cwd: dir,
            env: slopEnv({ SLOP_ACTOR: `agent-${i}` }),
          }),
        );
        const results = await Promise.all(procs.map(collect));

        expect(
          hasGenuineOverlap(results),
          "no two of the 4 concurrent `done` processes overlapped in wall-clock time",
        ).toBe(true);

        for (const [i, r] of results.entries()) {
          expect(r.code, `done #${i} stderr: ${r.stderr}`).toBe(0);
        }

        for (const w of workers) {
          const wt = await readTicket(paths, w.id);
          expect(wt.state, w.slug).toBe("done");
          expect(wt.active_session, w.slug).toBeNull();
        }

        const dependentTicket = await readTicket(paths, dependent.id);
        expect(dependentTicket.state).toBe("open");

        const { index, rebuilt } = await loadIndex(paths);
        void rebuilt;
        const row = index.tickets.find((r) => r.id === dependent.id);
        expect(row?.blocked_count).toBe(0);
        expect(row?.ready).toBe(true);

        // Exactly one `ticket.ready` for the shared dependent: `.lock`
        // fully serializes each `done`'s cascade (one at a time acquires
        // the lock, reads the CURRENT on-disk state of every other
        // worker, decides, releases), so only the LAST closure to run (in
        // lock-acquisition order — not necessarily process-spawn order)
        // ever observes blocked_count===0 and fires. This is the
        // "no lost updates" property under real contention, complementing
        // A3's synthetic fencing test with genuine concurrent CLI usage.
        const events = await listEvents(paths);
        const readyEvents = events.filter(
          (e) => e.verb === "ticket.ready" && e.entity.kind === "ticket" && e.entity.id === dependent.id,
        );
        expect(readyEvents).toHaveLength(1);

        // Every worker's own done-session/done/review events are present
        // — no mutation was silently dropped under contention.
        for (const w of workers) {
          const workerEvents = events.filter((e) => e.entity.kind === "ticket" && e.entity.id === w.id);
          expect(workerEvents.some((e) => e.verb === "ticket.done"), w.slug).toBe(true);
        }
      }, 30_000);
    });
  });

  // ---------------------------------------------------------------------------
  // Real defects found by this work item (reported, per E2's ground rules,
  // NOT fixed here — repo-layer/command-body changes are out of scope).
  // ---------------------------------------------------------------------------

  describe("real defects found by this work item", () => {
    // The `updated_at`-collision defect is already fully characterized
    // above, inline with the merge simulation it was discovered in. This
    // second, independent defect was found while building this simulation
    // (a fresh clone crashed before the simulation could even reach its
    // divergence phase) and is isolated here into its own minimal repro,
    // deliberately NOT using the big merge-sim machinery, so it stands on
    // its own as evidence.
    it.fails(
      "[KNOWN DEFECT] a freshly cloned repo can run `slop start` immediately, even when a db subdirectory (e.g. sessions/) held zero files at commit time — git does not track empty directories, so that directory does not exist at all post-clone, and the repo layer has no mkdir-on-demand fallback (src/repo/atomic-write.ts's atomicWriteFile opens the temp file with no parent-dir creation)",
      async () => {
        const origin = await mkdtemp(join(tmpdir(), "slop-e2-emptydir-origin-"));
        scratchDirs.push(origin);
        execFileSync("git", ["init", "-q", "-b", "main"], { cwd: origin });
        execFileSync("git", ["config", "user.email", "origin@example.com"], { cwd: origin });
        execFileSync("git", ["config", "user.name", "Origin"], { cwd: origin });

        const init = mustRunSlop(["init", "--yes", "--project", "emptydir-repro", "--user", "origin"], origin, "origin");
        expect(init.status).toBe(0);

        // A single ticket -> tickets/ and events/ both get a real file and
        // are committed; sessions/ never receives one, so git never
        // tracks it — an entirely ordinary "nobody has started work yet"
        // repo state, not a contrived one.
        const only = newTicketCli(origin, "origin", "Only ticket, no session ever started");

        execFileSync("git", ["add", "-A"], { cwd: origin });
        execFileSync("git", ["commit", "-q", "-m", "init + one ticket, no sessions yet"], { cwd: origin });

        const cloneDir = join(await mkdtemp(join(tmpdir(), "slop-e2-emptydir-clone-")), "repo");
        scratchDirs.push(dirname(cloneDir));
        execFileSync("git", ["clone", "-q", origin, cloneDir]);

        // This is the exact command a teammate/agent would run first
        // against a fresh clone. It should succeed (or at worst fail with
        // a clean, actionable SlopError) — not crash with a raw ENOENT.
        const result = runSlop(["start", only.slug], cloneDir, "clone-agent");
        expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      },
    );
  });
});
