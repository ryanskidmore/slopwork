import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { TicketId } from "../../core/index.js";
import { listSessions, readTicket, repoPaths } from "../../repo/index.js";

// Regression test for ticket_01KY93E2BKH5JCMAV3JWPNN63G — see
// update.test.ts's module doc for the full bug description. This file
// covers `draft`'s half: it used to read the ticket OUTSIDE any lock, so
// racing a concurrent `start` (which DOES lock + re-read) could silently
// revert start's already-committed transition back to "draft" — leaving
// a freshly created, still-active session file that the ticket no longer
// points at (an orphaned session), which is strictly worse than the
// ordinary "one of two racers loses" outcome a correct lock produces.

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
  const dir = await mkdtemp(join(tmpdir(), "slop-draft-race-"));
  scratchDirs.push(dir);
  const init = mustRunSlopSource(
    ["init", "--yes", "--project", "draft-race-fixture", "--user", "ryan"],
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

describe("draft: race against a concurrent lock-holding mutator (regression, ticket_01KY93E2BKH5JCMAV3JWPNN63G)", () => {
  it("`draft` racing `start`, on a real repo: exactly one wins the race, the other fails cleanly with CONFLICT (exit 6) — never a corrupted ticket, and never a started session the ticket no longer points at", async () => {
    // Whether draft's single unlocked write happens to land INSIDE
    // start's own read-modify-write window (the interleaving that
    // actually trips the bug) is timing-sensitive — a single attempt
    // can pass vacuously if the two processes happen to fully
    // serialize on this machine/run. Repeating the race across several
    // independent tickets makes a genuine violation overwhelmingly
    // likely to surface pre-fix, while staying 100% deterministic
    // post-fix (the invariant below holds unconditionally once both
    // commands share the lock and re-read fresh).
    const ATTEMPTS = 6;
    const { dir } = await makeCliRepo();
    let sawOverlap = false;

    for (let i = 0; i < ATTEMPTS; i++) {
      const ticket = newTicketCli(dir, "ryan", `Draft vs start race ${i}`);

      const procA = spawn("bun", [cliEntry, "draft", ticket.slug], {
        cwd: dir,
        env: slopEnv({ SLOP_ACTOR: "drafter" }),
      });
      const procB = spawn("bun", [cliEntry, "start", ticket.slug], {
        cwd: dir,
        env: slopEnv({ SLOP_ACTOR: "starter" }),
      });
      const [resA, resB] = await Promise.all([collect(procA), collect(procB)]);

      if (hasGenuineOverlap([resA, resB])) sawOverlap = true;

      // The two edges are mutually exclusive (a draft ticket can't be
      // started, a started ticket can't be drafted), so a correct lock
      // means exactly one succeeds — the other must fail LOUDLY (exit
      // 6, CONFLICT) rather than be silently accepted over corrupted
      // state.
      const codes = [resA.code, resB.code].sort((a, b) => (a ?? -1) - (b ?? -1));
      expect(
        codes,
        `attempt ${i}: draft stderr=${resA.stderr} start stderr=${resB.stderr}`,
      ).toEqual([0, 6]);

      const paths = repoPaths(dir);
      const finalTicket = await readTicket(paths, ticket.id);
      const sessions = await listSessions(paths);
      const ticketSessions = sessions.filter((s) => s.ticket === ticket.id);

      if (resB.code === 0) {
        // start won: the ticket is genuinely in_progress with a live,
        // non-orphaned session — draft's loss must NOT have reverted
        // any of it.
        expect(finalTicket.state, `attempt ${i}`).toBe("in_progress");
        expect(finalTicket.active_session, `attempt ${i}`).not.toBeNull();
        expect(ticketSessions, `attempt ${i}`).toHaveLength(1);
        expect(ticketSessions[0]?.id, `attempt ${i}`).toBe(finalTicket.active_session);
        expect(ticketSessions[0]?.ended_at, `attempt ${i}`).toBeNull();
        expect(resA.code, `attempt ${i}: draft should have lost cleanly: ${resA.stderr}`).toBe(6);
        expect(resA.stderr, `attempt ${i}`).toMatch(/cannot draft/i);
      } else {
        // draft won: the ticket is draft, no session was ever created
        // (assertStartable rejects a draft ticket before any session
        // file is written), and start's own failure names the
        // ticket's state.
        expect(finalTicket.state, `attempt ${i}`).toBe("draft");
        expect(finalTicket.active_session, `attempt ${i}`).toBeNull();
        expect(ticketSessions, `attempt ${i}`).toHaveLength(0);
        expect(resB.code, `attempt ${i}: start should have lost cleanly: ${resB.stderr}`).toBe(6);
        expect(resB.stderr, `attempt ${i}`).toMatch(/draft/i);
      }
    }

    expect(
      sawOverlap,
      "no attempt's draft/start pair overlapped in wall-clock time — this run could pass vacuously off accidental serialisation",
    ).toBe(true);
  }, 60_000);
});
