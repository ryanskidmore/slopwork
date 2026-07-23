import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getGitRemoteUrl,
  getGitTopLevel,
  getGitUserName,
  normalizeGitRemoteToHttps,
} from "./git.js";

describe("normalizeGitRemoteToHttps", () => {
  it("normalises the SSH shorthand form (D1's own example)", () => {
    expect(normalizeGitRemoteToHttps("git@github.com:org/repo.git")).toBe(
      "https://github.com/org/repo",
    );
  });

  it("normalises the SSH shorthand form without a trailing .git", () => {
    expect(normalizeGitRemoteToHttps("git@github.com:org/repo")).toBe(
      "https://github.com/org/repo",
    );
  });

  it("normalises a full ssh:// remote", () => {
    expect(normalizeGitRemoteToHttps("ssh://git@github.com/org/repo.git")).toBe(
      "https://github.com/org/repo",
    );
  });

  it("normalises a full ssh:// remote with a custom port", () => {
    expect(normalizeGitRemoteToHttps("ssh://git@example.com:2222/org/repo.git")).toBe(
      "https://example.com/org/repo",
    );
  });

  it("strips a trailing .git from an https remote", () => {
    expect(normalizeGitRemoteToHttps("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo",
    );
  });

  it("passes through an https remote with no .git suffix unchanged", () => {
    expect(normalizeGitRemoteToHttps("https://github.com/org/repo")).toBe(
      "https://github.com/org/repo",
    );
  });

  it("works against a self-hosted GitLab-style host too", () => {
    expect(normalizeGitRemoteToHttps("git@gitlab.example.com:group/sub/repo.git")).toBe(
      "https://gitlab.example.com/group/sub/repo",
    );
  });

  it("returns null for a remote it can't confidently normalise", () => {
    expect(normalizeGitRemoteToHttps("git://example.com/org/repo.git")).toBeNull();
    expect(normalizeGitRemoteToHttps("/local/path/to/repo.git")).toBeNull();
    expect(normalizeGitRemoteToHttps("")).toBeNull();
  });
});

describe("git detection against a real throwaway repo", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "slop-git-detect-"));
    execFileSync("git", ["init", "-q"], { cwd: scratch });
    execFileSync("git", ["config", "user.name", "D1 Test User"], { cwd: scratch });
    execFileSync("git", ["config", "user.email", "d1-test@example.com"], { cwd: scratch });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("getGitTopLevel finds the repo root", () => {
    expect(getGitTopLevel(scratch)).toBe(scratch);
  });

  it("getGitUserName reads the repo-local user.name", () => {
    expect(getGitUserName(scratch)).toBe("D1 Test User");
  });

  it("getGitRemoteUrl reads origin once configured", () => {
    expect(getGitRemoteUrl(scratch)).toBeNull();
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], {
      cwd: scratch,
    });
    expect(getGitRemoteUrl(scratch)).toBe("git@github.com:acme/widgets.git");
  });

  it("degrades to null outside any git repo", async () => {
    const nonRepo = await mkdtemp(join(tmpdir(), "slop-git-detect-non-repo-"));
    try {
      expect(getGitTopLevel(nonRepo)).toBeNull();
      expect(getGitRemoteUrl(nonRepo)).toBeNull();
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });
});
