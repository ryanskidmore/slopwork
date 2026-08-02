/**
 * t-ebgqb reproduction + regression harness: "does the test suite stay
 * green when N agents run it at the same time, each in their OWN worktree?"
 *
 * This is the acceptance-criterion-shaped tool (see the ticket): creates N
 * throwaway `git worktree`s of this repo off a given ref, builds each one,
 * then launches `bun run <cmd>` in all of them AT THE SAME TIME (real
 * concurrent OS processes, not staggered), captures full output + timing
 * per worktree, samples system load/memory throughout, and diffs the
 * kernel ring buffer (`dmesg`) across the run for OOM-killer activity.
 * Repeats the concurrent phase `--repeat` times back-to-back against the
 * SAME prepared worktrees, which is exactly Phase 3's proof bar.
 *
 * Usage:
 *   bun bench/concurrent-repro.ts --n 3 --cmd test --repeat 2
 *   bun bench/concurrent-repro.ts --n 3 --cmd test:coverage --ref main
 *   bun bench/concurrent-repro.ts --n 2 --cmd test --keep --out bench/repro-results.json
 *
 * Flags:
 *   --n N           number of concurrent worktrees (default 3)
 *   --cmd NAME      package.json script to race, e.g. test | test:coverage (default "test")
 *   --ref REF       git ref to check out into each worktree (default: current branch)
 *   --repeat N      run the concurrent phase this many times back-to-back,
 *                   reusing the same prepared worktrees each time (default 2)
 *   --base-dir PATH parent directory for the throwaway worktrees (default:
 *                   ~/.cache/slop-concurrency-bench — deliberately NOT under
 *                   /tmp, which on this machine is a size-capped tmpfs; see
 *                   the tmpfs-pressure finding this ticket's evidence turned up)
 *   --keep          don't remove the worktrees/branches afterward (for post-mortem)
 *   --out PATH      write full JSON results here
 *   --perf-scale N  sets SLOP_TEST_PERF_SCALE (see tests/support/perf-scale.ts)
 *                   in every spawned worktree run — real-wall-clock
 *                   performance budgets (e.g. D4.test.ts's spawned `status`
 *                   timing) are widened by this factor, since this harness's
 *                   own point is racing N full-suite runs against each other
 *                   (unset by default = exactly today's strict budgets)
 *
 * Exit code is non-zero if any worktree, in any round, exited non-zero.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, appendFile } from "node:fs/promises";
import { loadavg, freemem, totalmem, cpus, platform, release, homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const HERE = import.meta.dir;
const REPO_ROOT = join(HERE, "..");

interface Args {
  n: number;
  cmd: string;
  ref: string;
  repeat: number;
  baseDir: string;
  keep: boolean;
  out: string | null;
  perfScale: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const currentBranch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).stdout.trim();
  return {
    n: Number.parseInt(get("--n") ?? "3", 10),
    cmd: get("--cmd") ?? "test",
    ref: get("--ref") ?? currentBranch,
    repeat: Number.parseInt(get("--repeat") ?? "2", 10),
    baseDir: get("--base-dir") ?? join(homedir(), ".cache", "slop-concurrency-bench"),
    keep: argv.includes("--keep"),
    out: get("--out") ?? null,
    perfScale: get("--perf-scale") ?? null,
  };
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function fsTypeOf(dir: string): string {
  const out = spawnSync("df", ["-T", dir], { encoding: "utf8" }).stdout?.trim().split("\n").pop();
  return out?.split(/\s+/)[1] ?? "unknown";
}

function dmesgTail(lines = 200): string[] {
  const r = spawnSync("dmesg", ["-T"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.trim().split("\n").slice(-lines);
}

interface Worktree {
  index: number;
  path: string;
  branch: string;
}

async function createWorktrees(args: Args, runId: string): Promise<Worktree[]> {
  await mkdir(args.baseDir, { recursive: true });
  const worktrees: Worktree[] = [];
  for (let i = 0; i < args.n; i++) {
    const path = join(args.baseDir, `wt-${runId}-${i}`);
    const branch = `slop-concurrency-repro/${runId}-${i}`;
    log(`creating worktree ${i}: ${path} (branch ${branch}, from ${args.ref})`);
    const r = spawnSync("git", ["worktree", "add", "-b", branch, path, args.ref], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (r.status !== 0) {
      throw new Error(`git worktree add failed for wt ${i}:\n${r.stdout}\n${r.stderr}`);
    }
    worktrees.push({ index: i, path, branch });
  }
  return worktrees;
}

async function removeWorktrees(worktrees: Worktree[]): Promise<void> {
  for (const wt of worktrees) {
    log(`removing worktree ${wt.index}: ${wt.path}`);
    spawnSync("git", ["worktree", "remove", "--force", wt.path], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    spawnSync("git", ["branch", "-D", wt.branch], { cwd: REPO_ROOT, encoding: "utf8" });
  }
  // `git worktree remove` can leave the administrative record behind if the
  // directory was already gone/partial; prune so `git worktree list` stays clean.
  spawnSync("git", ["worktree", "prune"], { cwd: REPO_ROOT, encoding: "utf8" });
}

interface PrepResult {
  index: number;
  ok: boolean;
  installMs: number;
  buildMs: number;
  error?: string;
}

/** Sequential on purpose: this harness measures contention during the
 * MEASURED (test-run) phase specifically, so prep (install/build) is kept
 * out of that measurement window entirely. */
