/**
 * Hard sandbox backstop — the actual enforcement behind the convention
 * documented in tests/support/temp-repo.ts.
 *
 * This repo dogfoods itself: `.slop/` at the repo root is slopwork's own
 * live ticket database, checked into git (see `.slop/AGENTS.md`). Every
 * test that spawns `slop` or exercises the repo layer is expected to run
 * against an isolated `mkdtemp()` scratch directory, never this repo's
 * own root — but that's just a convention, unenforced by the type system.
 * A stray or mis-`cwd`'d test is a real risk specifically because
 * `findRepoRoot`/`requireRepoRoot` (src/repo/paths.ts) walk UP from `cwd`
 * looking for `.slop/`, exactly like `git` walks up looking for `.git/`:
 * any test that forgets to pass an isolated `cwd` (or that `chdir()`s
 * without restoring it) doesn't fail loudly with "not a slopwork repo" —
 * it silently finds and mutates the real one instead.
 *
 * This `globalSetup` hook is the guarantee: `setup()` runs once, before
 * any test file, and hashes (sha256, byte-for-byte, not mtime-based —
 * mtime granularity is exactly what made mtime-based tests flaky
 * elsewhere in this suite) every file under THIS repo's own `.slop/`.
 * The returned teardown runs once, after every test file has finished,
 * takes the same snapshot again, and — if anything differs — throws,
 * naming every added/removed/modified path. A thrown globalSetup teardown
 * error fails the whole `vitest run` (non-zero exit), so CI can never go
 * green while this repo's own `.slop/` was touched.
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repoRoot>/tests/support/repo-slop-guard.ts.
const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");
const SLOP_DIR = join(REPO_ROOT, ".slop");

/** relative-path (from `.slop/`) -> sha256 hex digest of file contents. */
type Manifest = Map<string, string>;

async function walk(dir: string, root: string, out: Manifest): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // `.slop/` (or a subdirectory of it) not existing at all is not this
    // guard's problem to diagnose — nothing to hash, nothing to violate.
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, out);
    } else if (entry.isFile()) {
      const content = await readFile(full);
      out.set(relative(root, full), createHash("sha256").update(content).digest("hex"));
    }
    // Symlinks/sockets/etc. are intentionally skipped — nothing this tool
    // writes under `.slop/` is ever one of those.
  }
}

async function snapshotRepoSlopDir(): Promise<Manifest> {
  const manifest: Manifest = new Map();
  await walk(SLOP_DIR, SLOP_DIR, manifest);
  return manifest;
}

/** Sorted, human-readable `+ added` / `- removed` / `~ modified` lines —
 * empty when `before` and `after` are identical. */
function describeDiff(before: Manifest, after: Manifest): string[] {
  const allPaths = new Set<string>([...before.keys(), ...after.keys()]);
  const lines: string[] = [];
  for (const path of [...allPaths].sort()) {
    const beforeHash = before.get(path);
    const afterHash = after.get(path);
    if (beforeHash === undefined && afterHash !== undefined) {
      lines.push(`  + added:    .slop/${path}`);
    } else if (beforeHash !== undefined && afterHash === undefined) {
      lines.push(`  - removed:  .slop/${path}`);
    } else if (beforeHash !== afterHash) {
      lines.push(`  ~ modified: .slop/${path}`);
    }
  }
  return lines;
}

export async function setup(): Promise<() => Promise<void>> {
  const before = await snapshotRepoSlopDir();

  return async function teardown(): Promise<void> {
    const after = await snapshotRepoSlopDir();
    const offenses = describeDiff(before, after);
    if (offenses.length > 0) {
      const message =
        "SANDBOX VIOLATION: this repo's own .slop/ directory changed " +
        `during the test run (${SLOP_DIR}). Every test that spawns \`slop\` ` +
        "or writes through the repo layer MUST run against an isolated " +
        "mkdtemp() temp directory (see tests/support/temp-repo.ts), never " +
        "this repo's own root — check for a missing/wrong `cwd` on a " +
        "spawned process, or an un-restored process.chdir(). " +
        `Offending path(s):\n${offenses.join("\n")}`;
      // Empirically, a globalSetup teardown that only *throws* gets logged
      // by vitest ("error during close") but does NOT flip the process's
      // exit code — verified by hand: a deliberate .slop/ write during the
      // run printed this error yet `vitest run` still exited 0. Setting
      // `process.exitCode` directly is the one mechanism that reliably
      // fails the run regardless of that reporting quirk — "fails the run
      // loudly" must mean a genuinely non-zero exit code, not just a
      // logged error CI can silently ignore.
      console.error(message);
      process.exitCode = 1;
      throw new Error(message);
    }
  };
}
