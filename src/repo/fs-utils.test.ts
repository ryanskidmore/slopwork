/**
 * Previously had no dedicated test file at all — `errorCode`/`isEnoent`/
 * `isEexist`/`readDirSafe` were only exercised indirectly through other
 * repo-layer modules that import them, leaving several of fs-utils.ts's
 * own branches (a non-error-shaped input to `errorCode`, `readDirSafe`'s
 * non-ENOENT rethrow) untested in isolation.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorCode, isEexist, isEnoent, isEnotempty, readDirSafe } from "./fs-utils.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-fs-utils-test-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("errorCode", () => {
  it("returns the string `code` off an error-shaped object", () => {
    expect(errorCode({ code: "ENOENT" })).toBe("ENOENT");
    expect(errorCode(new Error("boom") as unknown as { code?: string })).toBeUndefined();
  });

  it("returns undefined for null, non-objects, and objects with no `code` property", () => {
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode(undefined)).toBeUndefined();
    expect(errorCode("a string")).toBeUndefined();
    expect(errorCode(42)).toBeUndefined();
    expect(errorCode({})).toBeUndefined();
  });

  it("returns undefined when `code` is present but not a string", () => {
    expect(errorCode({ code: 42 })).toBeUndefined();
    expect(errorCode({ code: null })).toBeUndefined();
  });
});

describe("isEnoent / isEexist", () => {
  it("isEnoent is true only for code ENOENT", () => {
    expect(isEnoent({ code: "ENOENT" })).toBe(true);
    expect(isEnoent({ code: "EEXIST" })).toBe(false);
    expect(isEnoent(null)).toBe(false);
  });

  it("isEexist is true only for code EEXIST", () => {
    expect(isEexist({ code: "EEXIST" })).toBe(true);
    expect(isEexist({ code: "ENOENT" })).toBe(false);
    expect(isEexist(null)).toBe(false);
  });

  it("isEnotempty is true only for code ENOTEMPTY (t-7eq5s: best-effort shard-directory rmdir)", () => {
    expect(isEnotempty({ code: "ENOTEMPTY" })).toBe(true);
    expect(isEnotempty({ code: "ENOENT" })).toBe(false);
    expect(isEnotempty(null)).toBe(false);
  });
});

describe("readDirSafe", () => {
  it("lists entries in an existing directory", async () => {
    await writeFile(join(scratch, "a.txt"), "1", "utf8");
    await writeFile(join(scratch, "b.txt"), "2", "utf8");
    const names = await readDirSafe(scratch);
    expect([...names].sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("returns an empty array (never throws) when the directory doesn't exist (ENOENT)", async () => {
    const missing = join(scratch, "does-not-exist");
    await expect(readDirSafe(missing)).resolves.toEqual([]);
  });

  it("rethrows a non-ENOENT error (e.g. ENOTDIR: the path exists but isn't a directory)", async () => {
    const filePath = join(scratch, "not-a-directory.txt");
    await writeFile(filePath, "hello", "utf8");
    await expect(readDirSafe(filePath)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
