import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import type { SessionId, TicketId } from "../../core/index.js";
import { listSessions, queryEvents, readTicket, repoPaths } from "../../repo/index.js";
import { FlatfileBackend } from "../../storage/flatfile.js";
import { runNew } from "./new.js";
import { runStart } from "./start.js";
import { runUpdate } from "./update.js";

// Regression test for ticket_01KY93E2BKH5JCMAV3JWPNN63G: `update` (and
// `draft`/`undraft`, see draft.test.ts/undraft.test.ts) used to read the
// ticket OUTSIDE any lock and compute its write from that stale snapshot.
// Racing a concurrent `start`/`done` (which DO lock + re-read), the
// mismatch between `update`'s stale `expectedAfter` and the fresh on-disk
// text tripped `writeUpdate`'s `writeCanonical(expectedAfter)` fallback
// (src/core/jsonc.ts) — silently reverting the concurrent committed
// transition. The fix wraps `runUpdate`'s read-modify-write in
// `withLock(paths.lockFile, ...)` and re-reads the ticket by id INSIDE the
// lock, exactly like start.ts/stop.ts/done.ts already do.
//
// These tests spawn TWO REAL `bun src/cli/index.ts ...` processes (source,
// not `dist/slop` — no build step is triggered) racing the SAME ticket, and
// assert the final on-disk state reflects BOTH commands' intended effects
// regardless of which one's lock acquisition wins first. That "both effects
// survive, order-independent" property only holds once both commands
// re-read fresh state under a shared lock — before the fix, whichever
// process's write lands second (almost always, since without a lock both
// processes' initial reads race each other with no synchronization at all)
// clobbers the other's already-committed change.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

const scratchDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (scratchDirs.length > 0) {
    const d = scratchDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

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

function runSlopSource(args: string[], cwd: string, actor: string) {
  return spawnSync("bun", [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    env: slopEnv({ SLOP_ACTOR: actor }),
  });
}

function mustRunSlopSource(args: string[], cwd: string, actor: string) {
  const r = runSlopSource(args, cwd, actor);
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

async function makeCliRepo(): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "slop-update-race-"));
  scratchDirs.push(dir);
  const init = mustRunSlopSource(
    ["init", "--yes", "--project", "update-race-fixture", "--user", "ryan"],
    dir,
    "ryan",
  );
  expect(init.status, init.stderr).toBe(0);
  return { dir };
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

function newTicketCli(dir: string, actor: string, name: string): { id: TicketId; slug: string } {
  const result = mustRunSlopSource(["new", name], dir, actor);
  const m = CREATED_LINE.exec(result.stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(`could not parse "created <id> (slug: <slug>)" out of:\n${result.stdout}`);
  }
  return { id: m[1] as TicketId, slug: m[2] };
}

