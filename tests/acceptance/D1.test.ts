import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Config, configSchema } from "../../src/core/index.js";

// D1: `init` + agent onboarding
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "Fresh repo → `init` → a real agent follows the skill unaided through
//   one full ready→start→plan→review→done loop"
//
// The `ready`/`start`/`plan`/`review`/`done` loop this criterion names is
// B1/B4/C1/C2/C3 territory — none of those commands exist yet (see the
// TODO(D1-loop) comment at the end of this file for exactly what's
// deferred and why). Everything this file CAN exercise today, it
// exercises for real against the compiled `dist/slop` binary: a fresh
// throwaway git repo, `slop init` run non-interactively, the full
// `.slop/` layout + `config.yaml` autodetection + gitignore handling +
// generated-doc installation + idempotency + the non-interactive-never-
// blocks guarantee + the "one source, three renderings" clause + a live
// cross-check of every command name the generated docs mention against
// the real `slop --help` output.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
  // Same "build if missing" convention as A1.test.ts / D5.test.ts — this
  // suite must not assume `bun run build` already ran (project
  // convention runs `test` before `build`).
  if (!existsSync(binaryPath)) {
    execFileSync("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  }
  if (!existsSync(binaryPath)) {
    throw new Error(
      `${binaryPath} is still missing after attempting "bun run build". ` +
        'Run "bun run build" manually and re-run the tests.',
    );
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

async function makeScratchRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "D1 Agent"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "d1-agent@example.com"], { cwd: dir });
  return dir;
}

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Run the compiled binary with an explicit, controlled environment.
 * `CLAUDECODE` is deliberately stripped by default (not just "not set" —
 * genuinely removed) so tests asserting "Claude Code NOT detected" are
 * sound even when this whole test suite itself happens to be run from
 * inside a real Claude Code session (verified necessary in manual
 * testing: `CLAUDECODE=1` is otherwise inherited from this process's own
 * environment and would silently make every "not detected" assertion
 * vacuous).
 */
function runSlop(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string | undefined> = {},
) {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDECODE: undefined };
  for (const [k, v] of Object.entries(envOverrides)) env[k] = v;
  return spawnSync(binaryPath, args, { cwd, encoding: "utf8", env });
}

function readConfig(root: string): Config {
  const text = readFileSync(join(root, ".slop", "config.yaml"), "utf8");
  // Deliberately NOT importing src/cli/config-yaml.ts's parser here: this
  // acceptance test's job is to check the *real* CLI's output from the
  // outside, not to lean on the same module that produced it. A minimal,
  // independent parse is enough to pull out the handful of fields this
  // file asserts on, via config.yaml's own restricted (documented) shape.
  const obj: Record<string, unknown> = {};
  let currentNested: Record<string, unknown> | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.split(/\s+#/)[0] ?? "";
    if (line.trim().length === 0) continue;
    const indented = /^\s/.test(line);
    const [key, ...rest] = line.trim().split(":");
    const value = rest.join(":").trim().replace(/^"|"$/g, "");
    if (!indented) {
      if (value.length === 0) {
        currentNested = {};
        obj[key as string] = currentNested;
      } else {
        currentNested = null;
        obj[key as string] = value;
      }
    } else if (currentNested) {
      currentNested[key as string] = value;
    }
  }
  return configSchema.parse(obj);
}

// ---------------------------------------------------------------------------
// Fresh repo -> init -> full .slop/ layout + config.yaml autodetection
// ---------------------------------------------------------------------------

