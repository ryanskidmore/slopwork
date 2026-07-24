/**
 * Shared temp-directory helper for acceptance/integration tests that need
 * an isolated on-disk root to run the real `slop` binary (or repo-layer
 * functions) against.
 *
 * Before this existed, most tests/acceptance/*.test.ts files hand-rolled
 * the exact same three pieces per-file: a module-scoped `scratchDirs`
 * array, an `afterEach` that pops and `rm -rf`s them, and an
 * `mkdtemp(join(tmpdir(), "slop-<suite>-"))` call inside each fixture
 * builder. `makeTempRepo()` centralizes that so new tests get sandboxing
 * — every mutating `slop` invocation running against `os.tmpdir()`,
 * NEVER this repo's own root — for free, without re-deriving it.
 *
 * This is a convention, not an enforcement mechanism: nothing stops a
 * test from passing some other `cwd` to a spawned `slop` process anyway.
 * See tests/support/repo-slop-guard.ts's `globalSetup` for the actual
 * hard backstop — it snapshots this repo's own `.slop/` before the suite
 * and fails the whole run, loudly, if anything touched it, regardless of
 * whether the offending test used this helper or not.
 *
 * Not yet adopted everywhere — see README.md's Testing section / the
 * ticket that added this file for which acceptance suites still use their
 * own hand-rolled copy of this exact pattern (they're equally sandboxed
 * today, just not sharing this implementation).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Creates a fresh `mkdtemp`-backed directory under `os.tmpdir()` and
 * registers it for automatic `rm -rf` cleanup in this test file's next
 * `afterEach`. `prefix` should identify the calling suite (e.g.
 * `"slop-d2-"`) — it's passed straight through to `mkdtemp`, so it both
 * namespaces concurrent test files' scratch dirs and makes any leftover
 * directory (e.g. after a killed run) traceable back to its suite.
 */
export async function makeTempRepo(prefix = "slop-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
