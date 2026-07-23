/**
 * Git autodetection for `slop init` (D1: "Autodetect `remotes.repo` from
 * the git remote ... Autodetect `project` from the repo/directory name
 * and `user` per D17's config rung (fall back to `git config
 * user.name`)"). Every function here degrades to `null` on any failure
 * (not a git repo, no remote configured, `git` not on `$PATH`, ...) —
 * `slop init` must always be able to fall back to a bare, working
 * `config.yaml` rather than block or throw on missing git context.
 */
import { execFileSync } from "node:child_process";

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** `git rev-parse --show-toplevel` — the repo root, or `null` if `cwd` isn't inside a git repo. */
export function getGitTopLevel(cwd: string): string | null {
  const out = runGit(["rev-parse", "--show-toplevel"], cwd);
  return out && out.length > 0 ? out : null;
}

/** `origin`'s remote URL, or `null` if there's no git repo / no such remote. */
export function getGitRemoteUrl(cwd: string, remoteName = "origin"): string | null {
  const out = runGit(["config", "--get", `remote.${remoteName}.url`], cwd);
  return out && out.length > 0 ? out : null;
}

/** `git config user.name` (repo-local, falling back to global per git's own resolution), or `null`. */
export function getGitUserName(cwd: string): string | null {
  const out = runGit(["config", "user.name"], cwd);
  return out && out.length > 0 ? out : null;
}

/**
 * Normalise a git remote URL to `https://host/org/repo` (D1: "normalise
 * an SSH remote like `git@github.com:org/repo.git` to an https URL").
 * Returns `null` for anything this can't confidently turn into an https
 * URL (leaving `remotes.repo` unset is the correct degrade — see
 * config.ts, `repo` is `.optional()`).
 */
export function normalizeGitRemoteToHttps(remote: string): string | null {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return null;

  // `git@host:org/repo.git` (the common SSH shorthand form — no `ssh://`,
  // no port).
  const scpMatch = /^[\w.-]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scpMatch) {
    const [, host, path] = scpMatch;
    return `https://${host}/${path}`;
  }

  // `ssh://git@host[:port]/org/repo.git`
  const sshMatch = /^ssh:\/\/[\w.-]+@([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (sshMatch) {
    const [, host, path] = sshMatch;
    return `https://${host}/${path}`;
  }

  // Already http(s) — just strip a trailing `.git` for a clean URL.
  if (/^https?:\/\//.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      url.pathname = url.pathname.replace(/\.git\/?$/, "");
      return url.toString().replace(/\/$/, "");
    } catch {
      return null;
    }
  }

  // Anything else (git://, file://, a bare local path, …) — detection
  // fails gracefully; the operator can still set `remotes.repo` by hand.
  return null;
}
