import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SWEEP_MIN_AGE_MS,
  TEMP_FILE_PREFIX,
  atomicWriteFile,
  isTempFileName,
  sweepStaleTempFiles,
} from "./atomic-write.js";

/**
 * Records every `open(path, flags)` call node:fs/promises makes during a
 * test, so the new-dir-parent-fsync tests below can tell a directory
 * fsync (`fsyncDir` always calls `open(dir, "r")`) apart from the
 * temp-file write (`open(tmpPath, "wx")`) without needing to touch
 * atomic-write.ts's internals — `fsyncNewlyCreatedDirChain` is
 * intentionally not exported, exactly like `fsyncDir` it builds on, so
 * this is the only vantage point available from a co-located test. Off
 * by default (every other test in this file never enables it) so this
 * mock is a transparent passthrough everywhere else.
 */
const openLog = vi.hoisted(() => {
  let enabled = false;
  const calls: { path: string; flags: unknown }[] = [];
  return {
    enable(): void {
      enabled = true;
      calls.length = 0;
    },
    disable(): void {
      enabled = false;
    },
    calls,
    record(path: string, flags: unknown): void {
      if (enabled) calls.push({ path, flags });
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof actual.open = (path, flags, mode) => {
    openLog.record(String(path), flags);
    return actual.open(path, flags, mode);
  };
  return { ...actual, open };
});

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-atomic-write-test-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("isTempFileName", () => {
  it("recognizes the .tmp- prefix and nothing else", () => {
    expect(isTempFileName(`${TEMP_FILE_PREFIX}abc-ticket_x.jsonc`)).toBe(true);
    expect(isTempFileName("ticket_01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonc")).toBe(false);
    expect(isTempFileName("index.jsonc")).toBe(false);
    expect(isTempFileName(".lock")).toBe(false);
  });
});

describe("atomicWriteFile", () => {
  it("creates the target file with the exact contents given", async () => {
    const target = join(scratch, "ticket_x.jsonc");
    await atomicWriteFile(target, '{"a":1}\n');
    expect(await readFile(target, "utf8")).toBe('{"a":1}\n');
  });

  it("leaves no temp file behind on a successful write", async () => {
    const target = join(scratch, "ticket_x.jsonc");
    await atomicWriteFile(target, "{}\n");
    const names = await readdir(scratch);
    expect(names.filter(isTempFileName)).toHaveLength(0);
    expect(names).toEqual(["ticket_x.jsonc"]);
  });

  it("overwrites an existing target file completely (rename semantics, not append)", async () => {
    const target = join(scratch, "ticket_x.jsonc");
    await atomicWriteFile(target, '{"v":1}\n');
    await atomicWriteFile(target, '{"v":2}\n');
    expect(await readFile(target, "utf8")).toBe('{"v":2}\n');
    const names = await readdir(scratch);
    expect(names).toEqual(["ticket_x.jsonc"]);
  });

  it("writes the temp file in the SAME directory as the target (rename is only atomic within a filesystem)", async () => {
    const nested = join(scratch, "nested");
    await mkdir(nested, { recursive: true });
    const target = join(nested, "ticket_x.jsonc");
    await atomicWriteFile(target, "{}\n");
    // If a temp file had ever been created outside `nested`, the parent
    // scratch dir would still contain it after a successful write.
    const parentNames = await readdir(scratch);
    expect(parentNames).toEqual(["nested"]);
  });

  it("cleans up its own temp file when the write fails before rename (normal error path, not a crash)", async () => {
    // A read-only directory lets `mkdir` (a no-op — the directory already
    // exists) succeed, but forces `open(tmpPath, "wx")` to fail with
    // EACCES before anything is written, exercising the catch-and-cleanup
    // path. (A MISSING directory no longer forces a failure here at all —
    // see the self-healing tests below, Fix 4.)
    const readonlyDir = join(scratch, "readonly");
    await mkdir(readonlyDir);
    await chmod(readonlyDir, 0o555);
    try {
      const target = join(readonlyDir, "ticket_x.jsonc");
      await expect(atomicWriteFile(target, "{}\n")).rejects.toThrow();
      // Nothing leaked into `readonlyDir` itself.
      const names = await readdir(readonlyDir);
      expect(names.filter(isTempFileName)).toHaveLength(0);
    } finally {
      // Restore write permission so `afterEach`'s `rm(scratch, ...)` can
      // actually remove this directory.
      await chmod(readonlyDir, 0o755);
    }
  });

  // Fix 4 (adversarial review / E2 Defect 2): git does not track empty
  // directories, so a freshly cloned repo can be missing `.slop/db/
  // sessions/` (or `events/`) entirely until the first write of that
  // kind — `atomicWriteFile` must self-heal, never crash with a raw
  // ENOENT on a fresh clone's first write.
  describe("self-heals a missing target directory (Fix 4 / E2 Defect 2)", () => {
    it("creates a missing parent directory on demand and writes successfully", async () => {
      const missingDir = join(scratch, "sessions");
      const target = join(missingDir, "session_x.jsonc");
      await atomicWriteFile(target, '{"a":1}\n');
      expect(await readFile(target, "utf8")).toBe('{"a":1}\n');
    });

    it("self-heals a deeply nested missing directory chain too", async () => {
      const missingDir = join(scratch, "a", "b", "c");
      const target = join(missingDir, "ticket_x.jsonc");
      await atomicWriteFile(target, "{}\n");
      expect(await readFile(target, "utf8")).toBe("{}\n");
    });

    it("a second write into the same self-healed directory is a normal overwrite, no leftover temp files", async () => {
      const missingDir = join(scratch, "events");
      const target = join(missingDir, "event_x.jsonc");
      await atomicWriteFile(target, '{"v":1}\n');
      await atomicWriteFile(target, '{"v":2}\n');
      expect(await readFile(target, "utf8")).toBe('{"v":2}\n');
      const names = await readdir(missingDir);
      expect(names).toEqual(["event_x.jsonc"]);
    });

    // Polish batch item 4: the self-heal above always fsynced the
    // newly-created TARGET dir, but never the target dir's own newly-
    // created ANCESTORS' parents — so a crash right after a successful,
    // fully-fsynced write could still lose the just-created directory
    // chain itself (the directory ENTRY for e.g. `sessions` living in
    // `db/` is a fact about `db/`, not about `sessions/`). Every level
    // from the pre-existing ancestor down through the deepest new dir
    // must now get its OWN parent fsynced too.
    it("fsyncs every newly-created directory's parent, not just the deepest target dir, for a multi-level self-heal", async () => {
      const newRoot = join(scratch, "newroot");
      const level1 = join(newRoot, "level1");
      const level2 = join(level1, "level2");
      const target = join(level2, "ticket_x.jsonc");

      openLog.enable();
      try {
        await atomicWriteFile(target, "{}\n");
      } finally {
        openLog.disable();
      }

      expect(await readFile(target, "utf8")).toBe("{}\n");

      const dirsFsynced = openLog.calls
        .filter((call) => call.flags === "r")
        .map((call) => call.path);
      // `scratch` (the pre-existing ancestor whose entry "newroot" is
      // new), `newroot` (whose entry "level1" is new), and `level1`
      // (whose entry "level2" is new) are the new fsyncs this fix adds;
      // `level2` itself was already fsynced (post-rename, for the file
      // entry) even before this fix.
      expect(dirsFsynced).toEqual(expect.arrayContaining([scratch, newRoot, level1, level2]));
    });

    it("does NOT fsync any ancestor beyond the target dir once the directory already exists (common-path fsync count unchanged)", async () => {
      const missingDir = join(scratch, "presynced");
      const target = join(missingDir, "ticket_x.jsonc");
      await atomicWriteFile(target, '{"v":1}\n'); // creates + fsyncs the chain once

      openLog.enable();
      try {
        await atomicWriteFile(target, '{"v":2}\n'); // dir already exists now
      } finally {
        openLog.disable();
      }

      expect(await readFile(target, "utf8")).toBe('{"v":2}\n');
      const dirsFsynced = openLog.calls
        .filter((call) => call.flags === "r")
        .map((call) => call.path);
      // Only the target dir itself (the existing post-rename fsync) —
      // `mkdir` created nothing this time, so the new parent-chain logic
      // must not fire at all.
      expect(dirsFsynced).toEqual([missingDir]);
    });
  });
});

describe("sweepStaleTempFiles", () => {
  it("removes .tmp- files older than minAgeMs and reports their paths", async () => {
    const tempPath = join(scratch, `${TEMP_FILE_PREFIX}abc-ticket_x.jsonc`);
    await writeFile(tempPath, "partial");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(tempPath, old, old);

    const removed = await sweepStaleTempFiles([scratch], { minAgeMs: 60_000 });
    expect(removed).toEqual([tempPath]);
    expect(await readdir(scratch)).toEqual([]);
  });

  it("does NOT remove a fresh .tmp- file (default/explicit minAgeMs) — avoids racing a concurrent writer", async () => {
    const tempPath = join(scratch, `${TEMP_FILE_PREFIX}abc-ticket_x.jsonc`);
    await writeFile(tempPath, "partial");

    const removed = await sweepStaleTempFiles([scratch], { minAgeMs: DEFAULT_SWEEP_MIN_AGE_MS });
    expect(removed).toEqual([]);
    expect(await readdir(scratch)).toEqual([`${TEMP_FILE_PREFIX}abc-ticket_x.jsonc`]);
  });

  it("ignores non-temp files entirely, regardless of age", async () => {
    const entityPath = join(scratch, "ticket_x.jsonc");
    await writeFile(entityPath, "{}\n");
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(entityPath, old, old);

    const removed = await sweepStaleTempFiles([scratch], { minAgeMs: 0 });
    expect(removed).toEqual([]);
    expect(await readdir(scratch)).toEqual(["ticket_x.jsonc"]);
  });

  it("tolerates a missing directory (fresh clone with no db/ yet) rather than throwing", async () => {
    const missing = join(scratch, "nope");
    await expect(sweepStaleTempFiles([missing])).resolves.toEqual([]);
  });

  it("removes a just-created .tmp- file with minAgeMs: 0, deterministically (regression: fractional mtimeMs vs. integer Date.now() must never make the computed age go negative)", async () => {
    // A single fast iteration can pass even against the unfixed code —
    // whether `Date.now()`'s truncation lands above or below the file's
    // fractional `mtimeMs` is a coin flip. Repeating in fresh directories,
    // with no artificial delay, reliably trips the race against the old
    // (unclamped) age computation.
    for (let i = 0; i < 20; i++) {
      const dir = join(scratch, `iter-${i}`);
      await mkdir(dir);
      const tempPath = join(dir, `${TEMP_FILE_PREFIX}abc-ticket_x.jsonc`);
      await writeFile(tempPath, "partial");

      const removed = await sweepStaleTempFiles([dir], { minAgeMs: 0 });
      expect(removed).toEqual([tempPath]);
      expect(await readdir(dir)).toEqual([]);
    }
  });

  it("sweeps across multiple directories in one call", async () => {
    const dirA = join(scratch, "a");
    const dirB = join(scratch, "b");
    await mkdir(dirA);
    await mkdir(dirB);
    const tempA = join(dirA, `${TEMP_FILE_PREFIX}1-x.jsonc`);
    const tempB = join(dirB, `${TEMP_FILE_PREFIX}2-y.jsonc`);
    await writeFile(tempA, "x");
    await writeFile(tempB, "y");

    const removed = await sweepStaleTempFiles([dirA, dirB], { minAgeMs: 0 });
    expect(removed.sort()).toEqual([tempA, tempB].sort());
  });
});

// ---------------------------------------------------------------------------
// fsyncDir platform guard (Windows portability — no Windows equivalent of
// opening a directory for reading and fsyncing its fd; this sits under
// 100% of atomic writes, so it must degrade to a safe no-op on win32
// rather than throw). `process.platform` is mocked per test since this is
// a Linux host — every real POSIX behavior is exercised unmocked, both
// here and by every other test in this file.
// ---------------------------------------------------------------------------
describe("fsyncDir platform guard (Windows portability)", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("on win32, skips the directory fsync entirely — write still succeeds, temp file still cleaned up", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const target = join(scratch, "ticket_x.jsonc");
    openLog.enable();
    try {
      await atomicWriteFile(target, '{"a":1}\n');
    } finally {
      openLog.disable();
    }

    expect(await readFile(target, "utf8")).toBe('{"a":1}\n');
    const names = await readdir(scratch);
    expect(names).toEqual(["ticket_x.jsonc"]);

    // No `open(dir, "r")` call at all — that's fsyncDir's signature call,
    // and it must never fire on win32.
    const dirOpens = openLog.calls.filter((call) => call.flags === "r");
    expect(dirOpens).toEqual([]);
  });

  it("on win32, still fsyncs newly-created directories were mkdir self-healed (only the FINAL directory fsync is skipped)", async () => {
    // fsyncNewlyCreatedDirChain calls fsyncDir too — on win32 every one of
    // those calls must also no-op, not just the post-rename one.
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const missingDir = join(scratch, "sessions");
    const target = join(missingDir, "session_x.jsonc");
    openLog.enable();
    try {
      await atomicWriteFile(target, "{}\n");
    } finally {
      openLog.disable();
    }

    expect(await readFile(target, "utf8")).toBe("{}\n");
    const dirOpens = openLog.calls.filter((call) => call.flags === "r");
    expect(dirOpens).toEqual([]);
  });

  it("explicitly on posix (linux), still fsyncs the containing directory — unchanged from before this guard existed", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const target = join(scratch, "ticket_y.jsonc");
    openLog.enable();
    try {
      await atomicWriteFile(target, "{}\n");
    } finally {
      openLog.disable();
    }

    expect(await readFile(target, "utf8")).toBe("{}\n");
    const dirOpens = openLog.calls.filter((call) => call.flags === "r").map((call) => call.path);
    expect(dirOpens).toContain(scratch);
  });
});
