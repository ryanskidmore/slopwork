/**
 * Shared scale factor for real-wall-clock performance budgets asserted
 * against the compiled binary (t-ebgqb).
 *
 * `tests/acceptance/D4.test.ts`'s 1000-ticket `status` timing assertion
 * (originally a flat `expect(elapsedMs).toBeLessThan(800)`) was PROVEN
 * flaky under real concurrent load by `bench/concurrent-repro.ts`: 3
 * concurrent `bun run test` runs (each in its own worktree, on a 32-core/
 * 30GB dev box already under ambient load from other agents) reliably
 * pushed the SAME spawned `slop status` call to 860ms/1130ms/1602ms —
 * still well under a second of real work, just no longer under an 800ms
 * WALL-CLOCK budget once 3x the workers are fighting for the same CPUs.
 * See bench-out/before-baseline.json (committed alongside this fix) for
 * the raw numbers.
 *
 * The budget itself is real and worth keeping strict by default — CI runs
 * this suite alone, on a dedicated runner, and a genuine performance
 * regression should still fail it there. What's NOT reasonable is baking
 * "this box is mine alone right now" into the assertion. `SLOP_TEST_PERF_SCALE`
 * lets a caller that KNOWS it's racing other full-suite runs on the same
 * machine (this ticket's own repro harness sets it — see
 * bench/concurrent-repro.ts's `--perf-scale`) say so explicitly, without
 * loosening the default (scale 1 = unchanged, exact original budget) that
 * CI and solo local runs still get.
 */

/** Multiplier applied to every real-wall-clock performance budget in the
 * acceptance suite. Reads `SLOP_TEST_PERF_SCALE` once per process; falls
 * back to `1` (today's exact behavior) for anything not a finite number > 0. */
function readPerfScale(): number {
  const raw = process.env.SLOP_TEST_PERF_SCALE;
  if (raw === undefined) return 1;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const PERF_SCALE = readPerfScale();

/** Scale a real-wall-clock budget (in ms) by `SLOP_TEST_PERF_SCALE` (default 1,
 * i.e. unchanged). Use for any `expect(elapsedMs).toBeLessThan(perfBudgetMs(N))`
 * assertion timing a spawned binary call, so it can be widened for known-
 * concurrent runs without touching the test's own asserted intent. */
export function perfBudgetMs(baseMs: number): number {
  return baseMs * PERF_SCALE;
}
