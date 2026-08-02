/**
 * t-ebgqb evidence gatherer #1: characterizes what `spawnSync`-ing the
 * compiled `dist/slop` binary (~96MB) actually returns under real OS process
 * pressure — the "spawnSync returning status: null" symptom the ticket
 * names — with the actual `error.code`/`error.errno`/`signal` captured, not
 * guessed.
 *
 * Every `tests/acceptance/*.test.ts` file that spawns the compiled binary
 * defines its OWN local `spawnSync(binaryPath, args, {...})` wrapper (there
 * is no shared helper to instrument in place — see the ticket's own
 * discovery). Rather than bolt debug logging onto 20+ existing test files,
 * this is a standalone load generator that reproduces the SAME call shape
 * (spawnSync against the compiled binary, one call at a time per OS
 * process) at a controlled, dialed-up concurrency, with full result capture.
 * Run this ALONGSIDE `bench/concurrent-repro.ts` (or several of them) to
 * correlate: if this tool starts seeing anomalies exactly when system
 * memory/load crosses some threshold, that's the root cause, directly
 * evidenced.
 *
 * Usage:
 *   bun bench/spawn-stress.ts --workers 32 --iterations 10 --cmd init
 *   bun bench/spawn-stress.ts --workers 8 --iterations 20 --cmd version --out bench/spawn-stress-results.json
 *
 * Flags:
 *   --workers N       concurrent OS processes hammering the binary (default 16)
 *   --iterations N    spawnSync calls per worker, sequential within a worker (default 10)
 *   --cmd version|init  "version" is the cheapest possible call (no fs work);
 *                     "init" reproduces the ticket's literally-named symptom
 *                     (`slop init` in a fresh mkdtemp dir per call) (default: init)
 *   --binary PATH     path to the compiled binary (default <repo>/dist/slop)
 *   --out PATH        write full JSON results here
 *
 * Internal: re-invokes itself with --worker-mode to become one of the
 * concurrent child processes; do not pass --worker-mode by hand.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

const REPO_ROOT = join(import.meta.dir, "..");
const DEFAULT_BINARY = join(REPO_ROOT, "dist", "slop");

interface Args {
  workers: number;
  iterations: number;
  cmd: "version" | "init";
  binary: string;
  out: string | null;
  workerMode: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cmd = get("--cmd") ?? "init";
  if (cmd !== "version" && cmd !== "init") {
    throw new Error(`--cmd must be "version" or "init", got "${cmd}"`);
  }
  return {
    workers: Number.parseInt(get("--workers") ?? "16", 10),
    iterations: Number.parseInt(get("--iterations") ?? "10", 10),
    cmd,
    binary: get("--binary") ?? DEFAULT_BINARY,
    out: get("--out") ?? null,
    workerMode: argv.includes("--worker-mode"),
  };
}

interface CallResult {
  ok: boolean;
  status: number | null;
  signal: NodeJS.Signals | null;
  errorCode: string | null;
  errorErrno: number | null;
  errorMessage: string | null;
  durationMs: number;
}

/** One worker's slice of work: `iterations` sequential spawnSync calls against `binary`. */
async function runWorkerIterations(args: Args): Promise<CallResult[]> {
  const results: CallResult[] = [];
  for (let i = 0; i < args.iterations; i++) {
    const t0 = performance.now();
    if (args.cmd === "version") {
      const r = spawnSync(args.binary, ["--version"], { encoding: "utf8", timeout: 30_000 });
      results.push(toCallResult(r, performance.now() - t0));
    } else {
      // Reproduce the ticket's literally-named symptom: `slop init` in a
      // fresh isolated dir, same as every acceptance test's own fixture
      // convention (tests/support/temp-repo.ts), just without vitest.
      const dir = await mkdtemp(join(tmpdir(), "slop-spawn-stress-"));
      try {
        const r = spawnSync(args.binary, ["init", "--yes"], {
          cwd: dir,
          encoding: "utf8",
          timeout: 30_000,
        });
        results.push(toCallResult(r, performance.now() - t0));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
  return results;
}

function toCallResult(
  r: ReturnType<typeof spawnSync>,
  durationMs: number,
): CallResult {
  const err = r.error as NodeJS.ErrnoException | undefined;
  return {
    ok: r.status === 0 && !err,
    status: r.status,
    signal: r.signal,
    errorCode: err?.code ?? null,
    errorErrno: err?.errno ?? null,
    errorMessage: err?.message ?? null,
    durationMs: Math.round(durationMs),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.workerMode) {
    // Child mode: do the work, print one NDJSON line of results, exit.
    const results = await runWorkerIterations(args);
    process.stdout.write(`${JSON.stringify(results)}\n`);
    return;
  }

  // Parent mode: fan out `workers` concurrent copies of this same script.
  process.stdout.write(
    `spawn-stress: ${args.workers} concurrent workers x ${args.iterations} ` +
      `spawnSync("${args.cmd}") calls each against ${args.binary}\n`,
  );

  const before = { loadavg: (await import("node:os")).loadavg(), freeMem: (await import("node:os")).freemem() };

  const children = Array.from({ length: args.workers }, () => {
    return new Promise<CallResult[]>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          import.meta.filename ?? new URL(import.meta.url).pathname,
          "--worker-mode",
          "--iterations",
          String(args.iterations),
          "--cmd",
          args.cmd,
          "--binary",
          args.binary,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      let out = "";
      child.stdout.on("data", (d) => {
        out += d.toString();
      });
      child.on("error", reject);
      child.on("close", () => {
        try {
          const line = out.trim().split("\n").pop() ?? "[]";
          resolve(JSON.parse(line) as CallResult[]);
        } catch (e) {
          reject(new Error(`could not parse worker output: ${(e as Error).message}\nraw: ${out}`));
        }
      });
    });
  });

  const t0 = performance.now();
  const perWorker = await Promise.all(children);
  const wallMs = performance.now() - t0;
  const after = { loadavg: (await import("node:os")).loadavg(), freeMem: (await import("node:os")).freemem() };

  const all = perWorker.flat();
  const anomalies = all.filter((r) => !r.ok);
  const byErrorCode = new Map<string, number>();
  for (const a of anomalies) {
    const key = a.errorCode ?? (a.signal ? `signal:${a.signal}` : a.status === null ? "status:null (no error/signal set)" : `exit:${a.status}`);
    byErrorCode.set(key, (byErrorCode.get(key) ?? 0) + 1);
  }
  const durations = all.map((r) => r.durationMs).sort((a, b) => a - b);
  const p50 = durations[Math.floor(durations.length * 0.5)] ?? 0;
  const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
  const max = durations[durations.length - 1] ?? 0;

  const summary = {
    workers: args.workers,
    iterations: args.iterations,
    cmd: args.cmd,
    binary: args.binary,
    totalCalls: all.length,
    okCalls: all.length - anomalies.length,
    anomalyCalls: anomalies.length,
    anomalyBreakdown: Object.fromEntries(byErrorCode),
    wallMs: Math.round(wallMs),
    durationMsP50: p50,
    durationMsP95: p95,
    durationMsMax: max,
    systemBefore: before,
    systemAfter: after,
    anomalies,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (args.out) {
    await writeFile(args.out, JSON.stringify(summary, null, 2));
    process.stdout.write(`\nwrote ${args.out}\n`);
  }
  if (anomalies.length > 0) {
    process.stdout.write(
      `\n${anomalies.length}/${all.length} calls were anomalous (see anomalyBreakdown above)\n`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
