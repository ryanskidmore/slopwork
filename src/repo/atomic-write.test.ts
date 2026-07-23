import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SWEEP_MIN_AGE_MS,
  TEMP_FILE_PREFIX,
  atomicWriteFile,
  isTempFileName,
  sweepStaleTempFiles,
} from "./atomic-write.js";

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
    // A directory that doesn't exist as a write target's parent forces
    // `open(tmpPath, "wx")` to fail with ENOENT before anything is
    // written, exercising the catch-and-cleanup path.
    const missingDir = join(scratch, "does-not-exist");
    const target = join(missingDir, "ticket_x.jsonc");
    await expect(atomicWriteFile(target, "{}\n")).rejects.toThrow();
    // Nothing leaked into `scratch` itself.
    const names = await readdir(scratch);
    expect(names.filter(isTempFileName)).toHaveLength(0);
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
