import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { TicketId } from "../../core/index.js";
import { listSessions, readTicket, repoPaths } from "../../repo/index.js";

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