describe("update: race against a concurrent lock-holding mutator (regression, ticket_01KY93E2BKH5JCMAV3JWPNN63G)", () => {
  it("`update --priority 0` racing `start`, on a real repo: the started session is never orphaned and the priority change is never lost, regardless of which process's lock wins", async () => {
    const { dir } = await makeCliRepo();
    const ticket = newTicketCli(dir, "ryan", "Update vs start race");

    const procA = spawn("bun", [cliEntry, "update", ticket.slug, "--priority", "0"], {
      cwd: dir,
      env: slopEnv({ SLOP_ACTOR: "updater" }),
    });
    const procB = spawn("bun", [cliEntry, "start", ticket.slug], {
      cwd: dir,
      env: slopEnv({ SLOP_ACTOR: "starter" }),
    });
    const [resA, resB] = await Promise.all([collect(procA), collect(procB)]);

    expect(
      hasGenuineOverlap([resA, resB]),
      "update and start never overlapped in wall-clock time — this run could pass vacuously off accidental serialisation",
    ).toBe(true);

    expect(resA.code, `update stderr: ${resA.stderr}`).toBe(0);
    expect(resB.code, `start stderr: ${resB.stderr}`).toBe(0);

    const paths = repoPaths(dir);
    const finalTicket = await readTicket(paths, ticket.id);

    // Both commands' committed effects must survive, unconditionally of
    // ordering: start's transition to in_progress with an active session
    // is never reverted (no orphaned session), and update's priority
    // change is never lost.
    expect(finalTicket.priority).toBe(0);
    expect(finalTicket.state).toBe("in_progress");
    expect(finalTicket.active_session).not.toBeNull();

    const sessions = await listSessions(paths);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(finalTicket.active_session);
    // The started session must still be genuinely active (not orphaned
    // by a ticket write that silently reverted active_session back to
    // null while the session file itself stayed ended_at: null).
    expect(sessions[0]?.ended_at).toBeNull();
  }, 30_000);

  it("`update --priority 0` racing `done`, on a real repo: the completed ticket is never resurrected and the priority change is never lost, regardless of which process's lock wins", async () => {
    const { dir } = await makeCliRepo();
    const ticket = newTicketCli(dir, "ryan", "Update vs done race");

    mustRunSlopSource(["start", ticket.slug], dir, "ryan");
    mustRunSlopSource(["review", ticket.slug, "--mr", "https://example.com/pr/1"], dir, "ryan");

    const procA = spawn("bun", [cliEntry, "update", ticket.slug, "--priority", "0"], {
      cwd: dir,
      env: slopEnv({ SLOP_ACTOR: "updater" }),
    });
    const procB = spawn("bun", [cliEntry, "done", ticket.slug, "--note", "shipped"], {
      cwd: dir,
      env: slopEnv({ SLOP_ACTOR: "finisher" }),
    });
    const [resA, resB] = await Promise.all([collect(procA), collect(procB)]);

    expect(
      hasGenuineOverlap([resA, resB]),
      "update and done never overlapped in wall-clock time — this run could pass vacuously off accidental serialisation",
    ).toBe(true);

    expect(resA.code, `update stderr: ${resA.stderr}`).toBe(0);
    expect(resB.code, `done stderr: ${resB.stderr}`).toBe(0);

    const paths = repoPaths(dir);
    const finalTicket = await readTicket(paths, ticket.id);

    // `done`'s terminal transition must never be reverted back to
    // "review" by update's stale-snapshot write (the "resurrecting
    // terminal tickets" half of the bug), and update's priority change
    // must never be lost either.
    expect(finalTicket.state).toBe("done");
    expect(finalTicket.priority).toBe(0);
    expect(finalTicket.active_session).toBeNull();
    expect(finalTicket.review).toBeUndefined();

    const sessions = await listSessions(paths);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.ended_at).not.toBeNull();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ticket_01KY9RWFM80BKNE2CDX85QMKGS: `update --progress` (and ONLY
// --progress — no other flag) is lock-free. This is the payoff: N agents
// can post progress notes against the SAME ticket at the same instant with
// ZERO write contention and zero merge conflicts, because each note is an
// immutable event of its own (a freshly-minted ULID file — never
// collides), not a mutation of the shared ticket file that would need
// `withLock` to serialize. Contrast the "update vs start/done" tests
// above: those races serialize on the db lock (one waits for the other);
// this one never even tries to acquire it.
// ---------------------------------------------------------------------------

describe("update --progress: lock-free concurrency (ticket_01KY9RWFM80BKNE2CDX85QMKGS)", () => {
  it("8 concurrent pure `update --progress` calls against the SAME ticket all succeed, land as 8 distinct events, and the derived latest_note/last_activity_at reflect them — with no lock contention", async () => {
    const { dir } = await makeCliRepo();
    const ticket = newTicketCli(dir, "ryan", "Concurrent progress ticket");
    const paths = repoPaths(dir);

    const N = 8;
    const procs = Array.from({ length: N }, (_, i) =>
      spawn("bun", [cliEntry, "update", ticket.id, "--progress", `note-${i}`], {
        cwd: dir,
        env: slopEnv({ SLOP_ACTOR: `agent-${i}` }),
      }),
    );
    const results = await Promise.all(procs.map(collect));

    expect(
      hasGenuineOverlap(results),
      "the N update --progress calls never overlapped in wall-clock time — this run could pass vacuously off accidental serialisation",
    ).toBe(true);

    // All N succeed, and none ever saw a CONFLICT/lock error — there was
    // never a lock to contend on in the first place.
    for (const [i, r] of results.entries()) {
      expect(r.code, `update --progress note-${i} stderr: ${r.stderr}`).toBe(0);
      expect(r.stderr).not.toMatch(/CONFLICT|lock/i);
    }

    // All N progress events landed, as distinct ULID event files — none
    // clobbered another (the whole point: append-only, never a shared
    // mutation).
    const events = await queryEvents(paths, { ticket: ticket.id });
    const progressEntries = events.flatMap((e) =>
      typeof e.payload.progress === "string"
        ? [{ note: e.payload.progress, at: e.at, id: e.id }]
        : [],
    );
    expect(progressEntries).toHaveLength(N);
    expect(new Set(progressEntries.map((e) => e.id)).size).toBe(N); // distinct event files
    expect(new Set(progressEntries.map((e) => e.note)).size).toBe(N); // distinct notes, none lost

    // No ticket-file write contention: the ticket file itself was never
    // touched by any of these calls (a pure --progress call never takes
    // the lock or writes it).
    const finalTicket = await readTicket(paths, ticket.id);
    expect(finalTicket.latest_note).toBeNull();
    expect(finalTicket.updated_at).toBe(finalTicket.created_at);

    // The DERIVED effective values (what every real read path reports —
    // `show --json` here) are correct: latest_note is one of the N notes,
    // and last_activity_at is the newest of the N events' timestamps.
    const show = mustRunSlopSource(["show", ticket.id, "--json"], dir, "ryan");
    const shown = JSON.parse(show.stdout) as {
      ticket: { latest_note: string | null; last_activity_at: string };
    };
    expect(progressEntries.map((e) => e.note)).toContain(shown.ticket.latest_note);
    const newestAt = progressEntries.reduce((max, e) => (e.at > max ? e.at : max), "");
    expect(shown.ticket.last_activity_at).toBe(newestAt);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ticket_01KY9RWFM80BKNE2CDX85QMKGS's deferred item: a genuinely no-op
// `update` call (nothing in UPDATE_TOUCHABLE_FIELDS actually changes)
// early-returns with no write and no event — previously it still took the
// lock's write and emitted an empty-payload `ticket.updated` event.
// ---------------------------------------------------------------------------

describe("update: a PURE no-op call writes nothing and emits no event (CLI-layer early return)", () => {
  it("`update --state <same-state>`, nothing else given: ticket file byte-for-byte unchanged, no new event", async () => {
    const { dir } = await makeCliRepo();
    const ticket = newTicketCli(dir, "ryan", "No-op update ticket");
    const paths = repoPaths(dir);

    const before = await readTicket(paths, ticket.id);
    const eventsBefore = await queryEvents(paths, { ticket: ticket.id });

    // A freshly-`new`'d ticket is already "open" — this restates it.
    const result = mustRunSlopSource(["update", ticket.id, "--state", "open"], dir, "ryan");
    expect(result.status, result.stderr).toBe(0);

    const after = await readTicket(paths, ticket.id);
    expect(after).toEqual(before);

    const eventsAfter = await queryEvents(paths, { ticket: ticket.id });
    expect(eventsAfter.map((e) => e.id)).toEqual(eventsBefore.map((e) => e.id));
  });
});

// ---------------------------------------------------------------------------
// ticket_01KYA3Z9FNZ2FDMDRWNKR9EV7J: `update --relates-to <±ref>` — the
// relates-to edge previously had no CLI flag on any mutating command at
// all; this is the `update`-side half (`new --relates-to <ref>`, bare
// add-only, is the other half — see new.test.ts). Same `+ref`/`-ref`
// sigil convention as `--label`, validated via the same edges.ts module
// `new` uses (`validateTicketEdges`).
// ---------------------------------------------------------------------------

describe("update --relates-to <±ref>: add/remove a relates-to edge (ticket_01KYA3Z9FNZ2FDMDRWNKR9EV7J)", () => {
  it("--help lists --relates-to", () => {
    const result = spawnSync("bun", [cliEntry, "update", "--help"], { encoding: "utf8" });
    expect(result.stdout).toContain("--relates-to");
  });

  it("+ref adds a relates-to edge, visible via `show --json`", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const target = newTicketCli(dir, "ryan", "Related target");

    const result = mustRunSlopSource(
      ["update", main.id, "--relates-to", `+${target.slug}`],
      dir,
      "ryan",
    );
    expect(result.status, result.stderr).toBe(0);

    const paths = repoPaths(dir);
    const after = await readTicket(paths, main.id);
    expect(after.relates_to).toEqual([target.id]);
  });

  it("-ref removes a previously-added relates-to edge", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const target = newTicketCli(dir, "ryan", "Related target");
    mustRunSlopSource(["update", main.id, "--relates-to", `+${target.slug}`], dir, "ryan");

    const result = mustRunSlopSource(
      ["update", main.id, "--relates-to", `-${target.slug}`],
      dir,
      "ryan",
    );
    expect(result.status, result.stderr).toBe(0);

    const paths = repoPaths(dir);
    const after = await readTicket(paths, main.id);
    expect(after.relates_to).toEqual([]);
  });

  it("add and remove combined in one call (repeatable flag)", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const keep = newTicketCli(dir, "ryan", "Keep this one");
    const drop = newTicketCli(dir, "ryan", "Drop this one");
    const add = newTicketCli(dir, "ryan", "Add this one");
    mustRunSlopSource(
      ["update", main.id, "--relates-to", `+${keep.slug}`, "--relates-to", `+${drop.slug}`],
      dir,
      "ryan",
    );

    const result = mustRunSlopSource(
      ["update", main.id, "--relates-to", `+${add.slug}`, "--relates-to", `-${drop.slug}`],
      dir,
      "ryan",
    );
    expect(result.status, result.stderr).toBe(0);

    const paths = repoPaths(dir);
    const after = await readTicket(paths, main.id);
    expect(after.relates_to.sort()).toEqual([keep.id, add.id].sort());
  });

  it("rejects a nonexistent --relates-to ref (exit 4, NOT_FOUND), leaving the ticket untouched", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const paths = repoPaths(dir);
    const before = await readTicket(paths, main.id);

    const result = runSlopSource(
      ["update", main.id, "--relates-to", "+no-such-ticket"],
      dir,
      "ryan",
    );
    expect(result.status).toBe(4);
    expect(result.stderr).toMatch(/no-such-ticket/);

    const after = await readTicket(paths, main.id);
    expect(after).toEqual(before);
  });

  it("rejects a --relates-to entry missing the +/- sigil (exit 2, USAGE_ERROR)", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const target = newTicketCli(dir, "ryan", "Related target");

    const result = runSlopSource(["update", main.id, "--relates-to", target.slug], dir, "ryan");
    expect(result.status).toBe(2);
  });

  it("rejects a self relates-to edge (exit 6, CONFLICT), leaving the ticket untouched (regression: ticket edges-self-relates-to-is)", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const paths = repoPaths(dir);
    const before = await readTicket(paths, main.id);

    const result = runSlopSource(["update", main.id, "--relates-to", `+${main.slug}`], dir, "ryan");
    expect(result.status).toBe(6);
    expect(result.stderr).toMatch(/relates-to/);

    const after = await readTicket(paths, main.id);
    expect(after).toEqual(before);
  });

  it("a redundant +ref on an already-present target is a no-op: no new event, ticket unchanged", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const target = newTicketCli(dir, "ryan", "Related target");
    mustRunSlopSource(["update", main.id, "--relates-to", `+${target.slug}`], dir, "ryan");

    const paths = repoPaths(dir);
    const before = await readTicket(paths, main.id);
    const eventsBefore = await queryEvents(paths, { ticket: main.id });

    const result = mustRunSlopSource(
      ["update", main.id, "--relates-to", `+${target.slug}`],
      dir,
      "ryan",
    );
    expect(result.status, result.stderr).toBe(0);

    const after = await readTicket(paths, main.id);
    expect(after).toEqual(before);
    const eventsAfter = await queryEvents(paths, { ticket: main.id });
    expect(eventsAfter.map((e) => e.id)).toEqual(eventsBefore.map((e) => e.id));
  });
});

describe("update --blocks/--owner/--parent: the non-interactive edge/owner repair path (edit-vi-fallback-hangs-agents)", () => {
  it("--help lists --blocks, --owner, and --parent", () => {
    const result = spawnSync("bun", [cliEntry, "update", "--help"], { encoding: "utf8" });
    expect(result.stdout).toContain("--blocks");
    expect(result.stdout).toContain("--owner");
    expect(result.stdout).toContain("--parent");
  });

  it("--blocks +ref adds a blocking edge, visible via `show --json`", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const target = newTicketCli(dir, "ryan", "Blocked target");

    const result = mustRunSlopSource(
      ["update", main.id, "--blocks", `+${target.slug}`],
      dir,
      "ryan",
    );
    expect(result.status, result.stderr).toBe(0);

    const paths = repoPaths(dir);
    const after = await readTicket(paths, main.id);
    expect(after.blocks).toEqual([target.id]);
  });

  it("-ref removes a previously-added blocks edge", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const target = newTicketCli(dir, "ryan", "Blocked target");
    mustRunSlopSource(["update", main.id, "--blocks", `+${target.slug}`], dir, "ryan");

    const result = mustRunSlopSource(
      ["update", main.id, "--blocks", `-${target.slug}`],
      dir,
      "ryan",
    );
    expect(result.status, result.stderr).toBe(0);

    const paths = repoPaths(dir);
    const after = await readTicket(paths, main.id);
    expect(after.blocks).toEqual([]);
  });

  it("rejects a self-blocks edge (exit 6, CONFLICT), leaving the ticket untouched", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const paths = repoPaths(dir);
    const before = await readTicket(paths, main.id);

    const result = runSlopSource(["update", main.id, "--blocks", `+${main.slug}`], dir, "ryan");
    expect(result.status).toBe(6);
    expect(result.stderr).toMatch(/blocks/);

    const after = await readTicket(paths, main.id);
    expect(after).toEqual(before);
  });

  // Unlike --relates-to (symmetric, non-cycle-checked), --blocks IS
  // cycle-checked (edges.ts's module doc) — this is the one behavioral
  // difference between the two that update.ts's shared `applyIdSetOps`
  // engine does NOT paper over: validateTicketEdges's assertNoBlocksCycle
  // still runs whenever `patch` touches `blocks`.
  it("rejects a two-ticket blocking CYCLE (exit 6, CONFLICT) — proves --blocks is cycle-checked, unlike --relates-to", async () => {
    const { dir } = await makeCliRepo();
    const a = newTicketCli(dir, "ryan", "Ticket A");
    const b = newTicketCli(dir, "ryan", "Ticket B");
    mustRunSlopSource(["update", a.id, "--blocks", `+${b.slug}`], dir, "ryan");

    const paths = repoPaths(dir);
    const bBefore = await readTicket(paths, b.id);

    // B now blocking A would close the cycle A -> B -> A.
    const result = runSlopSource(["update", b.id, "--blocks", `+${a.slug}`], dir, "ryan");
    expect(result.status).toBe(6);
    expect(result.stderr).toMatch(/cycle/i);

    const bAfter = await readTicket(paths, b.id);
    expect(bAfter).toEqual(bBefore);
  });

  it("rejects a nonexistent --blocks ref (exit 4, NOT_FOUND), leaving the ticket untouched", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const paths = repoPaths(dir);
    const before = await readTicket(paths, main.id);

    const result = runSlopSource(["update", main.id, "--blocks", "+no-such-ticket"], dir, "ryan");
    expect(result.status).toBe(4);

    const after = await readTicket(paths, main.id);
    expect(after).toEqual(before);
  });

  it("--owner <name> sets the owning actor", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");

    const result = mustRunSlopSource(["update", main.id, "--owner", "priya"], dir, "ryan");
    expect(result.status, result.stderr).toBe(0);

    const paths = repoPaths(dir);
    const after = await readTicket(paths, main.id);
    expect(after.owner).toEqual({ name: "priya", kind: "human" });
  });

  it("--owner can be replaced by a later call", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    mustRunSlopSource(["update", main.id, "--owner", "priya"], dir, "ryan");

    const result = mustRunSlopSource(["update", main.id, "--owner", "sam"], dir, "ryan");
    expect(result.status, result.stderr).toBe(0);

    const paths = repoPaths(dir);
    const after = await readTicket(paths, main.id);
    expect(after.owner).toEqual({ name: "sam", kind: "human" });
  });

  it("rejects a blank --owner (exit 2, USAGE_ERROR), leaving the ticket untouched", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const paths = repoPaths(dir);
    const before = await readTicket(paths, main.id);

    const result = runSlopSource(["update", main.id, "--owner", "   "], dir, "ryan");
    expect(result.status).toBe(2);

    const after = await readTicket(paths, main.id);
    expect(after).toEqual(before);
  });

  it("--parent <ref> reparents a root ticket under another, recomputing root_id/path", async () => {
    const { dir } = await makeCliRepo();
    const oldRoot = newTicketCli(dir, "ryan", "Old root");
    const newParent = newTicketCli(dir, "ryan", "New parent");

    const result = mustRunSlopSource(
      ["update", oldRoot.id, "--parent", newParent.slug],
      dir,
      "ryan",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toMatch(/reparented — root_id\/path recomputed for \d+ descendant/);

    const paths = repoPaths(dir);
    const after = await readTicket(paths, oldRoot.id);
    expect(after.parent).toBe(newParent.id);
    expect(after.root_id).toBe(newParent.id);
    expect(after.path).toEqual([newParent.id]);
  });

  it("--parent <ref> cascades root_id/path to every existing descendant, and says so on stdout", async () => {
    const { dir } = await makeCliRepo();
    const oldParent = newTicketCli(dir, "ryan", "Old parent");
    const newParent = newTicketCli(dir, "ryan", "New parent");
    mustRunSlopSource(["new", "Child ticket", "--parent", oldParent.id], dir, "ryan");
    const childResult = runSlopSource(["search", "Child ticket", "--json"], dir, "ryan");
    const childId = (JSON.parse(childResult.stdout) as { results: { id: TicketId }[] }).results[0]
      ?.id;
    if (!childId)
      throw new Error(`could not find "Child ticket" via search:\n${childResult.stdout}`);
    mustRunSlopSource(["new", "Grandchild ticket", "--parent", childId], dir, "ryan");

    const paths = repoPaths(dir);
    const childBefore = await readTicket(paths, childId);
    expect(childBefore.parent).toBe(oldParent.id);
    expect(childBefore.root_id).toBe(oldParent.id);

    // Reparent the CHILD (which itself has a child, "Grandchild ticket")
    // under newParent — the grandchild is the existing descendant whose
    // own root_id/path must move along with it.
    const result = mustRunSlopSource(["update", childId, "--parent", newParent.slug], dir, "ryan");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/reparented — root_id\/path recomputed for 1 descendant/);

    const childAfter = await readTicket(paths, childId);
    expect(childAfter.parent).toBe(newParent.id);
    expect(childAfter.root_id).toBe(newParent.id);
    expect(childAfter.path).toEqual([newParent.id]);

    const grandchildResult = runSlopSource(["search", "Grandchild ticket", "--json"], dir, "ryan");
    const grandchild = (JSON.parse(grandchildResult.stdout) as { results: { id: TicketId }[] })
      .results[0];
    if (!grandchild) throw new Error("could not find Grandchild ticket via search");
    const grandchildAfter = await readTicket(paths, grandchild.id);
    expect(grandchildAfter.root_id).toBe(newParent.id);
    expect(grandchildAfter.path).toEqual([newParent.id, childId]);
  });

  it("rejects a self-parent (exit 6, CONFLICT), leaving the ticket untouched", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const paths = repoPaths(dir);
    const before = await readTicket(paths, main.id);

    const result = runSlopSource(["update", main.id, "--parent", main.slug], dir, "ryan");
    expect(result.status).toBe(6);

    const after = await readTicket(paths, main.id);
    expect(after).toEqual(before);
  });

  it("rejects a nonexistent --parent ref (exit 4, NOT_FOUND), leaving the ticket untouched", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const paths = repoPaths(dir);
    const before = await readTicket(paths, main.id);

    const result = runSlopSource(["update", main.id, "--parent", "no-such-ticket"], dir, "ryan");
    expect(result.status).toBe(4);

    const after = await readTicket(paths, main.id);
    expect(after).toEqual(before);
  });

  it("an external (jira:) --parent is accepted, terminating the local tree", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");

    const result = mustRunSlopSource(["update", main.id, "--parent", "jira:PROJ-123"], dir, "ryan");
    expect(result.status, result.stderr).toBe(0);

    const paths = repoPaths(dir);
    const after = await readTicket(paths, main.id);
    expect(after.parent).toBe("jira:PROJ-123");
    expect(after.root_id).toBe(main.id);
    expect(after.path).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// In-process coverage of `runUpdate` (real v8 coverage, no subprocess).
// ---------------------------------------------------------------------------

function baseOpts(overrides: Partial<Parameters<typeof runUpdate>[1]> = {}) {
  return {
    label: [] as string[],
    relatesTo: [] as string[],
    blocks: [] as string[],
    discoveredFrom: [] as string[],
    acceptance: [] as string[],
    context: [] as string[],
    ...overrides,
  };
}

async function jsonNewTicket(
  root: string,
  name: string,
  extra: Partial<Parameters<typeof runNew>[1]> = {},
): Promise<TicketId> {
  const out = captureOutput();
  try {
    await withCwd(root, () =>
      runNew(name, {
        blocks: [],
        relatesTo: [],
        label: [],
        acceptance: [],
        context: [],
        json: true,
        ...extra,
      }),
    );
    return (JSON.parse(out.stdout()) as { id: TicketId }).id;
  } finally {
    out.restore();
  }
}

async function jsonStartTicket(root: string, id: TicketId): Promise<SessionId> {
  const out = captureOutput();
  try {
    await withCwd(root, () => runStart(id, { harness: "codex", json: true }));
    return (JSON.parse(out.stdout()) as { session: { id: SessionId } }).session.id;
  } finally {
    out.restore();
  }
}

describe("runUpdate (in-process)", () => {
  it("resolves mixed edge and local-parent refs in one ordered transaction-local batch", async () => {
    const root = await makeTempRepo("slop-update-inproc-snapshot-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const mainId = await jsonNewTicket(root, "Snapshot main");
    const relatedId = await jsonNewTicket(root, "Snapshot related");
    const blockerId = await jsonNewTicket(root, "Snapshot blocker");
    const originId = await jsonNewTicket(root, "Snapshot origin");
    const parentId = await jsonNewTicket(root, "Snapshot parent");
    const paths = repoPaths(root);
    const related = await readTicket(paths, relatedId);
    const blocker = await readTicket(paths, blockerId);
    const parent = await readTicket(paths, parentId);

    const batchSpy = vi.spyOn(FlatfileBackend.prototype, "resolveTicketRefs");
    const singleSpy = vi.spyOn(FlatfileBackend.prototype, "resolveTicketRef");
    const listSpy = vi.spyOn(FlatfileBackend.prototype, "listTickets");
    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runUpdate(
          [mainId],
          baseOpts({
            relatesTo: [`+${related.slug}`, `+${relatedId}`],
            blocks: [`+${blocker.slug}`],
            discoveredFrom: [`+${originId}`],
            parent: parent.slug,
          }),
        ),
      );
    } finally {
      out.restore();
    }

    expect(singleSpy).toHaveBeenCalledExactlyOnceWith(mainId);
    expect(batchSpy).toHaveBeenCalledExactlyOnceWith([
      related.slug,
      relatedId,
      blocker.slug,
      originId,
      parent.slug,
    ]);
    expect(listSpy).toHaveBeenCalledTimes(1);
    const updated = await readTicket(paths, mainId);
    expect(updated.relates_to).toEqual([relatedId]);
    expect(updated.blocks).toEqual([blockerId]);
    expect(updated.discovered_from).toEqual([originId]);
    expect(updated.parent).toBe(parentId);

    batchSpy.mockRestore();
    singleSpy.mockRestore();
    listSpy.mockRestore();
  });

  it("a pure --progress call appends a note event without taking the lock or rewriting the ticket file", async () => {
    const root = await makeTempRepo("slop-update-inproc-progress-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Progress-only ticket");
    const paths = repoPaths(root);
    const before = await readTicket(paths, id);

    const out = captureOutput();
    try {
      await withCwd(root, () => runUpdate([id], baseOpts({ progress: "made some headway" })));
      expect(out.stdout()).toContain(`updated ${id}`);
    } finally {
      out.restore();
    }
    const after = await readTicket(paths, id);
    expect(after).toEqual(before); // never rewritten — pure progress is event-only
    const events = await queryEvents(paths, { ticket: id });
    expect(events.some((e) => e.payload.progress === "made some headway")).toBe(true);
  });

  it("attributes lock-free progress and locked field updates to the active session, while open-ticket updates stay null", async () => {
    const root = await makeTempRepo("slop-update-inproc-session-context-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const active = await jsonNewTicket(root, "Active update ticket");
    const open = await jsonNewTicket(root, "Open update ticket");
    const session = await jsonStartTicket(root, active);

    for (const [refs, opts] of [
      [[active], baseOpts({ progress: "session progress" })],
      [[active], baseOpts({ priority: 1 })],
      [[open], baseOpts({ priority: 1 })],
    ] as const) {
      const out = captureOutput();
      try {
        await withCwd(root, () => runUpdate([...refs], opts));
      } finally {
        out.restore();
      }
    }

    const paths = repoPaths(root);
    const activeEvents = await queryEvents(paths, { ticket: active });
    expect(activeEvents.find((e) => e.payload.progress === "session progress")?.session).toBe(
      session,
    );
    expect(activeEvents.findLast((e) => e.verb === "ticket.updated")?.session).toBe(session);
    const openEvents = await queryEvents(paths, { ticket: open });
    expect(openEvents.findLast((e) => e.verb === "ticket.updated")?.session).toBeNull();
  });

  it("bulk updates retain each ticket's distinct active session", async () => {
    const root = await makeTempRepo("slop-update-inproc-bulk-sessions-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const first = await jsonNewTicket(root, "First bulk session ticket");
    const second = await jsonNewTicket(root, "Second bulk session ticket");
    const firstSession = await jsonStartTicket(root, first);
    const secondSession = await jsonStartTicket(root, second);

    const out = captureOutput();
    try {
      await withCwd(root, () => runUpdate([first, second], baseOpts({ priority: 1 })));
    } finally {
      out.restore();
    }

    const paths = repoPaths(root);
    const firstEvent = (await queryEvents(paths, { ticket: first })).findLast(
      (e) => e.verb === "ticket.updated",
    );
    const secondEvent = (await queryEvents(paths, { ticket: second })).findLast(
      (e) => e.verb === "ticket.updated",
    );
    expect(firstEvent?.session).toBe(firstSession);
    expect(secondEvent?.session).toBe(secondSession);
    expect(firstEvent?.session).not.toBe(secondEvent?.session);
  });

  it("a reparent attributes the root and every descendant cascade to that ticket's own active session", async () => {
    const root = await makeTempRepo("slop-update-inproc-reparent-sessions-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const oldParent = await jsonNewTicket(root, "Old ancestry root");
    const newParent = await jsonNewTicket(root, "New ancestry root");
    const child = await jsonNewTicket(root, "Reparented child", { parent: oldParent });
    const grandchild = await jsonNewTicket(root, "Cascaded grandchild", { parent: child });
    const childSession = await jsonStartTicket(root, child);
    const grandchildSession = await jsonStartTicket(root, grandchild);

    const out = captureOutput();
    try {
      await withCwd(root, () => runUpdate([child], baseOpts({ parent: newParent })));
    } finally {
      out.restore();
    }

    const paths = repoPaths(root);
    const childEvent = (await queryEvents(paths, { ticket: child })).findLast(
      (e) => e.verb === "ticket.updated",
    );
    const cascadeEvent = (await queryEvents(paths, { ticket: grandchild })).findLast(
      (e) => e.payload.reparent_root === child,
    );
    expect(childEvent?.session).toBe(childSession);
    expect(cascadeEvent?.session).toBe(grandchildSession);
  });

  it("--priority changes the stored priority", async () => {
    const root = await makeTempRepo("slop-update-inproc-priority-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Priority ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runUpdate([id], baseOpts({ priority: 0 })));
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).priority).toBe(0);
  });

  // closing-loop-commands-lack-json
  it("--json returns a stable shape (id/slug/handle/name/state/priority) on the full read-modify-write path", async () => {
    const root = await makeTempRepo("slop-update-inproc-json-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "JSON update ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runUpdate([id], baseOpts({ priority: 0, json: true })));
      const body = JSON.parse(out.stdout()) as {
        id: TicketId;
        slug: string;
        handle: string;
        name: string;
        state: string;
        priority: number;
      };
      expect(body.id).toBe(id);
      expect(body.priority).toBe(0);
      expect(body.handle).toMatch(/^t-/);
    } finally {
      out.restore();
    }
  });

  // closing-loop-commands-lack-json: the lock-free PURE --progress path
  // (ticket_01KY9RWFM80BKNE2CDX85QMKGS) is a separate early return in
  // runUpdate — must also honor --json, not just the locked path above.
  it("--json also works on the lock-free pure --progress path", async () => {
    const root = await makeTempRepo("slop-update-inproc-json-progress-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "JSON progress ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runUpdate([id], baseOpts({ progress: "headway via json", json: true })),
      );
      const body = JSON.parse(out.stdout()) as { id: TicketId; state: string };
      expect(body.id).toBe(id);
      expect(body.state).toBe("open");
    } finally {
      out.restore();
    }
  });

  it("--label +x adds a label; a later --label -x removes it", async () => {
    const root = await makeTempRepo("slop-update-inproc-label-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Label ticket");
    const paths = repoPaths(root);

    const out1 = captureOutput();
    try {
      await withCwd(root, () => runUpdate([id], baseOpts({ label: ["+urgent"] })));
    } finally {
      out1.restore();
    }
    expect((await readTicket(paths, id)).labels).toContain("urgent");

    const out2 = captureOutput();
    try {
      await withCwd(root, () => runUpdate([id], baseOpts({ label: ["-urgent"] })));
    } finally {
      out2.restore();
    }
    expect((await readTicket(paths, id)).labels).not.toContain("urgent");
  });

  it("--relates-to +<ref> adds a symmetric relates-to edge, validated via validateTicketEdges", async () => {
    const root = await makeTempRepo("slop-update-inproc-relates-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Main ticket");
    const target = await jsonNewTicket(root, "Related target");

    const out = captureOutput();
    try {
      await withCwd(root, () => runUpdate([id], baseOpts({ relatesTo: [`+${target}`] })));
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).relates_to).toContain(target);
  });

  it("a fully redundant patch (no-op) writes nothing: no lock write, no event", async () => {
    const root = await makeTempRepo("slop-update-inproc-noop-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "No-op update ticket");
    const paths = repoPaths(root);
    const before = await readTicket(paths, id);
    const eventsBefore = await queryEvents(paths, { ticket: id });

    const out = captureOutput();
    try {
      // Same priority the ticket already has (default 2) — nothing changes.
      await withCwd(root, () => runUpdate([id], baseOpts({ priority: 2 })));
    } finally {
      out.restore();
    }
    const after = await readTicket(paths, id);
    expect(after).toEqual(before);
    const eventsAfter = await queryEvents(paths, { ticket: id });
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });

  it("throws NOT_FOUND for an unresolvable --relates-to target", async () => {
    const root = await makeTempRepo("slop-update-inproc-badrelates-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Ticket with bad relates-to");

    const out = captureOutput();
    try {
      await expect(
        withCwd(root, () => runUpdate([id], baseOpts({ relatesTo: ["+no-such-ticket"] }))),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
    } finally {
      out.restore();
    }
  });

  it("throws NOT_FOUND for an unresolvable <ref>", async () => {
    const root = await makeTempRepo("slop-update-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const out = captureOutput();
    try {
      await expect(
        withCwd(root, () => runUpdate(["no-such-ticket"], baseOpts({ priority: 1 }))),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
    } finally {
      out.restore();
    }
  });
});
