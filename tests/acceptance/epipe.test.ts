import { type SpawnSyncReturns, execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../src/core/exit-codes.js";

// EPIPE: a downstream reader closing `slop`'s stdout early (`slop ready |
// head -1`, `slop show <ref> | less` then quitting, `slop events | head`,
// ...) must be treated as a normal "reader went away" signal, not crash the
// process. Before src/cli/index.ts's `installEpipeGuards()`, writing
// further output to the closed pipe threw an unhandled EPIPE that Bun
// dumped as a raw stack trace (plus a "Bun vX.Y.Z" banner) on stderr, and
// exited 1 — even though the command's actual work had already succeeded.
//
// Spawns the real compiled `dist/slop` binary (never source, never a
// function-level shortcut) — this project's established convention for
// anything that must be exercised as a genuine process (see A1.test.ts,
// E1.test.ts, DECISIONS.md's D5: vitest workers are Node, not Bun, and
// EPIPE is specifically about real OS pipe/stream semantics no in-process
// mock can stand in for).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
  // Robust about build ordering, same as A1.test.ts/E1.test.ts.
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

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function runSlop(args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(binaryPath, args, { cwd, encoding: "utf8" });
}

async function makeCliFixture(project: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "slop-epipe-"));
  scratchDirs.push(root);
  const init = runSlop(["init", "--yes", "--project", project, "--user", "epipe-tester"], root);
  expect(init.status, init.stderr).toBe(0);
  return root;
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

function newTicketCli(root: string, name: string): { id: string; slug: string } {
  const result = runSlop(["new", name], root);
  expect(result.status, result.stderr).toBe(0);
  const m = CREATED_LINE.exec(result.stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(
      `could not parse "created <id> (slug: <slug>)" out of stdout:\n${result.stdout}`,
    );
  }
  return { id: m[1], slug: m[2] };
}

/** Single-quote shell-escaping. Every arg this file passes is a plain
 * slug/word, but quote defensively rather than assume. */
function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs `<binaryPath> <args>` with stdout piped into a reader that closes
 * immediately without reading anything (`| true`), then reports `slop`'s
 * own exit code via bash's `PIPESTATUS` (a bare `sh -c '... | head -1'`'s
 * `$?` reflects the *last* pipeline command, not `slop` — bash-specific,
 * hence spawning `bash` explicitly rather than `sh`).
 *
 * `| true` rather than `| head -1`: verified empirically (see this fix's
 * manual repro) that `head -1` is racy here whenever a command's output is
 * small — `head` can finish reading and exit before `slop` even calls
 * write(), so no EPIPE occurs at all and the run silently "passes" whether
 * or not the bug is fixed. `true` never reads its stdin at all, so by the
 * time `slop` performs any write the pipe's read end is already fully
 * closed, deterministically forcing EPIPE on the very first write
 * regardless of output size — the robust, non-flaky repro this suite
 * needs.
 */
function runSlopThroughClosedPipe(args: string[], cwd: string): SpawnSyncReturns<string> {
  const script = `${shQuote(binaryPath)} ${args.map(shQuote).join(" ")} | true; exit "\${PIPESTATUS[0]}"`;
  return spawnSync("bash", ["-c", script], { cwd, encoding: "utf8" });
}

/** Neither an EPIPE message nor Bun's raw unhandled-exception dump (stack
 * frames + the "Bun vX.Y.Z (platform)" banner) may appear on stderr. */
function expectNoCrashDump(stderr: string): void {
  expect(stderr).not.toMatch(/EPIPE/);
  expect(stderr).not.toMatch(/Bun v\d/);
  expect(stderr).not.toMatch(/broken pipe/i);
}

