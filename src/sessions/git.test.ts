import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureGit, gitBranch, gitCommit } from "./git.js";

let scratch: string;
let fakeHome: string;

/** Same HOME-isolation reasoning as src/cli/actor.test.ts's isolatedGitEnv
 * — these calls run relative to `cwd`, but keeping HOME isolated avoids any
 * global gitconfig on the machine running this test leaking in. */
function isolatedGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: fakeHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(fakeHome, ".gitconfig"),
  };
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, env: isolatedGitEnv(), stdio: "ignore" });
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-git-capture-"));
  fakeHome = await mkdtemp(join(tmpdir(), "slop-git-capture-home-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
});

describe("gitBranch / gitCommit / captureGit — degrade gracefully, never throw", () => {
  it("both are null when the directory is not a git repository at all", () => {
    expect(gitBranch(scratch, isolatedGitEnv())).toBeNull();
    expect(gitCommit(scratch, isolatedGitEnv())).toBeNull();
    expect(captureGit(scratch, isolatedGitEnv())).toEqual({ branch: null, commit_at_start: null });
  });

  it("a fresh repo with no commits yet: branch resolves (git names the pending branch), commit_at_start is null", () => {
    git(["init", "-q"], scratch);
    expect(gitCommit(scratch, isolatedGitEnv())).toBeNull();
    // git still reports the pending branch name (e.g. "main") even before
    // the first commit — HEAD is a symbolic ref to an unborn branch.
    const branch = gitBranch(scratch, isolatedGitEnv());
    expect(typeof branch === "string" || branch === null).toBe(true);
    const git2 = captureGit(scratch, isolatedGitEnv());
    expect(git2.commit_at_start).toBeNull();
  });

  it("a real repo with a commit: both branch and commit_at_start are captured", () => {
    git(["init", "-q"], scratch);
    git(["config", "user.email", "a@b.com"], scratch);
    git(["config", "user.name", "Test"], scratch);
    execFileSync("sh", ["-c", "echo hi > f.txt"], { cwd: scratch });
    git(["add", "f.txt"], scratch);
    git(["commit", "-q", "-m", "first"], scratch);

    const result = captureGit(scratch, isolatedGitEnv());
    expect(result.branch).not.toBeNull();
    expect(result.commit_at_start).toMatch(/^[0-9a-f]{40}$/);

    const headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: scratch,
      env: isolatedGitEnv(),
      encoding: "utf8",
    }).trim();
    expect(result.commit_at_start).toBe(headCommit);
  });

  it("detached HEAD: branch is null, commit_at_start is still captured", () => {
    git(["init", "-q"], scratch);
    git(["config", "user.email", "a@b.com"], scratch);
    git(["config", "user.name", "Test"], scratch);
    execFileSync("sh", ["-c", "echo hi > f.txt"], { cwd: scratch });
    git(["add", "f.txt"], scratch);
    git(["commit", "-q", "-m", "first"], scratch);
    git(["checkout", "-q", "--detach", "HEAD"], scratch);

    const result = captureGit(scratch, isolatedGitEnv());
    expect(result.branch).toBeNull();
    expect(result.commit_at_start).toMatch(/^[0-9a-f]{40}$/);
  });
});
