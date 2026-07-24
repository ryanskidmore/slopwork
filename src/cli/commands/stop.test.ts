import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import { END_SUMMARY_MAX_LENGTH } from "../../core/index.js";
import type { TicketId } from "../../core/index.js";
import type { RepoPaths } from "../../repo/index.js";
import { readTicket, repoPaths } from "../../repo/index.js";
import { runNew } from "./new.js";
import { runStart } from "./start.js";
import { runStop } from "./stop.js";

// Fix 1 (ticket_01KY93E2ZK6Z3TFEBP86ATMW37): captureTranscript's
// locate+copy must run OUTSIDE the db lock (`.slop/db/.lock`, ONE file
// shared by the whole repo — see repo/paths.ts's `lockFile` — not
// per-ticket), so a slow/large transcript capture on one ticket never
// starves a concurrent command on a totally DIFFERENT ticket into a
// lock-acquire CONFLICT (lock.ts's default 5s `withLock` timeout).
//
// Exercised here as two REAL processes spawned from SOURCE (`bun
// src/cli/index.ts ...`, mirroring tests/acceptance/C4.test.ts's spawn
// style but without the compiled `dist/slop` binary), racing for the
// same repo-global lock. "Large transcript" is simulated deterministically
// via transcript.ts's test-only `SLOP_TEST_TRANSCRIPT_COPY_DELAY_MS` knob
// (mirrors atomic-write.ts's own `SLOP_TEST_ATOMIC_WRITE_DELAY_MS`
// convention) rather than actually writing a tens-of-MB fixture — a real
// multi-MB file copies far faster on local disk/tmpfs than any genuine
// harness transcript directory would, so a size-based test alone
// wouldn't reliably distinguish "ran outside the lock" from "ran inside
// it but finished before the 5s timeout anyway".

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

/** Every harness-identity env var a real harness sets, stripped by
 * default — see tests/acceptance/C4.test.ts's identical rationale: this
 * suite must not accidentally inherit a real CLAUDECODE=1 (or similar)
 * from its own ambient environment, which would make harness detection
 * non-deterministic here. */
const STRIPPED_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "OPENCODE",
  "OPENCODE_PID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_HOME",
  "SLOP_TEST_CLAUDE_HOME",
] as const;

function slopEnv(
  overrides: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, SLOP_ACTOR: "stop-test-actor" };
  for (const key of STRIPPED_ENV_KEYS) env[key] = undefined;
  for (const [k, v] of Object.entries(overrides)) env[k] = v;
  return env;
}

function runSlopSync(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  return spawnSync("bun", [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    env: slopEnv(envOverrides),
  });
}

interface AsyncRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Non-blocking spawn — needed to actually race two `slop` invocations
 * against each other, which `spawnSync` (blocking) cannot do. */
