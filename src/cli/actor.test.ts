import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_CODES } from "../core/index.js";
import { ensureDbDirs } from "../repo/paths.js";
import type { RepoPaths } from "../repo/paths.js";
import { SlopError } from "./errors.js";
import { gitUserName, isAgentHarnessEnv, loadConfig, resolveActor } from "./actor.js";

let scratch: string;
let paths: RepoPaths;
let fakeHome: string;

/**
 * `git config user.name` reads the GLOBAL `~/.gitconfig` even outside any
 * repo, so a bare `process.env` would leak *this machine's* real git
 * identity into these tests. `HOME` pointed at an empty scratch dir plus
 * `GIT_CONFIG_NOSYSTEM=1` isolates every git call below from both the
 * global and system config, so "no git identity configured" is genuinely
 * reproducible in CI and dev alike.
 */
function isolatedGitEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // This test suite may itself be running inside a real agent harness
    // (e.g. Claude Code sets CLAUDECODE=1) — strip every harness signal
    // `isAgentHarnessEnv` looks at so "human" is genuinely reproducible,
    // the same reasoning tests/acceptance/D1.test.ts's `runSlop` documents.
    CLAUDECODE: undefined,
    OPENCODE: undefined,
    CODEX_SANDBOX: undefined,
    CODEX_SANDBOX_NETWORK_DISABLED: undefined,
    HOME: fakeHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(fakeHome, ".gitconfig"),
    ...overrides,
  };
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-actor-test-"));
  fakeHome = await mkdtemp(join(tmpdir(), "slop-actor-test-home-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
});

describe("gitUserName", () => {
  it("reads `git config user.name` from the given directory (repo-local config, unaffected by HOME)", () => {
    execFileSync("git", ["init", "-q"], { cwd: scratch, env: isolatedGitEnv() });
    execFileSync("git", ["config", "user.name", "Test Git User"], {
      cwd: scratch,
      env: isolatedGitEnv(),
    });
    expect(gitUserName(scratch, isolatedGitEnv())).toBe("Test Git User");
  });

  it("returns null when not in a git repo and no global identity is configured", () => {
    // scratch has no .git — ensureDbDirs only creates .slop/db. Isolated
    // HOME means there's no global config for git to fall back to either.
    expect(gitUserName(scratch, isolatedGitEnv())).toBeNull();
  });
});

describe("isAgentHarnessEnv (kind heuristic; reuses docs/spikes/findings.md §2's signals)", () => {
  it("detects Claude Code", () => {
    expect(isAgentHarnessEnv({ CLAUDECODE: "1" })).toBe(true);
  });

  it("detects opencode", () => {
    expect(isAgentHarnessEnv({ OPENCODE: "1" })).toBe(true);
  });

  it("detects codex via either sandbox var", () => {
    expect(isAgentHarnessEnv({ CODEX_SANDBOX_NETWORK_DISABLED: "1" })).toBe(true);
    expect(isAgentHarnessEnv({ CODEX_SANDBOX: "seatbelt" })).toBe(true);
  });

  it("is false for a plain shell env", () => {
    expect(isAgentHarnessEnv({})).toBe(false);
  });
});

describe("loadConfig", () => {
  it("reads and validates .slop/config.yaml", async () => {
    await writeFile(
      join(paths.slopDir, "config.yaml"),
      "project: test-project\nuser: ryan\n",
      "utf8",
    );
    const config = await loadConfig(paths);
    expect(config.project).toBe("test-project");
    expect(config.user).toBe("ryan");
  });

  it("throws an actionable SlopError when config.yaml is missing", async () => {
    await expect(loadConfig(paths)).rejects.toThrow(/slop init/);
  });
});

