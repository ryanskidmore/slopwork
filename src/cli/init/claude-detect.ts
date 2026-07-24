/**
 * Claude Code setup detection for `slop init` (work item D1: install
 * `.claude/skills/slopwork/SKILL.md` "when a Claude Code setup is
 * detected"). Detection signals per docs/spikes/findings.md §1.1 (S1, verified
 * directly against a live Claude Code session on this machine, and
 * cross-checked against Anthropic's own docs): `CLAUDECODE=1` is the
 * documented, positive-ID environment variable Claude Code sets for every
 * session. `.claude/` existing in the repo is the complementary
 * repo-shaped signal (a prior Claude Code setup — settings, other
 * skills — already lives here even if this particular `slop init` isn't
 * itself running inside a Claude Code session, e.g. a human running
 * `init` from a plain terminal in a repo they already use Claude Code
 * on).
 */
import { statSync } from "node:fs";
import { join } from "node:path";

/** Env-only half of detection — split out so callers/tests don't need a real directory to exercise it. */
export function claudeCodeEnvDetected(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDECODE === "1";
}

function hasClaudeDir(root: string): boolean {
  try {
    return statSync(join(root, ".claude")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `true` if either signal fires: the `CLAUDECODE=1` env var (this
 * process is itself running inside Claude Code), or a `.claude/`
 * directory already exists at `root` (this repo already has a Claude
 * Code setup, regardless of who's running `slop init` right now).
 */
export function detectClaudeCode(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return claudeCodeEnvDetected(env) || hasClaudeDir(root);
}