function runSlopAsync(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string | undefined> = {},
): Promise<AsyncRunResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [cliEntry, ...args], { cwd, env: slopEnv(envOverrides) });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeFixtureRepo(): Promise<{ root: string; paths: RepoPaths }> {
  const root = await mkdtemp(join(tmpdir(), "slop-stop-lock-test-"));
  scratchDirs.push(root);
  const init = runSlopSync(
    ["init", "--yes", "--project", "stop-lock-fixture", "--user", "ryan"],
    root,
  );
  expect(init.status, init.stderr).toBe(0);
  return { root, paths: repoPaths(root) };
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

function newTicket(root: string, name: string): { id: TicketId; slug: string } {
  const result = runSlopSync(["new", name], root);
  expect(result.status, result.stderr).toBe(0);
  const m = CREATED_LINE.exec(result.stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(
      `could not parse "created <id> (slug: <slug>)" out of stdout:\n${result.stdout}`,
    );
  }
  return { id: m[1] as TicketId, slug: m[2] };
}

describe("stop — Fix 1 (ticket_01KY93E2ZK6Z3TFEBP86ATMW37): transcript capture runs OUTSIDE the db lock", () => {
  it("a slow transcript capture on ticket A does not starve a concurrent `stop` on a DIFFERENT ticket B into a lock-acquire CONFLICT", async () => {
    const { root, paths } = await makeFixtureRepo();
    const ticketA = newTicket(root, "Ticket A (slow transcript)");
    const ticketB = newTicket(root, "Ticket B (must stay fast)");

    const transcriptFile = join(root, "transcript-a.jsonl");
    // Content is small on purpose — the artificial copy delay below is
    // what stands in for "a genuinely large transcript taking real
    // wall-clock time to stream", not file size.
    await writeFile(transcriptFile, '{"hello":"world"}\n', "utf8");

    const startedA = runSlopSync(["start", ticketA.slug], root);
    expect(startedA.status, startedA.stderr).toBe(0);
    const startedB = runSlopSync(["start", ticketB.slug], root);
    expect(startedB.status, startedB.stderr).toBe(0);

    // Fire ticket A's `stop` WITHOUT awaiting it — its transcript copy is
    // artificially slowed to 6s, deliberately LONGER than lock.ts's
    // default 5s `withLock` acquire timeout, so the OLD (buggy) behaviour
    // of running the copy inside the lock would reliably starve ticket
    // B's own `stop` below into a CONFLICT.
    const stopAPromise = runSlopAsync(
      ["stop", ticketA.slug, "--transcript", transcriptFile],
      root,
      {
        SLOP_TEST_TRANSCRIPT_COPY_DELAY_MS: "6000",
      },
    );

    // Give A a moment to actually get moving (in the fixed code: reach
    // and start its UNLOCKED speculative capture) before racing ticket
    // B's own `stop` for the same repo-global `.slop/db/.lock`.
    await new Promise((r) => setTimeout(r, 300));

    const stoppedB = await runSlopAsync(["stop", ticketB.slug, "--note", "b done"], root);

    // The load-bearing assertions: B must not have been starved by A's
    // still-in-flight slow capture — no lock-timeout CONFLICT, exit 0,
    // and comfortably faster than lock.ts's 5s default timeout (with the
    // fix this is typically well under a second; the old, buggy "capture
    // inside the lock" behaviour would instead have B block for ~5s and
    // then fail).
    expect(stoppedB.stderr).not.toMatch(/timed out waiting for the db lock/i);
    expect(stoppedB.status, `ticket B's stop:\n${stoppedB.stderr}`).toBe(0);
    expect(stoppedB.durationMs).toBeLessThan(4000);

    const stoppedA = await stopAPromise;
    expect(stoppedA.status, `ticket A's stop:\n${stoppedA.stderr}`).toBe(0);
    expect(stoppedA.stderr).not.toMatch(/could not locate a transcript/i);

    // Correctness, not just speed: both tickets/sessions still end up in
    // the expected final state once everything settles.
    const ticketARead = await readTicket(paths, ticketA.id);
    const ticketBRead = await readTicket(paths, ticketB.id);
    expect(ticketARead.state).toBe("open");
    expect(ticketBRead.state).toBe("open");
    expect(stoppedA.stdout).toContain("transcripts/");
  }, 15_000);
});

// ---------------------------------------------------------------------------
// In-process coverage of `runStop` (real v8 coverage, no subprocess).
// ---------------------------------------------------------------------------

async function jsonNewTicket(root: string, name: string): Promise<TicketId> {
  const out = captureOutput();
  try {
    await withCwd(root, () => runNew(name, { blocks: [], relatesTo: [], label: [], json: true }));
    return (JSON.parse(out.stdout()) as { id: TicketId }).id;
  } finally {
    out.restore();
  }
}

describe("runStop (in-process)", () => {
  it("stops an in_progress session, returning the ticket to open with a handoff note", async () => {
    const root = await makeTempRepo("slop-stop-inproc-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "In-progress ticket to stop");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runStop(id, { note: "handing off, see notes" }));
      expect(out.stdout()).toContain("handoff note: handing off, see notes");
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    const ticket = await readTicket(paths, id);
    expect(ticket.state).toBe("open");
    expect(ticket.active_session).toBeNull();
  });

  it("warns on stderr when --note is omitted, but still succeeds", async () => {
    const root = await makeTempRepo("slop-stop-inproc-nonote-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "No-note stop ticket");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runStop(id, {}));
      expect(out.stderr()).toMatch(/no --note handoff given/);
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).state).toBe("open");
  });

  it("refuses to stop a ticket with no active session (CONFLICT-shaped assertStoppable failure)", async () => {
    const root = await makeTempRepo("slop-stop-inproc-noactive-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Never started ticket");

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runStop(id, {}))).rejects.toThrow();
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).state).toBe("open");
  });

  it("throws NOT_FOUND for an unresolvable ref", async () => {
    const root = await makeTempRepo("slop-stop-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runStop("no-such-ticket", {}))).rejects.toMatchObject({
        exitCode: EXIT_CODES.NOT_FOUND,
      });
    } finally {
      out.restore();
    }
  });

  it("rejects a --note over the max length with USAGE_ERROR (exit 2), never touching the session/ticket (regression: ticket housekeeping-gitignore-lock-stale)", async () => {
    const root = await makeTempRepo("slop-stop-inproc-toolong-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "In-progress ticket, absurdly long note");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }

    const tooLong = "x".repeat(END_SUMMARY_MAX_LENGTH + 1);
    await expect(withCwd(root, () => runStop(id, { note: tooLong }))).rejects.toMatchObject({
      exitCode: EXIT_CODES.USAGE_ERROR,
    });

    const paths = repoPaths(root);
    const ticket = await readTicket(paths, id);
    expect(ticket.state).toBe("in_progress"); // untouched — rejected before any write
  });
});