describe("resolveActor (D17: --as > SLOP_ACTOR > config user > git user.name)", () => {
  it("prefers --as over everything else", () => {
    const actor = resolveActor({
      asFlag: "flag-actor",
      config: null,
      cwd: scratch,
      env: isolatedGitEnv({ SLOP_ACTOR: "env-actor" }),
    });
    expect(actor.name).toBe("flag-actor");
  });

  it("falls back to SLOP_ACTOR", () => {
    const actor = resolveActor({
      config: null,
      cwd: scratch,
      env: isolatedGitEnv({ SLOP_ACTOR: "env-actor" }),
    });
    expect(actor.name).toBe("env-actor");
  });

  it("falls back to config.yaml's user:", () => {
    const actor = resolveActor({
      config: {
        project: "p",
        user: "config-actor",
        remotes: {},
        defaults: { stale_after: "60m", review_stale_after: "24h", lock_timeout: "5s" },
      },
      cwd: scratch,
      env: isolatedGitEnv(),
    });
    expect(actor.name).toBe("config-actor");
  });

  it("falls back to `git config user.name` last", () => {
    execFileSync("git", ["init", "-q"], { cwd: scratch, env: isolatedGitEnv() });
    execFileSync("git", ["config", "user.name", "Git Fallback"], {
      cwd: scratch,
      env: isolatedGitEnv(),
    });
    const actor = resolveActor({ config: null, cwd: scratch, env: isolatedGitEnv() });
    expect(actor.name).toBe("Git Fallback");
  });

  it("throws an actionable error when nothing resolves at all", () => {
    expect(() => resolveActor({ config: null, cwd: scratch, env: isolatedGitEnv() })).toThrow(
      /SLOP_ACTOR/,
    );
  });

  // cli-input-validation-reject-truncated-numerics-fix-actor-fai:
  // this used to throw `new SlopError(message)` with no exit-code
  // argument, which defaults to GENERIC_ERROR (1) — but an unresolvable
  // actor is a bad-invocation condition (fixable by passing --as, setting
  // SLOP_ACTOR, etc.), not an unexpected runtime failure, so it must carry
  // USAGE_ERROR (2), matching this function's own doc comment.
  it("the unresolvable-actor failure is a SlopError carrying USAGE_ERROR (exit 2), not GENERIC_ERROR", () => {
    try {
      resolveActor({ config: null, cwd: scratch, env: isolatedGitEnv() });
      throw new Error("expected resolveActor to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SlopError);
      expect((err as SlopError).exitCode).toBe(EXIT_CODES.USAGE_ERROR);
    }
  });

  it("resolves kind 'agent' under a detected harness env, 'human' otherwise", () => {
    const agent = resolveActor({
      asFlag: "x",
      config: null,
      cwd: scratch,
      env: isolatedGitEnv({ CLAUDECODE: "1" }),
    });
    expect(agent.kind).toBe("agent");
    const human = resolveActor({ asFlag: "x", config: null, cwd: scratch, env: isolatedGitEnv() });
    expect(human.kind).toBe("human");
  });

  // C1: `kind` is now formalised over the real HarnessKind sniff
  // (src/sessions/harness.ts), including its `--harness` override for
  // whichever command registers one (today, just `slop start`).
  it("an explicit harnessFlag wins over env sniffing for `kind`, same as the harness sniff itself (D17)", () => {
    const flaggedAgent = resolveActor({
      asFlag: "x",
      harnessFlag: "codex",
      config: null,
      cwd: scratch,
      env: isolatedGitEnv(), // no env harness signals at all
    });
    expect(flaggedAgent.kind).toBe("agent");

    const flaggedOther = resolveActor({
      asFlag: "x",
      harnessFlag: "other",
      config: null,
      cwd: scratch,
      // env DOES have a real harness signal, but --harness other overrides it
      env: isolatedGitEnv({ CLAUDECODE: "1" }),
    });
    expect(flaggedOther.kind).toBe("human");
  });

  it("without a harnessFlag, `kind` falls back to plain env sniffing (every non-`start` caller)", () => {
    const human = resolveActor({ asFlag: "x", config: null, cwd: scratch, env: isolatedGitEnv() });
    expect(human.kind).toBe("human");
  });
});
