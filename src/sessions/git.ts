/**
 * Git context capture at `start` time (design.md §4.1 item 3's Session
 * `git: {branch, commit_at_start}`; §4.3) — work item C1.
 *
 * Deliberately a small self-contained `execFileSync` wrapper rather than
 * an import from `src/cli/init/git.ts` — that module is D1's (off limits
 * per the C1 brief's ground rules) — mirroring the same reasoning
 * `src/cli/actor.ts`'s `gitUserName` already documents for the identical
 * situation.
 *
 * Both `branch` and `commit_at_start` are independently nullable and MUST
 * degrade gracefully rather than throw or block `start` (C1 brief):
 *   - not a git repository at all -> both `null`.
 *   - detached HEAD (a checked-out commit, no branch) -> `branch: null`,
 *     `commit_at_start` still populated.
 *   - a real repo with no commits yet -> `commit_at_start: null`; `branch`
 *     may still resolve (git reports the *pending* branch name — e.g.
 *     "main" — even before the first commit).
 */
import { execFileSync } from "node:child_process";
import type { SessionGit } from "../core/index.js";

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Current branch name, or `null` on detached HEAD / no commits yet in a way
 * git can't name / not a git repo at all. */
export function gitBranch(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  // `symbolic-ref` fails (non-zero exit) specifically on detached HEAD,
  // which is exactly the distinction plain `git branch --show-current`
  // blurs (it prints nothing on both detached HEAD AND "not a repo" with
  // no way to tell them apart from output alone — irrelevant here since
  // both degrade to `null` anyway, but `symbolic-ref` is the more precise
  // primitive and is what git itself uses internally for this question).
  return runGit(["symbolic-ref", "--short", "-q", "HEAD"], cwd, env);
}

/** The commit HEAD currently points at, or `null` if there is no commit yet
 * (a freshly `git init`'d repo) or this isn't a git repository at all. */
export function gitCommit(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return runGit(["rev-parse", "HEAD"], cwd, env);
}

/** Both halves of {@link SessionGit} together — never throws, see module doc. */
export function captureGit(cwd: string, env: NodeJS.ProcessEnv = process.env): SessionGit {
  return { branch: gitBranch(cwd, env), commit_at_start: gitCommit(cwd, env) };
}
