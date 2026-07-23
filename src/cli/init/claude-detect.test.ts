import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeEnvDetected, detectClaudeCode } from "./claude-detect.js";

describe("claudeCodeEnvDetected", () => {
  it("is true only for CLAUDECODE=1 exactly", () => {
    expect(claudeCodeEnvDetected({ CLAUDECODE: "1" })).toBe(true);
    expect(claudeCodeEnvDetected({ CLAUDECODE: "0" })).toBe(false);
    expect(claudeCodeEnvDetected({ CLAUDECODE: "true" })).toBe(false);
    expect(claudeCodeEnvDetected({})).toBe(false);
  });
});

describe("detectClaudeCode", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "slop-claude-detect-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("false when neither signal is present", () => {
    expect(detectClaudeCode(scratch, {})).toBe(false);
  });

  it("true from the CLAUDECODE=1 env var alone, no .claude/ dir needed", () => {
    expect(detectClaudeCode(scratch, { CLAUDECODE: "1" })).toBe(true);
  });

  it("true from an existing .claude/ directory alone, no env var needed", async () => {
    await mkdir(join(scratch, ".claude"), { recursive: true });
    expect(detectClaudeCode(scratch, {})).toBe(true);
  });

  it("a plain FILE named .claude does not count as a directory signal", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(scratch, ".claude"), "not a directory");
    expect(detectClaudeCode(scratch, {})).toBe(false);
  });
});
