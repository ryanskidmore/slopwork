import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SessionId, TicketId } from "../../src/core/index.js";
import { type Config, configSchema } from "../../src/core/index.js";
import type { RepoPaths } from "../../src/repo/index.js";
import { queryEvents, readSession, readTicket, repoPaths } from "../../src/repo/index.js";

// D1: `init` + agent onboarding
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "Fresh repo → `init` → a real agent follows the skill unaided through
//   one full ready→start→plan→review→done loop"
//
// The `ready`/`start`/`plan`/`review`/`done` loop this criterion names is
// B1/B4/C1/C2/C3 territory. C1-C3 have now landed, so the last describe
// block in this file ("the installed skill's loop", TODO(D1-loop) no
// longer a TODO) drives that loop for real. Everything else this file
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
      // Deliberately no `git init` at all — slopwork does not require git.
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
    it("installs .claude/skills/slopwork/SKILL.md when CLAUDECODE=1 is set", async () => {
      const dir = await makeScratchRepo("slop-d1-claude-yes-");
      const result = runSlop(["init", "--yes"], dir, { CLAUDECODE: "1" });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(dir, ".claude", "skills", "slopwork", "SKILL.md"))).toBe(true);
    });

    it("installs SKILL.md when a .claude/ directory already exists, even with CLAUDECODE unset", async () => {
      const dir = await makeScratchRepo("slop-d1-claude-dir-");
      execFileSync("mkdir", ["-p", join(dir, ".claude")]);
      const result = runSlop(["init", "--yes"], dir);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(dir, ".claude", "skills", "slopwork", "SKILL.md"))).toBe(true);
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
      const skillMd = readFileSync(join(dir, ".claude", "skills", "slopwork", "SKILL.md"), "utf8");
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
      expect(skillMd.startsWith("---\nname: slopwork\n")).toBe(true);
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
      const skillMd = readFileSync(join(dir, ".claude", "skills", "slopwork", "SKILL.md"), "utf8");
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

  // ---------------------------------------------------------------------------
  // D1-loop (was a TODO): "a real agent follows the skill unaided through
  // one full ready→start→plan→review→done loop"
  // ---------------------------------------------------------------------------
  //
  // C1-C3 have now landed, so this is the one clause of D1's criterion the
  // rest of this file couldn't exercise before. Two things have to be true
  // TOGETHER for the criterion to actually be satisfied, and this block
  // proves both, independently, against the real compiled binary:
  //
  //   1. The installed skill genuinely DOCUMENTS that loop, in that order,
  //      with those exact commands/flags. Checked by reading the real
  //      installed SKILL.md (its body is proven byte-identical to
  //      `.slop/AGENTS.md`/`slop instructions`' stdout by the "one source,
  //      three renderings" describe block above) and locating each step's
  //      command name/flag INSIDE it, in sequence — not merely "mentioned
  //      somewhere" (the "generated docs never mention a command that
  //      doesn't exist" describe block above already covers plain
  //      existence). This is the drift guard: if the loop steps ever get
  //      reordered, or a flag renamed, in the docs without the CLI
  //      following suit (or vice versa), this fails.
  //   2. That documented loop, executed via `dist/slop` exactly the way
  //      the docs instruct — never a hand-invented shortcut — actually
  //      produces the state changes/events/cascade the tracker promises.
  //      Checked purely black-box: CLI stdout/exit codes, plus `.slop/db`
  //      state read the same independent way `slop show`/`slop events`
  //      themselves would (never by inspecting an agent's reasoning —
  //      there is none here: this is a scripted stand-in issuing the
  //      exact commands/flags the rendered docs name, the same
  //      black-box, spawned-process style used throughout this file).
  describe("the installed skill's loop: ready → start → plan → update --progress → review --mr → done", () => {
    /**
     * Every harness-identity env var a real harness sets, stripped for
     * every loop step AFTER `init` (which needs CLAUDECODE=1 to install
     * the skill — see the "SKILL.md installation" describe block above).
     * Confirmed necessary by manual verification of this exact loop: left
     * unstripped, `start`/`review`/`done` detect THIS TEST PROCESS's own
     * real Claude Code session (this suite is routinely run from inside
     * one, via `CLAUDE_CODE_SESSION_ID`) and `review`/`done` then try to
     * locate-and-copy that live, multi-megabyte, still-being-written
     * transcript into the scratch repo. Stripping keeps the loop
     * deterministic and exercises exactly what an untagged/unknown
     * harness sees (`harness: "other"`) — the loop's own mechanics under
     * test don't depend on which harness got detected.
     */
    const LOOP_STRIPPED_ENV_KEYS = [
      "CLAUDECODE",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_CHILD_SESSION",
      "OPENCODE",
      "OPENCODE_PID",
      "CODEX_SANDBOX",
      "CODEX_SANDBOX_NETWORK_DISABLED",
      "CODEX_HOME",
    ] as const;

    function runLoopStep(args: string[], cwd: string) {
      const env: Record<string, string | undefined> = { ...process.env };
      for (const key of LOOP_STRIPPED_ENV_KEYS) env[key] = undefined;
      return spawnSync(binaryPath, args, { cwd, encoding: "utf8", env });
    }

    function parseJson<T>(result: { stdout: string; stderr: string }): T {
      try {
        return JSON.parse(result.stdout) as T;
      } catch (err) {
        throw new Error(
          `expected JSON stdout, got:\n${result.stdout}\n(stderr: ${result.stderr})\n${err}`,
        );
      }
    }

    /** Asserts every token in `tokensInOrder` occurs, in that literal
     * order, inside `haystack` — proving the documented loop is presented
     * as a SEQUENCE, not just that each command name appears somewhere. */
    function assertAppearsInOrder(
      haystack: string,
      tokensInOrder: readonly string[],
      label: string,
    ): void {
      let from = 0;
      for (const token of tokensInOrder) {
        const idx = haystack.indexOf(token, from);
        expect(
          idx,
          `expected "${token}" to appear (in order, at/after index ${from}) within ${label}. ` +
            `Full text:\n${haystack}`,
        ).toBeGreaterThanOrEqual(0);
        from = idx + token.length;
      }
    }

    /** Same idea as {@link assertAppearsInOrder}, over an already-tokenised
     * sequence (`slop events`' verb list) rather than raw prose. */
    function assertVerbsInOrder(
      actual: readonly string[],
      expectedInOrder: readonly string[],
    ): void {
      let from = 0;
      for (const verb of expectedInOrder) {
        const idx = actual.indexOf(verb, from);
        expect(
          idx,
          `expected event verb "${verb}" at/after index ${from} in [${actual.join(", ")}]`,
        ).toBeGreaterThanOrEqual(0);
        from = idx + 1;
      }
    }

    interface NewJson {
      id: string;
      slug: string;
      name: string;
      state: string;
    }

    interface ReadyJson {
      ready: { id: string; slug: string }[];
    }

    interface ShowJson {
      ticket: {
        review?: { mr?: string };
        latest_note: string | null;
        last_activity_at: string;
      };
    }

    interface StatusJson {
      review: { id: string; mr: string | null }[];
    }

    interface EventsJson {
      events: {
        verb: string;
        entity: { kind: string; id: string };
        payload: Record<string, unknown>;
      }[];
    }

    it(
      "SKILL.md documents the loop, in the criterion's own order: `ready` before `start` before " +
        "`plan` before `--check` before `update --progress` before `review --mr` before `done`",
      async () => {
        const dir = await makeScratchRepo("slop-d1-loop-docs-");
        const init = runSlop(["init", "--yes"], dir, { CLAUDECODE: "1" });
        expect(init.status, init.stderr).toBe(0);

        const skillMd = readFileSync(
          join(dir, ".claude", "skills", "slopwork", "SKILL.md"),
          "utf8",
        );

        // "Told 'pick up the next thing'" row: this is where the skill
        // documents `ready` at all — as the way an agent FINDS work
        // before `start`ing it (§3's criterion opens with "ready").
        const readyRow = skillMd
          .split("\n")
          .find((line) => line.includes("pick up the next thing"));
        expect(
          readyRow,
          "expected a 'pick up the next thing' row documenting `ready`",
        ).toBeDefined();
        assertAppearsInOrder(
          readyRow as string,
          ["slop ready", "slop start"],
          "the 'pick up the next thing' row",
        );

        // "## The loop" section: start -> plan -> --check -> update
        // --progress -> review --mr -> done, in that literal order.
        const loopStart = skillMd.indexOf("## The loop");
        expect(loopStart, "expected a '## The loop' section in SKILL.md").toBeGreaterThanOrEqual(0);
        const nextHeading = skillMd.indexOf("\n## ", loopStart + 1);
        const loopSection = skillMd.slice(loopStart, nextHeading === -1 ? undefined : nextHeading);
        assertAppearsInOrder(
          loopSection,
          [
            "slop start",
            "slop plan",
            "--check",
            "slop update",
            "--progress",
            "slop review",
            "--mr",
            "slop done",
          ],
          "the '## The loop' section",
        );
      },
    );

    it("a scripted stand-in drives `dist/slop`, unaided, through exactly the loop the skill documents " +
      "— new → ready → start → plan → plan --check → update --progress → review --mr → done — with " +
      "every step's outcome observable in CLI output and `.slop/db` state, including the done-cascade " +
      "unblocking a ticket this one blocks", async () => {
      const dir = await makeScratchRepo("slop-d1-loop-");
      const paths: RepoPaths = repoPaths(dir);

      // Fresh init (--yes: non-interactive), skill installed for real.
      const init = runSlop(["init", "--yes"], dir, { CLAUDECODE: "1" });
      expect(init.status, init.stderr).toBe(0);
      expect(existsSync(join(dir, ".claude", "skills", "slopwork", "SKILL.md"))).toBe(true);
      expect(existsSync(join(dir, ".slop", "AGENTS.md"))).toBe(true);

      // A dependent ticket, filed BEFORE the loop starts and blocked by
      // the loop ticket — proves the done-cascade closes the graph
      // (§4.7 item 1/3), not just that `done` flips one ticket's state.
      const dependent = parseJson<NewJson>(
        runLoopStep(["new", "Depends on the D1 loop ticket", "--json"], dir),
      );
      expect(dependent.state).toBe("open");

      // --- `slop new` ---
      const ticket = parseJson<NewJson>(
        runLoopStep(["new", "D1 loop ticket", "--blocks", dependent.slug, "--json"], dir),
      );
      expect(ticket.state).toBe("open");
      expect((await readTicket(paths, ticket.id as TicketId)).state).toBe("open");

      // --- `slop ready` — the new ticket is ready; the one it blocks is not ---
      const readyBefore = parseJson<ReadyJson>(runLoopStep(["ready", "--json"], dir));
      expect(readyBefore.ready.map((r) => r.id)).toContain(ticket.id);
      expect(readyBefore.ready.map((r) => r.id)).not.toContain(dependent.id);

      // --- `slop start <ref>` ---
      const startResult = runLoopStep(["start", ticket.slug], dir);
      expect(startResult.status, startResult.stderr).toBe(0);
      expect(startResult.stdout).toMatch(/^started session_/m);
      expect(startResult.stdout).toContain(`# Context: ${ticket.name}`); // context pack printed
      const startedTicket = await readTicket(paths, ticket.id as TicketId);
      expect(startedTicket.state).toBe("in_progress");
      const sessionId = startedTicket.active_session as SessionId;
      expect(sessionId).not.toBeNull();
      const startedSession = await readSession(paths, sessionId);
      expect(startedSession.ticket).toBe(ticket.id);
      expect(startedSession.ended_at).toBeNull();

      // --- `slop plan <ref> "step 1" "step 2"` then `--check 1` ---
      const planSetResult = runLoopStep(["plan", ticket.slug, "step one", "step two"], dir);
      expect(planSetResult.status, planSetResult.stderr).toBe(0);
      const planCheckResult = runLoopStep(["plan", ticket.slug, "--check", "1"], dir);
      expect(planCheckResult.status, planCheckResult.stderr).toBe(0);

      const plannedSession = await readSession(paths, sessionId);
      expect(plannedSession.plan).toHaveLength(1);
      expect(plannedSession.plan[0]?.steps.map((s) => s.text)).toEqual(["step one", "step two"]);
      expect(plannedSession.plan[0]?.steps[0]?.checked).toBe(true);
      expect(plannedSession.plan[0]?.steps[1]?.checked).toBe(false);

      // Visible via `show --context` too (§5.2: "one command to full
      // context"), not just via reads of the raw session file.
      const showContext = runLoopStep(["show", ticket.slug, "--context"], dir);
      expect(showContext.status, showContext.stderr).toBe(0);
      expect(showContext.stdout).toContain("1. [x] step one");
      expect(showContext.stdout).toContain("2. [ ] step two");

      // --- `slop update <ref> --progress "..."` ---
      // ticket_01KY9RWFM80BKNE2CDX85QMKGS: a pure `--progress` call is
      // lock-free — it appends an event and never rewrites the ticket
      // file at all, so the raw file's OWN `latest_note`/`last_activity_at`
      // stay exactly as they were; `show --json` (every read path, in
      // fact) reports the EFFECTIVE values instead, folding the new event
      // in at read time (src/repo/db-index.ts's `deriveEffectiveOverlay`).
      const beforeUpdate = await readTicket(paths, ticket.id as TicketId);
      const updateResult = runLoopStep(
        ["update", ticket.slug, "--progress", "made good progress on step one"],
        dir,
      );
      expect(updateResult.status, updateResult.stderr).toBe(0);
      const afterUpdate = await readTicket(paths, ticket.id as TicketId);
      expect(afterUpdate).toEqual(beforeUpdate); // the ticket FILE itself: untouched
      const showAfterUpdate = parseJson<ShowJson>(
        runLoopStep(["show", ticket.slug, "--json"], dir),
      );
      expect(showAfterUpdate.ticket.latest_note).toBe("made good progress on step one");
      expect(Date.parse(showAfterUpdate.ticket.last_activity_at)).toBeGreaterThanOrEqual(
        Date.parse(beforeUpdate.last_activity_at),
      );

      // --- `slop review <ref> --mr <url>` ---
      const mrUrl = "https://example.com/widgets/pull/42";
      const reviewResult = runLoopStep(["review", ticket.slug, "--mr", mrUrl], dir);
      expect(reviewResult.status, reviewResult.stderr).toBe(0);
      const reviewedTicket = await readTicket(paths, ticket.id as TicketId);
      expect(reviewedTicket.state).toBe("review");
      expect(reviewedTicket.review?.mr).toBe(mrUrl);
      // Visible via `show`/`status`, per the brief — not just internal state.
      const showJson = parseJson<ShowJson>(runLoopStep(["show", ticket.slug, "--json"], dir));
      expect(showJson.ticket.review?.mr).toBe(mrUrl);
      const statusJson = parseJson<StatusJson>(runLoopStep(["status", "--json"], dir));
      expect(statusJson.review.find((r) => r.id === ticket.id)?.mr).toBe(mrUrl);

      // --- `slop done <ref>` ---
      const doneResult = runLoopStep(["done", ticket.slug, "--note", "shipped and merged"], dir);
      expect(doneResult.status, doneResult.stderr).toBe(0);
      const doneTicket = await readTicket(paths, ticket.id as TicketId);
      expect(doneTicket.state).toBe("done");
      expect(doneTicket.active_session).toBeNull();
      const finalizedSession = await readSession(paths, sessionId);
      expect(finalizedSession.ended_at).not.toBeNull();
      expect(finalizedSession.end_summary).toBe("shipped and merged");

      // --- audit trail: `slop events` shows the full ordered sequence ---
      // (D3's `--ticket` widening pulls in the session's own lifecycle/
      // plan events too, not just the ticket entity's — see events.ts.)
      const loopEvents = parseJson<EventsJson>(
        runLoopStep(["events", "--ticket", ticket.slug, "--json"], dir),
      );
      assertVerbsInOrder(
        loopEvents.events.map((e) => e.verb),
        [
          "ticket.created",
          "session.started",
          "ticket.state_changed", // start: open -> in_progress
          "plan.set",
          "plan.step_checked",
          "ticket.updated", // update --progress
          "review.requested",
          "session.ended",
          "ticket.done",
        ],
      );

      // --- done-cascade: the ticket this one was blocking flips ready ---
      const dependentAfter = await readTicket(paths, dependent.id as TicketId);
      expect(dependentAfter.state).toBe("open");
      const readyAfter = parseJson<ReadyJson>(runLoopStep(["ready", "--json"], dir));
      expect(readyAfter.ready.map((r) => r.id)).toContain(dependent.id);
      expect(doneResult.stdout).toContain(dependent.id); // `done`'s own "unblocked: ..." line

      const dependentEvents = parseJson<EventsJson>(
        runLoopStep(["events", "--ticket", dependent.slug, "--json"], dir),
      );
      const readyEvent = dependentEvents.events.find((e) => e.verb === "ticket.ready");
      expect(
        readyEvent,
        "expected a ticket.ready event on the dependent after `done`",
      ).toBeDefined();
      expect(readyEvent?.payload.unblocked_by).toBe(ticket.id);
    }, 30_000);

    it(
      'house rule the skill teaches ("Only `slop done` after merge/verification — done means done") ' +
        "is now enforced as a soft nag, not a hard block (review is optional, " +
        "ticket_01KY9RWFDR9QEWQ5B1ZACQJ338): `done` on a ticket that was never sent through " +
        "`review` still succeeds, but warns on stderr rather than silently saying nothing",
      async () => {
        const dir = await makeScratchRepo("slop-d1-loop-house-rule-");
        const init = runSlop(["init", "--yes"], dir, { CLAUDECODE: "1" });
        expect(init.status, init.stderr).toBe(0);
        const paths: RepoPaths = repoPaths(dir);

        const ticket = parseJson<NewJson>(runLoopStep(["new", "Unreviewed ticket", "--json"], dir));
        expect(runLoopStep(["start", ticket.slug], dir).status).toBe(0);

        const doneResult = runLoopStep(["done", ticket.slug], dir);
        expect(doneResult.status, doneResult.stderr).toBe(0);
        expect(doneResult.stderr).toMatch(/warning:.*done without a review\/MR/i);
        expect(doneResult.stderr).toMatch(/slop review/);

        // Allowed, not refused: the ticket completes.
        const nowDone = await readTicket(paths, ticket.id as TicketId);
        expect(nowDone.state).toBe("done");

        // The event log agrees: ticket.done WAS written for it.
        const events = await queryEvents(paths, { ticket: ticket.id as TicketId });
        expect(events.some((e) => e.verb === "ticket.done")).toBe(true);
      },
    );
  });
});