async function prepWorktree(wt: Worktree): Promise<PrepResult> {
  const t0 = performance.now();
  const install = spawnSync("bun", ["install"], { cwd: wt.path, encoding: "utf8" });
  const installMs = performance.now() - t0;
  if (install.status !== 0) {
    return {
      index: wt.index,
      ok: false,
      installMs,
      buildMs: 0,
      error: `bun install failed:\n${install.stderr}`,
    };
  }
  const t1 = performance.now();
  const build = spawnSync("bun", ["run", "build"], { cwd: wt.path, encoding: "utf8" });
  const buildMs = performance.now() - t1;
  if (build.status !== 0) {
    return {
      index: wt.index,
      ok: false,
      installMs,
      buildMs,
      error: `bun run build failed:\n${build.stderr}`,
    };
  }
  return { index: wt.index, ok: true, installMs, buildMs };
}

interface SystemSample {
  tMs: number;
  loadavg: number[];
  freeMemMB: number;
}

interface WorktreeRunResult {
  index: number;
  path: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  testFilesLine: string | null;
  failureSignatures: string[];
  logPath: string;
}

const ANOMALY_PATTERNS: [string, RegExp][] = [
  ["EADDRINUSE / port collision", /EADDRINUSE|already in use|PortInUseError/],
  ["ENOMEM (out of memory, fork/alloc)", /ENOMEM/],
  ["EAGAIN (resource temporarily unavailable, usually fork under pressure)", /EAGAIN/],
  ["spawnSync status:null", /status:\s*null|"status":\s*null/],
  ["SIGKILL / Killed (likely OOM-killer)", /SIGKILL|\bKilled\b/],
  ["ENOSPC (no space left on device)", /ENOSPC/],
  ["ECONNREFUSED (server not up in time)", /ECONNREFUSED/],
  ["sandbox guard violation (.slop/ touched)", /SANDBOX VIOLATION/],
  ["test timeout", /Test timed out|hook timed out/i],
  [
    "real-wall-clock perf-budget assertion (consider SLOP_TEST_PERF_SCALE, see --perf-scale)",
    /AssertionError: expected [\d.]+ to be less than \d/,
  ],
];

function classifyFailures(output: string): string[] {
  const hits: string[] = [];
  for (const [label, pattern] of ANOMALY_PATTERNS) {
    if (pattern.test(output)) hits.push(label);
  }
  return hits;
}

