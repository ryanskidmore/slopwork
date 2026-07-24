import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SlopError } from "../cli/errors.js";
import { EXIT_CODES } from "../core/exit-codes.js";
import { ensureDbDirs, findRepoRoot, repoPaths, requireRepoRoot } from "./paths.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-paths-test-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("repoPaths", () => {
  it("derives the full db layout from a root", () => {
    const paths = repoPaths(scratch);
    expect(paths.root).toBe(scratch);
    expect(paths.slopDir).toBe(join(scratch, ".slop"));
    expect(paths.dbDir).toBe(join(scratch, ".slop", "db"));
    expect(paths.ticketsDir).toBe(join(scratch, ".slop", "db", "tickets"));
    expect(paths.sessionsDir).toBe(join(scratch, ".slop", "db", "sessions"));
    expect(paths.eventsDir).toBe(join(scratch, ".slop", "db", "events"));
    expect(paths.indexFile).toBe(join(scratch, ".slop", "db", "index.jsonc"));
    expect(paths.lockFile).toBe(join(scratch, ".slop", "db", ".lock"));
  });
});

describe("findRepoRoot / requireRepoRoot", () => {
  it("finds the root when cwd IS the root", async () => {
    await mkdir(join(scratch, ".slop"), { recursive: true });
    expect(findRepoRoot(scratch)).toBe(scratch);
  });

  it("walks up from a nested subdirectory to find .slop/", async () => {
    await mkdir(join(scratch, ".slop"), { recursive: true });
    const nested = join(scratch, "a", "b", "c");
    await mkdir(nested, { recursive: true });
    expect(findRepoRoot(nested)).toBe(scratch);
  });

  it("returns null when no .slop/ exists anywhere up to the filesystem root", async () => {
    const nested = join(scratch, "x", "y");
    await mkdir(nested, { recursive: true });
    expect(findRepoRoot(nested)).toBeNull();
  });

  it("does not treat a plain FILE named .slop as a repo marker", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(scratch, ".slop"), "not a directory");
    expect(findRepoRoot(scratch)).toBeNull();
  });

  it("requireRepoRoot throws NOT_FOUND (exit 4) with a clear message when absent", () => {
    let threw: unknown;
    try {
      requireRepoRoot(scratch);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SlopError);
    expect((threw as SlopError).exitCode).toBe(EXIT_CODES.NOT_FOUND);
    expect((threw as SlopError).message).toMatch(/not a slopwork repo/i);
    expect((threw as SlopError).message).toMatch(/slop init/);
  });

  it("requireRepoRoot returns the root when present", async () => {
    await mkdir(join(scratch, ".slop"), { recursive: true });
    expect(requireRepoRoot(scratch)).toBe(scratch);
  });
});

describe("ensureDbDirs", () => {
  it("creates tickets/, sessions/, events/ (the D1 directory-creation primitive)", async () => {
    const paths = await ensureDbDirs(scratch);
    for (const dir of [paths.ticketsDir, paths.sessionsDir, paths.eventsDir]) {
      const st = await stat(dir);
      expect(st.isDirectory()).toBe(true);
    }
  });

  it("is idempotent against an already-initialized repo", async () => {
    await ensureDbDirs(scratch);
    await expect(ensureDbDirs(scratch)).resolves.toBeDefined();
  });
});