describe("D1: init + agent onboarding", () => {
  describe("fresh repo -> `slop init` -> full .slop/ layout", () => {
    it("creates the complete §3 db layout", async () => {
      const dir = await makeScratchRepo("slop-d1-layout-");
      const result = runSlop(["init", "--yes"], dir);
      expect(result.status, result.stderr).toBe(0);

      for (const rel of [
        ".slop/config.yaml",
        ".slop/AGENTS.md",
        ".slop/db/tickets",
        ".slop/db/sessions",
        ".slop/db/events",
        ".slop/transcripts",
      ]) {
        expect(existsSync(join(dir, rel)), `expected ${rel} to exist`).toBe(true);
      }
    });

    it("autodetects project (dir name), user (git config user.name), and repo (normalised SSH remote)", async () => {
      const dir = await makeScratchRepo("slop-d1-autodetect-");
      execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], {
        cwd: dir,
      });

      const result = runSlop(["init", "--yes"], dir);
      expect(result.status, result.stderr).toBe(0);

      const config = readConfig(dir);
      expect(config.project).toBe(basename(dir));
      expect(config.user).toBe("D1 Agent");
      expect(config.remotes.repo).toBe("https://github.com/acme/widgets");
      // Non-interactive, no --jira flag, no TTY: never prompted -> absent.
      expect(config.remotes.jira).toBeUndefined();
      expect(config.defaults.stale_after).toBe("60m");
      expect(config.defaults.review_stale_after).toBe("24h");
      expect(config.transcripts).toBe("local");
    });

    it("--project/--user/--jira override autodetection", async () => {
      const dir = await makeScratchRepo("slop-d1-flags-");
      const result = runSlop(
        [
          "init",
          "--project",
          "custom-name",
          "--user",
          "Custom User",
          "--jira",
          "https://x.atlassian.net",
        ],
        dir,
      );
      expect(result.status, result.stderr).toBe(0);

      const config = readConfig(dir);
      expect(config.project).toBe("custom-name");
      expect(config.user).toBe("Custom User");
      expect(config.remotes.jira).toBe("https://x.atlassian.net");
    });

    it("degrades gracefully with no git remote and no git user configured at all", async () => {
      const dir = await mkdtemp(join(tmpdir(), "slop-d1-nogit-"));
      scratchDirs.push(dir);
      // Deliberately no `git init` at all — slopworks does not require git.
      // `git config user.name` still falls back to *global*/system config
      // even outside a repo, so `HOME` is pointed at an empty, isolated
      // directory (with system/global config disabled outright) — without
      // this, the test would non-deterministically pick up whatever
      // `user.name` happens to be configured on the machine running it.
      const fakeHome = await mkdtemp(join(tmpdir(), "slop-d1-nogit-home-"));
      scratchDirs.push(fakeHome);
      const result = runSlop(["init", "--yes"], dir, {
        HOME: fakeHome,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(fakeHome, "nonexistent-gitconfig"),
      });
      expect(result.status, result.stderr).toBe(0);
      const config = readConfig(dir);
      expect(config.project).toBe(basename(dir));
      expect(config.user).toBeUndefined();
      expect(config.remotes.repo).toBeUndefined();
    });

    it("config.yaml parses cleanly against the real A2 zod schema", async () => {
      const dir = await makeScratchRepo("slop-d1-schema-");
      runSlop(["init", "--yes"], dir);
      const text = readFileSync(join(dir, ".slop", "config.yaml"), "utf8");
      // Round-trip through the exact same parser tests/D1 assertions use,
      // AND confirm the real CLI's own written bytes are schema-valid via
      // this file's independent mini-parser too (readConfig already did
      // configSchema.parse — this just re-asserts the intent explicitly).
      expect(() => configSchema.parse(readConfig(dir))).not.toThrow();
      expect(text).toMatch(/^project: /m);
    });
  });

  // ---------------------------------------------------------------------------
  // Gitignore entries (D14/D16)
  // ---------------------------------------------------------------------------

  describe("gitignore entries (D14/D16)", () => {
    it("always ignores .slop/db/index.jsonc, and ignores .slop/transcripts/ under the default transcripts: local", async () => {
      const dir = await makeScratchRepo("slop-d1-gitignore-local-");
      runSlop(["init", "--yes"], dir);
      const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
      expect(gitignore).toContain(".slop/db/index.jsonc");
      expect(gitignore).toContain(".slop/transcripts/");
    });

    it("does NOT ignore .slop/transcripts/ once config.yaml is set to transcripts: commit", async () => {
      const dir = await makeScratchRepo("slop-d1-gitignore-commit-");
      runSlop(["init", "--yes"], dir);

      const configPath = join(dir, ".slop", "config.yaml");
      const original = readFileSync(configPath, "utf8");
      writeFileSync(configPath, original.replace(/transcripts:.*/, "transcripts: commit"));

      // Re-running init refreshes the gitignore section against the
      // (hand-edited) current config, without touching config.yaml itself.
      const result = runSlop(["init", "--yes"], dir);
      expect(result.status, result.stderr).toBe(0);

      const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
      expect(gitignore).toContain(".slop/db/index.jsonc");
      expect(gitignore).not.toContain(".slop/transcripts/");

      // config.yaml itself was left untouched (still says transcripts: commit).
      const config = readConfig(dir);
      expect(config.transcripts).toBe("commit");
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency / safety
  // ---------------------------------------------------------------------------

  describe("re-running `init` is idempotent and destroys nothing", () => {
    it("survives a hand-created ticket file and does not duplicate gitignore lines", async () => {
      const dir = await makeScratchRepo("slop-d1-idempotent-");
      const first = runSlop(["init", "--yes"], dir);
      expect(first.status, first.stderr).toBe(0);

      const handTicketPath = join(
        dir,
        ".slop",
        "db",
        "tickets",
        "ticket_HANDCRAFTED0000000000001.jsonc",
      );
      writeFileSync(handTicketPath, '{ "hand": "crafted" }\n');
      const configBefore = readFileSync(join(dir, ".slop", "config.yaml"), "utf8");

      const second = runSlop(["init", "--yes"], dir);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toMatch(/already initialized/i);

      // The hand-created ticket file survives byte-for-byte.
      expect(readFileSync(handTicketPath, "utf8")).toBe('{ "hand": "crafted" }\n');
      // config.yaml is completely untouched.
      expect(readFileSync(join(dir, ".slop", "config.yaml"), "utf8")).toBe(configBefore);

      // gitignore has no duplicated lines.
      const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
      const indexLines = gitignore.split("\n").filter((l) => l.includes("index.jsonc"));
      expect(indexLines).toHaveLength(1);
      const transcriptLines = gitignore.split("\n").filter((l) => l.includes("transcripts/"));
      expect(transcriptLines).toHaveLength(1);

      // Running a third time is equally harmless.
      const third = runSlop(["init", "--yes"], dir);
      expect(third.status, third.stderr).toBe(0);
      expect(readFileSync(handTicketPath, "utf8")).toBe('{ "hand": "crafted" }\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Never blocks on a prompt when stdin is not a TTY
  // ---------------------------------------------------------------------------

  describe("never blocks on a prompt when stdin is not a TTY", () => {
    it("`slop init` (no --yes, no --jira) exits well within a short timeout against a real spawned process", async () => {
      const dir = await makeScratchRepo("slop-d1-no-hang-");

      const exited = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
        // Deliberately NOT --yes, NOT --jira: this is exactly the path
        // that would prompt if stdin were a TTY. child_process.spawn's
        // default stdio is a pipe (never a TTY, isTTY undefined) and is
        // left open (never explicitly ended) here — the same shape a
        // harness driving this CLI programmatically has. If `slop init`
        // ever attempted to read from it, this test would hang until the
        // timeout below.
        const proc: ChildProcess = spawn(binaryPath, ["init"], {
          cwd: dir,
          env: { ...process.env, CLAUDECODE: undefined },
        });
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          proc.kill("SIGKILL");
          resolve({ code: null, timedOut: true });
        }, 5_000);
        proc.once("exit", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, timedOut: false });
        });
      });

      expect(
        exited.timedOut,
        "slop init hung waiting on stdin instead of skipping the prompt",
      ).toBe(false);
      expect(exited.code).toBe(0);

      // And, per the D1 brief's "skip the prompt and leave it blank":
      // no --jira flag, no TTY -> never prompted -> the key is absent.
      const config = readConfig(dir);
      expect(config.remotes.jira).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Claude Code detection -> SKILL.md installed only when detected
  // ---------------------------------------------------------------------------

  describe("SKILL.md installation is gated on Claude Code detection", () => {
    it("installs .claude/skills/slopworks/SKILL.md when CLAUDECODE=1 is set", async () => {
      const dir = await makeScratchRepo("slop-d1-claude-yes-");
      const result = runSlop(["init", "--yes"], dir, { CLAUDECODE: "1" });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(dir, ".claude", "skills", "slopworks", "SKILL.md"))).toBe(true);
    });

    it("installs SKILL.md when a .claude/ directory already exists, even with CLAUDECODE unset", async () => {
      const dir = await makeScratchRepo("slop-d1-claude-dir-");
      execFileSync("mkdir", ["-p", join(dir, ".claude")]);
      const result = runSlop(["init", "--yes"], dir);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(dir, ".claude", "skills", "slopworks", "SKILL.md"))).toBe(true);
    });

    it("does NOT install SKILL.md (or create .claude/) when Claude Code isn't detected", async () => {
      const dir = await makeScratchRepo("slop-d1-claude-no-");
      const result = runSlop(["init", "--yes"], dir);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(dir, ".claude"))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // One source, three renderings — genuinely, not just at the unit level
  // ---------------------------------------------------------------------------

  describe("instructions / AGENTS.md / SKILL.md genuinely derive from one source", () => {
    it("a house rule present in AGENTS.md is present, verbatim, in `slop instructions`' stdout and in SKILL.md too", async () => {
      const dir = await makeScratchRepo("slop-d1-shared-source-");
      const result = runSlop(["init", "--yes"], dir, { CLAUDECODE: "1" });
      expect(result.status, result.stderr).toBe(0);

      const agentsMd = readFileSync(join(dir, ".slop", "AGENTS.md"), "utf8");
      const skillMd = readFileSync(join(dir, ".claude", "skills", "slopworks", "SKILL.md"), "utf8");
      const instructionsResult = runSlop(["instructions"], dir, { CLAUDECODE: "1" });
      expect(instructionsResult.status, instructionsResult.stderr).toBe(0);
      const instructionsOut = instructionsResult.stdout;

      // A distinctive, specific house rule (not a generic word) — proves
      // real shared content, not just superficial overlap.
      const distinctiveRule = "Stopping requires a handoff note";
      for (const doc of [agentsMd, skillMd, instructionsOut]) {
        expect(doc).toContain(distinctiveRule);
      }

      // SKILL.md carries frontmatter the other two don't.
      expect(skillMd.startsWith("---\nname: slopworks\n")).toBe(true);
      expect(agentsMd.startsWith("---")).toBe(false);
      expect(instructionsOut.startsWith("---")).toBe(false);

      // Beyond the frontmatter, the body itself is byte-identical across
      // all three — the strongest form of "one source, three renderings".
      const skillBody = skillMd.slice(skillMd.indexOf("\n---\n\n") + "\n---\n\n".length);
      expect(agentsMd).toBe(instructionsOut);
      expect(skillBody).toBe(agentsMd);
    });

    it("instructions/AGENTS.md/SKILL.md interpolate this project's actual project name and jira URL", async () => {
      const dir = await makeScratchRepo("slop-d1-interpolate-");
      const result = runSlop(
        ["init", "--project", "widget-factory", "--jira", "https://widgets.atlassian.net"],
        dir,
        { CLAUDECODE: "1" },
      );
      expect(result.status, result.stderr).toBe(0);

      const agentsMd = readFileSync(join(dir, ".slop", "AGENTS.md"), "utf8");
      expect(agentsMd).toContain("widget-factory");
      expect(agentsMd).toContain("https://widgets.atlassian.net");
    });
  });

  // ---------------------------------------------------------------------------
  // Every command the generated docs mention is a real command
  // ---------------------------------------------------------------------------

  describe("the generated docs never mention a command that doesn't exist", () => {
    it("every `slop <word>` token in AGENTS.md/SKILL.md/instructions names a real subcommand from `slop --help`", async () => {
      const dir = await makeScratchRepo("slop-d1-accuracy-");
      const initResult = runSlop(["init", "--yes"], dir, { CLAUDECODE: "1" });
      expect(initResult.status, initResult.stderr).toBe(0);

      const agentsMd = readFileSync(join(dir, ".slop", "AGENTS.md"), "utf8");
      const skillMd = readFileSync(join(dir, ".claude", "skills", "slopworks", "SKILL.md"), "utf8");
      const instructionsResult = runSlop(["instructions"], dir, { CLAUDECODE: "1" });
      expect(instructionsResult.status, instructionsResult.stderr).toBe(0);

      const combined = `${agentsMd}\n${skillMd}\n${instructionsResult.stdout}`;
      const mentioned = new Set<string>();
      for (const match of combined.matchAll(/\bslop ([a-z][a-z-]*)\b/g)) {
        const cmd = match[1];
        if (cmd) mentioned.add(cmd);
      }
      // Sanity: the docs really do mention a healthy number of distinct
      // commands, so this isn't vacuously passing over an empty set.
      expect(mentioned.size).toBeGreaterThanOrEqual(8);

      const helpResult = runSlop(["--help"], dir);
      expect(helpResult.status, helpResult.stderr).toBe(0);
      // Real subcommand lines are indented by EXACTLY two spaces in
      // commander's default help output; wrapped description
      // continuation lines (and the `-V`/`-h` option lines) are indented
      // further / differently — see this suite's manual verification
      // against the compiled binary's actual --help output.
      const realCommands = new Set<string>();
      for (const line of helpResult.stdout.split("\n")) {
        const match = /^ {2}([a-z][a-z-]*)\b/.exec(line);
        if (match?.[1]) realCommands.add(match[1]);
      }
      expect(realCommands.size).toBe(22); // design.md §4.2's full v0 command surface

      for (const cmd of mentioned) {
        expect(
          realCommands.has(cmd),
          `"slop ${cmd}" is mentioned in generated docs but is not a real command`,
        ).toBe(true);
      }
    });
  });

  // TODO(D1-loop): once C3 lands (review --mr / done / drop, completing
  // the B1/B4/C1/C2/C3 chain this file's header comment names), extend
  // this describe block with the acceptance criterion's still-untested
  // clause in full: seed a fresh repo via `slop init`, hand a *real*
  // agent (or a scripted stand-in driving the CLI the same way the
  // rendered SKILL.md instructs) nothing but this repo and the installed
  // skill, and drive it unaided through one complete
  // `ready` → `start` → `plan` → `update --progress` → `review --mr` →
  // `done` loop on a ticket created via `new`, asserting only on
  // observable `slop` output/exit codes/`.slop/db` state at each step
  // (never on the agent's internal reasoning) — the same black-box,
  // spawned-process style already used throughout this file.
});
