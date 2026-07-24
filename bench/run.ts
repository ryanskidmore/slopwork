/**
 * The benchmark itself: seed a `.slop/db` at a given scale, then measure the
 * operations slopwork actually performs, and report where they stop being fast.
 *
 * Run it:
 *   bun bench/run.ts --scales 1000,10000,100000 --out bench/results.json
 *   bun bench/run.ts --scales 1000000 --skip-subprocess     # the big one
 *
 * Flags:
 *   --scales a,b,c     ticket counts to sweep (default 1000,10000,100000)
 *   --events N          extra progress events seeded per scale (default 2x tickets, capped)
 *   --workers N         concurrent writers in the concurrency phases (default 64)
 *   --dir PATH          where to build the fixtures. MUST be a real disk, not
 *                       tmpfs — see the note below. Default: ./.bench-work
 *   --out PATH          write JSON results here
 *   --skip-subprocess   skip the end-to-end CLI timings (they spawn the binary
 *                       once per run and dominate wall-clock at large scales)
 *   --keep              don't delete the fixtures afterward
 *
 * ## Why the fixture directory matters
 *
 * `/tmp` on many Linux setups (including the machine these results were taken
 * on) is **tmpfs — RAM**. Benchmarking a filesystem-backed datastore there
 * measures memory bandwidth and produces numbers no user will ever see. The
 * default fixture directory is therefore inside the repo (a real disk), and the
 * results doc records the filesystem it ran on.
 *
 * ## What is deliberately NOT measured
 *
 * Seeding cost. It writes files directly (bench/seed.ts) rather than through
 * `slop new`, so it is a fixture-construction cost, not a slopwork operation.
 * It is reported for transparency but never presented as an op latency.
 */
import { rm, mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { cpus, totalmem, platform, release } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { seed, verifySample } from "./seed.js";
import { round, timeInProcess, timeOnce, timeSubprocess } from "./measure.js";
import type { Timing } from "./measure.js";

const REPO_ROOT = join(import.meta.dir, "..");
const BINARY = join(REPO_ROOT, "dist", "slop");

interface Args {
  scales: number[];
  events: number | null;
  workers: number;
  dir: string;
  out: string | null;
  skipSubprocess: boolean;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    scales: (get("--scales") ?? "1000,10000,100000")
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0),
    events: get("--events") !== undefined ? Number.parseInt(get("--events") as string, 10) : null,
    workers: Number.parseInt(get("--workers") ?? "64", 10),
    dir: get("--dir") ?? join(REPO_ROOT, ".bench-work"),
    out: get("--out") ?? null,
    skipSubprocess: argv.includes("--skip-subprocess"),
    keep: argv.includes("--keep"),
  };
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

/**
 * Shortest prefix of `target` that no OTHER id in `ids` also starts with —
 * i.e. the shortest ref a user could actually type here without hitting
 * AMBIGUOUS_REF. Reported because it degrades with creation RATE, not just
 * with ticket count: `newTicketId`'s monotonic factory keeps the timestamp and
 * randomness fixed within a millisecond and increments only the low bits, so a
 * thousand tickets created in one burst can share ~20 leading characters, while
 * a thousand created a second apart differ almost immediately.
 */
function shortestUniquePrefix(ids: readonly string[], target: string): number {
  const others = ids.filter((id) => id !== target);
  for (let len = 8; len <= target.length; len++) {
    const p = target.slice(0, len);
    if (!others.some((id) => id.startsWith(p))) return len;
  }
  return target.length;
}

async function dirSizeBytes(dir: string): Promise<number> {
  const result = spawnSync("du", ["-sb", dir], { encoding: "utf8" });
  if (result.status !== 0) return 0;
  return Number.parseInt(result.stdout.split(/\s+/)[0] ?? "0", 10);
}

interface ScaleResult {
  tickets: number;
  events: number;
  seed: Timing;
  dbBytes: number;
  indexBytes: number;
  timings: Timing[];
}

