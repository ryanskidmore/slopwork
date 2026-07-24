/**
 * Fills two coverage gaps left by atomic-write.test.ts (a pre-existing
 * file this suite's scope doesn't allow editing — see
 * context-budget-json.test.ts's own doc for the same reasoning):
 *
 *   1. `TEST_WRITE_DELAY_MS`'s `SLOP_TEST_ATOMIC_WRITE_DELAY_MS` parsing —
 *      only ever exercised via tests/acceptance/A3.test.ts's real kill
 *      -9 test, which sets the env var on a SPAWNED subprocess
 *      (a3-kill-worker.ts), so it's functionally tested but invisible to
 *      v8 coverage instrumentation of the vitest worker itself. Exercised
 *      here in-process via `vi.resetModules()` + a fresh dynamic import
 *      per env var value, the standard way to re-run a module-level IIFE
 *      against a different `process.env` snapshot.
 *   2. `sweepStaleTempFiles`'s non-ENOENT rethrow when opening a
 *      leftover `.tmp-*` file fails for some OTHER reason (permission
 *      denied) — atomic-write.test.ts's own sweep suite only covers the
 *      ENOENT-already-gone race, not a genuine failure.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEMP_FILE_PREFIX } from "./atomic-write.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-atomic-write-gaps-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("SLOP_TEST_ATOMIC_WRITE_DELAY_MS (TEST_WRITE_DELAY_MS)", () => {
  const ENV_KEY = "SLOP_TEST_ATOMIC_WRITE_DELAY_MS";
  const originalValue = process.env[ENV_KEY];

  afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalValue;
  });

  /** Re-imports atomic-write.js fresh so its module-level
   * `TEST_WRITE_DELAY_MS` IIFE re-reads `process.env[ENV_KEY]` as it is
   * at the moment of import — exactly what a real process start does. */
  async function freshAtomicWriteFile(envValue: string | undefined) {
    if (envValue === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = envValue;
    vi.resetModules();
    const mod = await import("./atomic-write.js");
    return mod.atomicWriteFile;
  }

  it("unset: no delay before the rename (the ordinary, real-world case)", async () => {
    const atomicWriteFile = await freshAtomicWriteFile(undefined);
    const target = join(scratch, "no-delay.jsonc");
    const start = Date.now();
    await atomicWriteFile(target, "{}\n");
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("a valid positive numeric value: sleeps at least that long before renaming", async () => {
    const atomicWriteFile = await freshAtomicWriteFile("40");
    const target = join(scratch, "delayed.jsonc");
    const start = Date.now();
    await atomicWriteFile(target, "{}\n");
    expect(Date.now() - start).toBeGreaterThanOrEqual(35); // small margin for timer slop
  });

  it("non-numeric, zero, or negative values are all treated as 'no delay' (falls back to 0)", async () => {
    for (const bad of ["not-a-number", "0", "-5"]) {
      const atomicWriteFile = await freshAtomicWriteFile(bad);
      const target = join(scratch, `no-delay-${bad.replace(/\W/g, "_")}.jsonc`);
      const start = Date.now();
      await atomicWriteFile(target, "{}\n");
      expect(Date.now() - start, `env value ${bad}`).toBeLessThan(200);
    }
  });
});

describe("sweepStaleTempFiles — non-ENOENT open failure", () => {
  it("propagates (rejects) rather than silently skipping a temp file that genuinely can't be opened (permission denied)", async () => {
    const tempPath = join(scratch, `${TEMP_FILE_PREFIX}abc-ticket_x.jsonc`);
    await writeFile(tempPath, "partial");
    await chmod(tempPath, 0o000);

    try {
      const { sweepStaleTempFiles } = await import("./atomic-write.js");
      await expect(sweepStaleTempFiles([scratch], { minAgeMs: 0 })).rejects.toBeTruthy();
    } finally {
      // So the outer afterEach's rm -rf can clean the directory up.
      await chmod(tempPath, 0o644);
    }
  });
});