describe("EPIPE: a downstream reader closing stdout early does not crash `slop`", () => {
  async function makeMultiLineFixture(project: string): Promise<{ root: string; slug: string }> {
    const root = await makeCliFixture(project);
    let slug = "";
    for (let i = 0; i < 8; i++) {
      const ticket = newTicketCli(root, `epipe matrix ticket ${i}`);
      if (i === 0) slug = ticket.slug;
    }
    return { root, slug };
  }

  it("events: exits cleanly with no EPIPE/stack-trace text on stderr when the pipe closes early", async () => {
    const { root } = await makeMultiLineFixture("epipe-events");

    // Sanity: confirm this is genuinely a multi-line-output command against
    // this fixture before asserting anything about the piped case.
    const full = runSlop(["events"], root);
    expect(full.status, full.stderr).toBe(0);
    expect(full.stdout.split("\n").filter(Boolean).length).toBeGreaterThan(1);

    const piped = runSlopThroughClosedPipe(["events"], root);
    expect(piped.status, `stderr:\n${piped.stderr}`).toBe(EXIT_CODES.SUCCESS);
    expectNoCrashDump(piped.stderr);
  });

  it("plan: exits cleanly with no EPIPE/stack-trace text on stderr when the pipe closes early", async () => {
    const { root, slug } = await makeMultiLineFixture("epipe-plan");
    expect(runSlop(["start", slug], root).status).toBe(0);

    const steps = Array.from({ length: 40 }, (_, i) => `step ${i}: do the thing`);

    // Sanity: a real (unpiped) `plan` call against this fixture prints a
    // header plus one line per step.
    const full = runSlop(["plan", slug, ...steps], root);
    expect(full.status, full.stderr).toBe(0);
    expect(full.stdout.split("\n").filter(Boolean).length).toBeGreaterThan(steps.length);

    // A second `plan` call (revising the same steps) is the one piped
    // through the closed reader, so it hits the same "write a plan +
    // header" code path the sanity check above just confirmed is
    // multi-line.
    const piped = runSlopThroughClosedPipe(["plan", slug, ...steps], root);
    expect(piped.status, `stderr:\n${piped.stderr}`).toBe(EXIT_CODES.SUCCESS);
    expectNoCrashDump(piped.stderr);
  });

  it("ready: exits cleanly with no EPIPE/stack-trace text on stderr when the pipe closes early", async () => {
    const { root } = await makeMultiLineFixture("epipe-ready");

    const full = runSlop(["ready"], root);
    expect(full.status, full.stderr).toBe(0);
    expect(full.stdout.split("\n").filter(Boolean).length).toBeGreaterThan(1);

    const piped = runSlopThroughClosedPipe(["ready"], root);
    expect(piped.status, `stderr:\n${piped.stderr}`).toBe(EXIT_CODES.SUCCESS);
    expectNoCrashDump(piped.stderr);
  });

  it("show: exits cleanly with no EPIPE/stack-trace text on stderr when the pipe closes early", async () => {
    const { root, slug } = await makeMultiLineFixture("epipe-show");

    const full = runSlop(["show", slug], root);
    expect(full.status, full.stderr).toBe(0);
    expect(full.stdout.split("\n").filter(Boolean).length).toBeGreaterThan(1);

    const piped = runSlopThroughClosedPipe(["show", slug], root);
    expect(piped.status, `stderr:\n${piped.stderr}`).toBe(EXIT_CODES.SUCCESS);
    expectNoCrashDump(piped.stderr);
  });

  it("does not swallow a genuine command failure: a NOT_FOUND ref piped through a closed reader still exits 4, not 0", async () => {
    const { root } = await makeMultiLineFixture("epipe-genuine-error");

    // `show` on an unresolvable ref never writes anything to stdout — the
    // error goes to stderr, a stream this pipe never touches — so the
    // EPIPE guard installed on stdout must have no bearing on this run's
    // exit code at all.
    const piped = runSlopThroughClosedPipe(["show", "no-such-ticket-anywhere"], root);
    expect(piped.status, `stderr:\n${piped.stderr}`).toBe(EXIT_CODES.NOT_FOUND);
    expect(piped.stderr).toMatch(/no ticket found/);
  });
});