async function runScale(args: Args, tickets: number): Promise<ScaleResult> {
  const root = join(args.dir, `scale-${tickets}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  // Events default: 2 per ticket up to a ceiling, so the event log is a real
  // participant (it feeds the index fingerprint + effective-overlay derivation)
  // without the seed itself becoming the dominant cost at 1M.
  const events = args.events ?? Math.min(tickets * 2, 200_000);
  const fanout = Math.min(1000, Math.max(1, Math.floor(tickets / 10)));

  log(`\n=== scale ${tickets.toLocaleString()} tickets / ${events.toLocaleString()} events ===`);
  const seeded = await seed({ root, tickets, events, blocksFanout: fanout });
  await verifySample(root, seeded.sampleId);
  log(`  seeded in ${round(seeded.seedMs)}ms (fixture build, not an op latency)`);

  // Config so staleness thresholds resolve exactly as in a real repo.
  await writeFile(
    join(root, ".slop", "config.yaml"),
    "project: bench\nuser: bench\ndefaults:\n  stale_after: 60m\n  review_stale_after: 24h\ntranscripts: off\n",
    "utf8",
  );

  const repo = await import("../src/repo/index.js");
  const paths = repo.repoPaths(root);
  const indexFile = paths.indexFile;
  const timings: Timing[] = [];

  // --- Phase 1: cold index build (no index on disk at all) -----------------
  // The single most important number: everything else reads through the index,
  // and it is rebuilt from scratch on a fresh clone (index.jsonc is gitignored)
  // and after any `git pull` that touched tickets.
  timings.push(
    await timeInProcess(
      "index: cold build (no index.jsonc)",
      async () => {
        await rm(indexFile, { force: true });
        await repo.buildIndex(paths);
      },
      { runs: 3, n: tickets, notes: "rebuilt from every entity file; what a fresh clone pays" },
    ),
  );

  // Persist one so the warm paths below have something to read.
  const index = await repo.rebuildIndex(paths);
  const indexStat = await stat(indexFile).catch(() => null);

  // --- Phase 2: warm load (index present + fingerprint check) --------------
  // The common case for every read command. Cost is dominated by the
  // fingerprint scan (readdir+stat over tickets/, readdir over events/), which
  // is what decides whether the cached index may be served.
  timings.push(
    await timeInProcess(
      "index: warm load (fingerprint verify + parse)",
      () => repo.loadIndex(paths),
      {
        runs: 5,
        discard: 1,
        n: tickets,
        notes: "no rebuild; readdir+stat fingerprint then parse index.jsonc",
      },
    ),
  );

  // --- Phase 3: ref resolution ---------------------------------------------
  // Slug is an O(1) map hit; a short-prefix ref is a linear scan of index rows.
  timings.push(
    await timeInProcess(
      "resolve ref: by slug (index map lookup)",
      () => repo.resolveTicketRef(paths, seeded.sampleSlug),
      { runs: 5, discard: 1, n: tickets },
    ),
  );
  // Prefix length is chosen to be UNAMBIGUOUS at this scale, which is itself a
  // finding worth recording: tickets minted in the same millisecond share a
  // long ULID prefix (the monotonic factory only increments the low bits), so
  // a bulk-seeded db needs a much longer prefix than a hand-created one before
  // `resolveTicketRef` stops reporting AMBIGUOUS_REF. `shortestUniquePrefix`
  // measures where that boundary actually falls here.
  const prefixLen = shortestUniquePrefix(
    index.tickets.map((t) => t.id),
    seeded.sampleId,
  );
  timings.push(
    await timeInProcess(
      `resolve ref: by id prefix (row scan, ${prefixLen}-char prefix)`,
      () => repo.resolveTicketRef(paths, seeded.sampleId.slice(0, prefixLen)),
      {
        runs: 5,
        discard: 1,
        n: tickets,
        notes: `shortest unambiguous prefix at this scale was ${prefixLen} chars of ${seeded.sampleId.length}`,
      },
    ),
  );

  // --- Phase 4: full tolerant scan (what search/reindex pay) ---------------
  timings.push(
    await timeInProcess(
      "read: parse + validate every ticket (listTicketsTolerant)",
      () => repo.listTicketsTolerant(paths),
      { runs: 3, n: tickets, notes: "the floor under `search` and `reindex`" },
    ),
  );

  // --- Phase 5: end-to-end CLI latency -------------------------------------
  // Includes binary startup, which is a fixed floor invisible above.
  if (!args.skipSubprocess) {
    for (const [label, cmd] of [
      ["cli: slop status", ["status"]],
      ["cli: slop ready --json", ["ready", "--json"]],
      ["cli: slop show <slug>", ["show", seeded.sampleSlug]],
      ["cli: slop search", ["search", "Bench ticket 7"]],
    ] as const) {
      timings.push(
        timeSubprocess(label, BINARY, [...cmd], {
          cwd: root,
          runs: 3,
          discard: 1,
          notes: "end-to-end, includes binary startup",
        }),
      );
    }
    timings.push(
      timeSubprocess("cli: slop new (write path)", BINARY, ["new", `bench probe ${Date.now()}`], {
        cwd: root,
        runs: 3,
        notes: "one full mutation: lock, write ticket, append event, invalidate index",
      }),
    );
  }

  const dbBytes = await dirSizeBytes(join(root, ".slop"));

  if (!args.keep) await rm(root, { recursive: true, force: true });

  return {
    tickets,
    events,
    seed: {
      label: "fixture seed (not an op)",
      runs: 1,
      medianMs: round(seeded.seedMs),
      minMs: round(seeded.seedMs),
      maxMs: round(seeded.seedMs),
      n: tickets,
    },
    dbBytes,
    indexBytes: indexStat?.size ?? 0,
    timings,
  };
}

/**
 * Concurrency: the two write paths slopwork deliberately treats differently.
 *
 *  - `update --progress` alone is LOCK-FREE by design (it appends an event and
 *    never touches the ticket file), so N writers should scale with no
 *    contention at all.
 *  - `new` takes the db lock, so N writers serialize through it.
 *  - N `start`s on ONE ticket is the correctness case, not a throughput one:
 *    exactly one must win and the rest must fail cleanly with exit 6.
 */
async function runConcurrency(args: Args): Promise<{
  workers: number;
  results: Timing[];
  startRace: { winners: number; conflicts: number; other: number };
}> {
  const root = join(args.dir, "concurrency");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  log(`\n=== concurrency: ${args.workers} workers ===`);

  const seeded = await seed({ root, tickets: 2000, events: 0 });
  await writeFile(
    join(root, ".slop", "config.yaml"),
    "project: bench\nuser: bench\ntranscripts: off\n",
    "utf8",
  );

  const results: Timing[] = [];
  // `spawnSync` would serialize the workers and measure nothing, so every
  // worker is launched first and awaited afterward — that overlap IS the
  // contention being measured.
  const spawnAll = (argsFor: (i: number) => string[]): ChildProcess[] =>
    Array.from({ length: args.workers }, (_, i) =>
      spawn(BINARY, argsFor(i), { cwd: root, stdio: "ignore" }),
    );

  const waitAll = (children: ChildProcess[]): Promise<number[]> =>
    Promise.all(
      children.map(
        (child) =>
          new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? -1))),
      ),
    );

  // Lock-free path
  results.push(
    await timeOnce(
      `concurrency: ${args.workers}x lock-free 'update --progress'`,
      async () => {
        const children = spawnAll((i) => [
          "update",
          seeded.sampleSlug,
          "--progress",
          `worker ${i} note`,
        ]);
        const codes = await waitAll(children);
        const failed = codes.filter((c) => c !== 0).length;
        if (failed > 0) throw new Error(`${failed} lock-free progress writers failed`);
      },
      args.workers,
      "no db lock taken; each writer appends its own ULID-named event file",
    ),
  );

  // Lock-contended path
  results.push(
    await timeOnce(
      `concurrency: ${args.workers}x 'new' (db lock contention)`,
      async () => {
        const children = spawnAll((i) => ["new", `concurrent bench ticket ${i}`]);
        const codes = await waitAll(children);
        const failed = codes.filter((c) => c !== 0).length;
        if (failed > 0) throw new Error(`${failed} concurrent 'new' writers failed (exit != 0)`);
      },
      args.workers,
      "every writer serializes through .slop/db/.lock",
    ),
  );

  // Correctness under contention: N starts on ONE ticket.
  const raceChildren = spawnAll(() => ["start", seeded.sampleSlug]);
  const raceCodes = await waitAll(raceChildren);
  const startRace = {
    winners: raceCodes.filter((c) => c === 0).length,
    conflicts: raceCodes.filter((c) => c === 6).length,
    other: raceCodes.filter((c) => c !== 0 && c !== 6).length,
  };
  log(
    `  start race: ${startRace.winners} winner(s), ${startRace.conflicts} clean CONFLICT(6), ${startRace.other} other`,
  );

  if (!args.keep) await rm(root, { recursive: true, force: true });
  return { workers: args.workers, results, startRace };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.dir, { recursive: true });

  const fsType = spawnSync("df", ["-T", args.dir], { encoding: "utf8" })
    .stdout?.trim()
    .split("\n")
    .pop()
    ?.split(/\s+/)[1];

  const machine = {
    platform: `${platform()} ${release()}`,
    cpus: `${cpus().length}x ${cpus()[0]?.model ?? "unknown"}`,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    bunVersion: Bun.version,
    fixtureDir: args.dir,
    fixtureFs: fsType ?? "unknown",
    warning:
      fsType === "tmpfs"
        ? "FIXTURES ARE ON TMPFS (RAM) — these numbers are NOT representative of real disk"
        : null,
  };
  log(`machine: ${machine.cpus}, ${machine.memoryGb}GB, bun ${machine.bunVersion}`);
  log(`fixtures: ${args.dir} (${machine.fixtureFs})`);
  if (machine.warning) log(`WARNING: ${machine.warning}`);

  const scales: ScaleResult[] = [];
  for (const n of args.scales) {
    scales.push(await runScale(args, n));
  }
  const concurrency = await runConcurrency(args);

  const results = { machine, generatedAt: new Date().toISOString(), scales, concurrency };
  if (args.out) {
    await writeFile(args.out, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    log(`\nwrote ${args.out}`);
  }

  log("\n=== summary ===");
  for (const s of scales) {
    log(
      `\n${s.tickets.toLocaleString()} tickets (${(s.dbBytes / 1024 ** 2).toFixed(1)} MiB on disk):`,
    );
    for (const t of s.timings) log(`  ${t.medianMs.toString().padStart(10)}ms  ${t.label}`);
  }
  for (const t of concurrency.results) log(`  ${t.medianMs.toString().padStart(10)}ms  ${t.label}`);
}

await main();