async function runOneWorktree(
  wt: Worktree,
  args: Args,
  logDir: string,
  round: number,
): Promise<WorktreeRunResult> {
  const logPath = join(logDir, `wt-${wt.index}-round-${round}.log`);
  let buffer = "";
  const t0 = performance.now();
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const env = args.perfScale
        ? { ...process.env, SLOP_TEST_PERF_SCALE: args.perfScale }
        : process.env;
      const child = spawn("bun", ["run", args.cmd], {
        cwd: wt.path,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      child.stdout.on("data", (d) => {
        buffer += d.toString();
      });
      child.stderr.on("data", (d) => {
        buffer += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );
  const durationMs = performance.now() - t0;
  await appendFile(logPath, buffer);
  const testFilesLine = buffer.match(/Test Files\s+.*$/m)?.[0] ?? null;
  return {
    index: wt.index,
    path: wt.path,
    exitCode: result.code,
    signal: result.signal,
    durationMs: Math.round(durationMs),
    testFilesLine,
    failureSignatures: classifyFailures(buffer),
    logPath,
  };
}

interface RoundResult {
  round: number;
  wallMs: number;
  perWorktree: WorktreeRunResult[];
  allGreen: boolean;
  systemSamples: SystemSample[];
  dmesgNewLines: string[];
}

async function runRound(
  worktrees: Worktree[],
  args: Args,
  logDir: string,
  round: number,
): Promise<RoundResult> {
  const dmesgBefore = new Set(dmesgTail());
  const systemSamples: SystemSample[] = [];
  const t0 = performance.now();
  const sampler = setInterval(() => {
    systemSamples.push({
      tMs: Math.round(performance.now() - t0),
      loadavg: loadavg(),
      freeMemMB: Math.round(freemem() / 1024 ** 2),
    });
  }, 1000);

  const perWorktree = await Promise.all(
    worktrees.map((wt) => runOneWorktree(wt, args, logDir, round)),
  );

  clearInterval(sampler);
  const wallMs = Math.round(performance.now() - t0);
  const dmesgAfter = dmesgTail();
  const dmesgNewLines = dmesgAfter.filter((l) => !dmesgBefore.has(l));

  const allGreen = perWorktree.every((w) => w.exitCode === 0);
  return { round, wallMs, perWorktree, allGreen, systemSamples, dmesgNewLines };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const machine = {
    platform: `${platform()} ${release()}`,
    cpus: `${cpus().length}x ${cpus()[0]?.model ?? "unknown"}`,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    bunVersion: Bun.version,
    baseDirFs: fsTypeOf(join(args.baseDir, "..")),
  };
  log(
    `machine: ${machine.cpus}, ${machine.memoryGb}GB RAM, bun ${machine.bunVersion}, ` +
      `base-dir fs=${machine.baseDirFs}`,
  );
  if (machine.baseDirFs === "tmpfs") {
    log("WARNING: --base-dir resolves onto tmpfs (RAM-backed) — pass --base-dir on real disk");
  }
  log(
    `ref: ${args.ref}, n=${args.n}, cmd="bun run ${args.cmd}", repeat=${args.repeat}` +
      (args.perfScale ? `, SLOP_TEST_PERF_SCALE=${args.perfScale}` : ""),
  );
  log(
    `loadavg before: ${loadavg()
      .map((n) => n.toFixed(2))
      .join(", ")}, freemem: ${Math.round(freemem() / 1024 ** 2)}MB`,
  );

  const worktrees = await createWorktrees(args, runId);
  const logDir = join(args.baseDir, `logs-${runId}`);
  await mkdir(logDir, { recursive: true });

  log(
    `preparing ${worktrees.length} worktrees (bun install + bun run build, sequential, NOT measured)...`,
  );
  const prep: PrepResult[] = [];
  for (const wt of worktrees) {
    const r = await prepWorktree(wt);
    prep.push(r);
    log(
      `  wt ${wt.index}: ${r.ok ? "ok" : "FAILED"} (install ${Math.round(r.installMs)}ms, build ${Math.round(r.buildMs)}ms)`,
    );
    if (!r.ok) log(`    ${r.error}`);
  }
  if (prep.some((p) => !p.ok)) {
    log(
      "aborting: at least one worktree failed to prepare — cannot measure test-run concurrency without it",
    );
    if (!args.keep) await removeWorktrees(worktrees);
    process.exitCode = 1;
    return;
  }

  const rounds: RoundResult[] = [];
  for (let round = 1; round <= args.repeat; round++) {
    log(
      `\n=== round ${round}/${args.repeat}: launching ${args.n} concurrent "bun run ${args.cmd}" ===`,
    );
    const r = await runRound(worktrees, args, logDir, round);
    rounds.push(r);
    log(`round ${round}: wall=${r.wallMs}ms, allGreen=${r.allGreen}`);
    for (const w of r.perWorktree) {
      log(
        `  wt ${w.index}: exit=${w.exitCode} signal=${w.signal ?? "-"} duration=${w.durationMs}ms ` +
          `${w.testFilesLine ?? "(no summary line found)"}` +
          (w.failureSignatures.length ? ` -- ANOMALIES: ${w.failureSignatures.join(", ")}` : ""),
      );
    }
    if (r.dmesgNewLines.length > 0) {
      log(`  new dmesg lines during this round:`);
      for (const l of r.dmesgNewLines) log(`    ${l}`);
    }
  }

  if (!args.keep) {
    await removeWorktrees(worktrees);
  } else {
    log(`\n--keep set: worktrees left at ${worktrees.map((w) => w.path).join(", ")}`);
  }

  const allRoundsGreen = rounds.every((r) => r.allGreen);
  log(
    `\n=== summary: ${rounds.filter((r) => r.allGreen).length}/${rounds.length} rounds fully green ` +
      `(${args.n} concurrent worktrees each) ===`,
  );

  const results = {
    generatedAt: new Date().toISOString(),
    runId,
    args,
    machine,
    prep,
    rounds,
    allRoundsGreen,
  };
  if (args.out) {
    writeFileSync(args.out, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    log(`wrote ${args.out}`);
  }
  if (!allRoundsGreen) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
