/**
 * Timing helpers shared by every benchmark phase.
 *
 * Two measurement modes, because they answer different questions and mixing
 * them up is the classic way to publish a misleading benchmark:
 *
 *   - {@link timeInProcess} imports the repo layer and calls it directly. This
 *     measures the DATASTORE — index builds, scans, ref resolution — with no
 *     process-startup floor underneath it. It is what the scaling curves are
 *     made of.
 *   - {@link timeSubprocess} spawns the compiled `dist/slop` binary exactly as
 *     a user or agent would. This measures END-TO-END latency, which includes a
 *     fixed runtime-startup cost (tens of ms) that dominates at small scales and
 *     is invisible in the in-process numbers. It is what a user actually feels.
 *
 * Both report the MEDIAN of N runs plus min/max, never the mean: a single
 * scheduler hiccup or page-cache miss skews a mean badly at these durations,
 * and the median is what a user experiences typically. `discard` drops warmup
 * runs whose job is to populate the OS page cache — stated explicitly per
 * measurement rather than hidden, since "cold" vs "warm" is itself one of the
 * things being measured here.
 */
import { spawnSync } from "node:child_process";

export interface Timing {
  label: string;
  runs: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
  /** Present when the measured thing produced a count worth reporting (rows scanned, files written). */
  n?: number;
  notes?: string;
}

function summarize(label: string, samples: number[], n?: number, notes?: string): Timing {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[mid] ?? 0);
  return {
    label,
    runs: sorted.length,
    medianMs: round(median),
    minMs: round(sorted[0] ?? 0),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    ...(n !== undefined ? { n } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

export async function timeInProcess(
  label: string,
  fn: () => Promise<unknown>,
  options: { runs?: number; discard?: number; n?: number; notes?: string } = {},
): Promise<Timing> {
  const runs = options.runs ?? 5;
  const discard = options.discard ?? 0;
  const samples: number[] = [];
  for (let i = 0; i < runs + discard; i++) {
    const t0 = performance.now();
    await fn();
    const dt = performance.now() - t0;
    if (i >= discard) samples.push(dt);
  }
  return summarize(label, samples, options.n, options.notes);
}

export function timeSubprocess(
  label: string,
  binary: string,
  args: string[],
  options: { cwd: string; runs?: number; discard?: number; notes?: string } = {
    cwd: process.cwd(),
  },
): Timing {
  const runs = options.runs ?? 5;
  const discard = options.discard ?? 0;
  const samples: number[] = [];
  for (let i = 0; i < runs + discard; i++) {
    const t0 = performance.now();
    const result = spawnSync(binary, args, { cwd: options.cwd, encoding: "utf8" });
    const dt = performance.now() - t0;
    if (result.status !== 0 && result.status !== null) {
      throw new Error(
        `benchmark command failed (exit ${result.status}): ${binary} ${args.join(" ")}\n${result.stderr?.slice(0, 400)}`,
      );
    }
    if (i >= discard) samples.push(dt);
  }
  return summarize(label, samples, undefined, options.notes);
}

/** Wall-clock for one shot of something inherently one-shot (a 1M-file seed). */
export async function timeOnce(
  label: string,
  fn: () => Promise<unknown>,
  n?: number,
  notes?: string,
): Promise<Timing> {
  const t0 = performance.now();
  await fn();
  const dt = performance.now() - t0;
  return summarize(label, [dt], n, notes);
}
