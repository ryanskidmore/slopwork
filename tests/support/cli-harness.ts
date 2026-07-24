/**
 * Shared harness for IN-PROCESS `src/cli/commands/*` tests.
 *
 * Every command's `run<Cmd>` function reads `process.cwd()` (via
 * `requireRepoRoot`/`repoPaths`, see src/repo/paths.ts) rather than taking a
 * root as a parameter — that's the whole reason a spawned subprocess was the
 * previous convention (see e.g. done.test.ts/start.test.ts's own doc
 * comments). Importing `run<Cmd>` directly and driving it in-process instead
 * (real coverage, no subprocess) means every such test MUST run against an
 * isolated `mkdtemp()` root with `process.cwd()` pointed at it, and MUST
 * restore the original cwd afterward, even on throw — a leaked cwd pointed
 * at this repo's own root would make a mutating command silently rewrite
 * this repo's own live `.slop/` db (see tests/support/repo-slop-guard.ts,
 * the hard backstop that fails the whole suite if that ever happens).
 * {@link withCwd} is the one place that dance is implemented; every
 * command's test file should route through it rather than hand-rolling its
 * own `process.chdir`.
 */
import { join } from "node:path";
import { vi } from "vitest";
import type { Config } from "../../src/core/index.js";
import {
  DEFAULT_REVIEW_STALE_AFTER,
  DEFAULT_STALE_AFTER,
  DEFAULT_TRANSCRIPTS_MODE,
} from "../../src/core/index.js";
import { type ConfigYamlInput, stringifyConfigYaml } from "../../src/cli/config-yaml.js";
import { atomicWriteFile, ensureDbDirs, type RepoPaths } from "../../src/repo/index.js";

/**
 * Run `fn` with `process.cwd()` pointed at `dir`, restoring the original cwd
 * in a `finally` regardless of whether `fn` resolves, rejects, or throws
 * synchronously. This is the load-bearing piece of this file — see the
 * module doc above.
 */
export async function withCwd<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

export type BootstrapOptions = Partial<ConfigYamlInput>;

/**
 * Fast, direct `.slop/` bootstrap for command-level tests: writes
 * `config.yaml` (via the same `stringifyConfigYaml` `slop init` itself
 * uses) plus the `db/` skeleton (`ensureDbDirs`), skipping `runInit`'s own
 * git-autodetection/AGENTS.md/SKILL.md/`.gitignore`/CLAUDE.md work — that
 * full flow is exercised end to end by init.test.ts instead. Every OTHER
 * command only needs a valid, loadable `.slop/config.yaml` to get past its
 * own `loadConfig` call; doing that with one direct write (no git
 * subprocess, no doc rendering) keeps every other command's test fast and
 * focused on that command's own behavior.
 *
 * Does NOT itself `chdir` — call this from inside {@link withCwd}, or pass
 * `dir` from a temp root you're about to `withCwd` into.
 */
export async function bootstrapRepo(dir: string, opts: BootstrapOptions = {}): Promise<RepoPaths> {
  const paths = await ensureDbDirs(dir);
  const yamlText = stringifyConfigYaml({
    project: opts.project ?? "test-project",
    ...(opts.user !== undefined ? { user: opts.user } : {}),
    ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
    ...(opts.jira !== undefined ? { jira: opts.jira } : {}),
    staleAfter: opts.staleAfter ?? DEFAULT_STALE_AFTER,
    reviewStaleAfter: opts.reviewStaleAfter ?? DEFAULT_REVIEW_STALE_AFTER,
    transcripts: opts.transcripts ?? DEFAULT_TRANSCRIPTS_MODE,
  } satisfies ConfigYamlInput);
  await atomicWriteFile(join(paths.slopDir, "config.yaml"), yamlText);
  return paths;
}

/** Config-shaped defaults {@link bootstrapRepo} writes, for tests that want to assert against them without re-deriving. */
export const BOOTSTRAP_DEFAULTS: Pick<Config, "defaults" | "transcripts"> = {
  defaults: {
    stale_after: DEFAULT_STALE_AFTER,
    review_stale_after: DEFAULT_REVIEW_STALE_AFTER,
  },
  transcripts: DEFAULT_TRANSCRIPTS_MODE,
};

export interface CapturedOutput {
  /** Every chunk written to `process.stdout.write` since capture started, concatenated. */
  stdout(): string;
  /** Every chunk written to `process.stderr.write` since capture started, concatenated. */
  stderr(): string;
  /** Un-stub both streams. Every caller MUST call this (a `finally` or `afterEach`) — an un-restored stub silently swallows every later test's real output. */
  restore(): void;
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return String(chunk);
}

/**
 * Stub `process.stdout.write`/`process.stderr.write` to accumulate their
 * output instead of actually printing, for asserting on a `run<Cmd>`
 * function's human/`--json` output (every command writes directly to these,
 * never `console.log`/`return`s a string — see e.g. context.ts's `runContext`).
 * Always pair with `restore()` in a `try`/`finally` or `afterEach`.
 */
export function captureOutput(): CapturedOutput {
  let out = "";
  let err = "";
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown): boolean => {
      out += chunkToString(chunk);
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown): boolean => {
      err += chunkToString(chunk);
      return true;
    });
  return {
    stdout: () => out,
    stderr: () => err,
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}
