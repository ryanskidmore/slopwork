import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { computeGitignoreLines } from "../../src/cli/init/gitignore.js";
import type { SessionId, TicketId } from "../../src/core/index.js";
import type { RepoPaths } from "../../src/repo/index.js";
import { readSession, readTicket, repoPaths } from "../../src/repo/index.js";

// C4: Transcript capture
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "End a real Claude Code session → transcript lands in
//   `.slop/transcripts/`; missing transcript warns, never blocks"
//
// v0-implementation-plan.md §6 risk 2 flags this as "the least specifiable
// item" — harness internals are undocumented and shift — so both halves of
// the criterion get first-class coverage here: the happy path (a real
// Claude Code session, simulated via a fake `~/.claude`-shaped tree so this
// suite never touches the real one — see `SLOP_TEST_CLAUDE_HOME` in
// src/sessions/transcript.ts) AND the never-block guarantee (missing
// transcript -> warn, exit 0, state still changes). Driven as a real CLI
// throughout (spawning the compiled `dist/slop` binary), fixtures built via
// `slop init` + `slop new` + `slop start`, per this project's convention
// for anything that must be exercised as a genuine process.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
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
// Fixture/spawn helpers
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Every harness-identity env var any real harness sets, stripped by
 * default (see tests/acceptance/C1.test.ts's identical rationale: this
 * suite must not accidentally inherit a real CLAUDECODE=1 from its own
 * ambient environment). `SLOP_TEST_CLAUDE_HOME` is this item's own
 * test-only knob (src/sessions/transcript.ts) — also stripped by default
 * so "no fake home configured" tests are genuinely testing that. */
const STRIPPED_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "OPENCODE",
  "OPENCODE_PID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_HOME",
  "SLOP_TEST_CLAUDE_HOME",
] as const;

function runSlop(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  const env: Record<string, string | undefined> = { ...process.env, SLOP_ACTOR: "c4-test-actor" };
  for (const key of STRIPPED_ENV_KEYS) env[key] = undefined;
  for (const [k, v] of Object.entries(envOverrides)) env[k] = v;
  return spawnSync(binaryPath, args, { cwd, encoding: "utf8", env });
}

async function makeFixtureRepo(): Promise<{ root: string; paths: RepoPaths }> {
  const root = await mkdtemp(join(tmpdir(), "slop-c4-cli-"));
  scratchDirs.push(root);
  const init = runSlop(["init", "--yes", "--project", "c4-fixture", "--user", "ryan"], root);
  expect(init.status, init.stderr).toBe(0);
  return { root, paths: repoPaths(root) };
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

function newTicket(root: string, name: string): { id: TicketId; slug: string } {
  const result = runSlop(["new", name], root);
  expect(result.status, result.stderr).toBe(0);
  const m = CREATED_LINE.exec(result.stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(
      `could not parse "created <id> (slug: <slug>)" out of stdout:\n${result.stdout}`,
    );
  }
  return { id: m[1] as TicketId, slug: m[2] };
}

/** findings.md §3.1's observed rule: every `/` and every `.` in the cwd
 * becomes `-`. Reimplemented independently here (not imported from
 * src/sessions/transcript.ts) so this test isn't just checking the
 * implementation against itself. */
function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

async function writeFakeClaudeTranscript(
  fakeClaudeHome: string,
  cwd: string,
  sessionId: string,
  lines: string[],
): Promise<string> {
  const dir = join(fakeClaudeHome, "projects", encodeClaudeCwd(cwd));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

/** A small, shape-realistic Claude Code transcript (findings.md §4): a
 * user turn followed by an assistant turn. Content only, never inspected
 * for meaning — capture is a byte-for-byte copy either way. */
function realisticTranscriptLines(sessionId: string): string[] {
  return [
    JSON.stringify({
      type: "user",
      uuid: "11111111-1111-1111-1111-111111111111",
      sessionId,
      message: { role: "user", content: "please fix the bug" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "22222222-2222-2222-2222-222222222222",
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    }),
  ];
}

async function activeSessionId(paths: RepoPaths, ticketId: TicketId): Promise<SessionId> {
  const ticket = await readTicket(paths, ticketId);
  if (ticket.active_session === null) {
    throw new Error(`ticket ${ticketId} has no active session`);
  }
  return ticket.active_session;
}

// ---------------------------------------------------------------------------
// Clause 1: "End a real Claude Code session → transcript lands in
// `.slop/transcripts/`"
// ---------------------------------------------------------------------------

describe("C4: Transcript capture", () => {
  describe('"End a real Claude Code session → transcript lands in `.slop/transcripts/`"', () => {
    it("a real claude-code start+stop, with a fake ~/.claude tree, copies the transcript byte-for-byte and sets transcript_ref", async () => {
      const { root, paths } = await makeFixtureRepo();
      const { slug, id } = newTicket(root, "Fix the flaky test");

      const fakeClaudeHome = await mkdtemp(join(tmpdir(), "slop-c4-fake-claude-home-"));
      scratchDirs.push(fakeClaudeHome);
      const sessionUuid = "e918eac1-44bc-4d17-84dd-9a68736f92e4";
      const lines = realisticTranscriptLines(sessionUuid);
      const sourceFile = await writeFakeClaudeTranscript(fakeClaudeHome, root, sessionUuid, lines);

      const started = runSlop(["start", slug], root, {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: sessionUuid,
      });
      expect(started.status, started.stderr).toBe(0);

      const sessionId = await activeSessionId(paths, id);

      const stopped = runSlop(["stop", slug, "--note", "handed off"], root, {
        SLOP_TEST_CLAUDE_HOME: fakeClaudeHome,
      });
      expect(stopped.status, stopped.stderr).toBe(0);
      // No "could not locate" warning should have fired — this run must
      // have genuinely found the fake transcript, not silently missed it.
      expect(stopped.stderr).not.toMatch(/could not locate a transcript/i);

      const session = await readSession(paths, sessionId);
      expect(session.transcript_ref).toBe(`transcripts/${sessionId}.jsonl`);

      const expectedOnDiskPath = join(root, ".slop", "transcripts", `${sessionId}.jsonl`);
      expect(existsSync(expectedOnDiskPath)).toBe(true);
      const copied = await readFile(expectedOnDiskPath, "utf8");
      const original = await readFile(sourceFile, "utf8");
      expect(copied).toBe(original);
      expect(copied).toContain("please fix the bug");

      // `stop`'s own stdout surfaces the ref too (human-visible confirmation).
      expect(stopped.stdout).toContain(`transcripts/${sessionId}.jsonl`);
    });

    it("concurrency: two sessions in the SAME repo (same cwd) with DIFFERENT captured session ids resolve to their OWN transcripts, never 'newest wins'", async () => {
      const { root, paths } = await makeFixtureRepo();
      const ticketA = newTicket(root, "Ticket A");
      const ticketB = newTicket(root, "Ticket B");

      const fakeClaudeHome = await mkdtemp(join(tmpdir(), "slop-c4-fake-claude-home-"));
      scratchDirs.push(fakeClaudeHome);

      const uuidA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const uuidB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

      // B's file is written FIRST (older mtime), A's SECOND (newer mtime)
      // — deliberately the reverse of start order, so a naive
      // "newest-mtime-in-this-project-dir" implementation would wrongly
      // hand BOTH sessions A's transcript.
      const fileB = await writeFakeClaudeTranscript(fakeClaudeHome, root, uuidB, [
        JSON.stringify({ type: "user", sessionId: uuidB, message: { role: "user", content: "B" } }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const fileA = await writeFakeClaudeTranscript(fakeClaudeHome, root, uuidA, [
        JSON.stringify({ type: "user", sessionId: uuidA, message: { role: "user", content: "A" } }),
      ]);

      const startedA = runSlop(["start", ticketA.slug], root, {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: uuidA,
      });
      expect(startedA.status, startedA.stderr).toBe(0);
      const startedB = runSlop(["start", ticketB.slug], root, {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: uuidB,
      });
      expect(startedB.status, startedB.stderr).toBe(0);

      const sessionIdA = await activeSessionId(paths, ticketA.id);
      const sessionIdB = await activeSessionId(paths, ticketB.id);

      // Stop B FIRST — if this resolved to "newest in the dir" it would
      // incorrectly grab A's (newer) file.
      const stoppedB = runSlop(["stop", ticketB.slug, "--note", "b done"], root, {
        SLOP_TEST_CLAUDE_HOME: fakeClaudeHome,
      });
      expect(stoppedB.status, stoppedB.stderr).toBe(0);
      const stoppedA = runSlop(["stop", ticketA.slug, "--note", "a done"], root, {
        SLOP_TEST_CLAUDE_HOME: fakeClaudeHome,
      });
      expect(stoppedA.status, stoppedA.stderr).toBe(0);

      const sessionA = await readSession(paths, sessionIdA);
      const sessionB = await readSession(paths, sessionIdB);

      const copiedA = await readFile(
        join(root, ".slop", "transcripts", `${sessionIdA}.jsonl`),
        "utf8",
      );
      const copiedB = await readFile(
        join(root, ".slop", "transcripts", `${sessionIdB}.jsonl`),
        "utf8",
      );

      expect(sessionA.transcript_ref).toBe(`transcripts/${sessionIdA}.jsonl`);
      expect(sessionB.transcript_ref).toBe(`transcripts/${sessionIdB}.jsonl`);
      expect(copiedA).toBe(await readFile(fileA, "utf8"));
      expect(copiedB).toBe(await readFile(fileB, "utf8"));
      expect(copiedA).toContain('"content":"A"');
      expect(copiedB).toContain('"content":"B"');
    });
  });

  // ---------------------------------------------------------------------------
  // Clause 2: "missing transcript warns, never blocks" — LOAD-BEARING
  // ---------------------------------------------------------------------------

  describe('"missing transcript warns, never blocks"', () => {
    it("stop with NO locatable transcript still exits 0, still changes ticket state, warns on stderr, and records transcript_ref: null", async () => {
      const { root, paths } = await makeFixtureRepo();
      const { slug, id } = newTicket(root, "Untraceable session");

      // No CLAUDECODE etc -> harness "other" -> zero auto-detection.
      const started = runSlop(["start", slug], root);
      expect(started.status, started.stderr).toBe(0);
      const sessionId = await activeSessionId(paths, id);

      const beforeTicket = await readTicket(paths, id);
      expect(beforeTicket.state).toBe("in_progress");

      // No SLOP_TEST_CLAUDE_HOME, no --transcript: genuinely nothing to find.
      const stopped = runSlop(["stop", slug, "--note", "nothing to hand off"], root);

      // The whole point of this clause: never blocks.
      expect(stopped.status, `stop must exit 0 even with no transcript: ${stopped.stderr}`).toBe(0);

      expect(stopped.stderr).toMatch(/warning:.*could not locate a transcript/i);
      expect(stopped.stderr).toContain(sessionId);

      const session = await readSession(paths, sessionId);
      expect(session.transcript_ref).toBeNull();
      expect(session.ended_at).not.toBeNull();

      // The ticket state genuinely changed (in_progress -> open), proving
      // the transcript miss did not block the state transition either.
      const afterTicket = await readTicket(paths, id);
      expect(afterTicket.state).toBe("open");
      expect(afterTicket.active_session).toBeNull();
      expect(afterTicket.state).not.toBe(beforeTicket.state);

      expect(existsSync(join(root, ".slop", "transcripts", `${sessionId}.jsonl`))).toBe(false);
    });

    it("codex harness with nothing under $CODEX_HOME also warns-and-succeeds, not just claude-code/other", async () => {
      const { root, paths } = await makeFixtureRepo();
      const { slug, id } = newTicket(root, "Codex ticket");
      const fakeCodexHome = await mkdtemp(join(tmpdir(), "slop-c4-fake-codex-home-"));
      scratchDirs.push(fakeCodexHome);

      const started = runSlop(["start", slug, "--harness", "codex"], root);
      expect(started.status, started.stderr).toBe(0);
      const sessionId = await activeSessionId(paths, id);

      const stopped = runSlop(["stop", slug], root, { CODEX_HOME: fakeCodexHome });
      expect(stopped.status, stopped.stderr).toBe(0);
      expect(stopped.stderr).toMatch(/could not locate a transcript/i);

      const session = await readSession(paths, sessionId);
      expect(session.transcript_ref).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Clause 3 (implicit in "transcript capture ... --transcript fallback",
  // v0-implementation-plan.md §3's item body): the manual escape hatch.
  // ---------------------------------------------------------------------------

  describe("`--transcript <path>` fallback", () => {
    it("copies an explicitly given file regardless of harness (including 'other', the default no-detection case)", async () => {
      const { root, paths } = await makeFixtureRepo();
      const { slug, id } = newTicket(root, "Manual transcript ticket");

      const manualFile = join(root, "manual-transcript.jsonl");
      await writeFile(manualFile, '{"hand":"written"}\n{"second":"line"}\n', "utf8");

      const started = runSlop(["start", slug], root);
      expect(started.status, started.stderr).toBe(0);
      const sessionId = await activeSessionId(paths, id);

      const stopped = runSlop(["stop", slug, "--transcript", manualFile], root);
      expect(stopped.status, stopped.stderr).toBe(0);
      expect(stopped.stderr).not.toMatch(/could not locate a transcript/i);

      const session = await readSession(paths, sessionId);
      expect(session.transcript_ref).toBe(`transcripts/${sessionId}.jsonl`);
      const copied = await readFile(
        join(root, ".slop", "transcripts", `${sessionId}.jsonl`),
        "utf8",
      );
      expect(copied).toBe('{"hand":"written"}\n{"second":"line"}\n');
    });

    it("a --transcript pointing at a nonexistent file degrades to the normal (here: empty) auto-detection result, still never blocking", async () => {
      const { root, paths } = await makeFixtureRepo();
      const { slug, id } = newTicket(root, "Bad manual path ticket");

      const started = runSlop(["start", slug], root);
      expect(started.status, started.stderr).toBe(0);
      const sessionId = await activeSessionId(paths, id);

      const stopped = runSlop(
        ["stop", slug, "--transcript", join(root, "nope-does-not-exist.jsonl")],
        root,
      );
      expect(stopped.status, stopped.stderr).toBe(0);
      expect(stopped.stderr).toMatch(/could not locate a transcript/i);
      expect(stopped.stderr).toContain("nope-does-not-exist.jsonl");

      const session = await readSession(paths, sessionId);
      expect(session.transcript_ref).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // D16: `transcripts: local | commit | off`
  // ---------------------------------------------------------------------------

  describe("D16: `transcripts: local|commit|off`", () => {
    async function setTranscriptsMode(
      root: string,
      mode: "local" | "commit" | "off",
    ): Promise<void> {
      const configPath = join(root, ".slop", "config.yaml");
      const text = readFileSync(configPath, "utf8");
      expect(
        /^transcripts: \S+/m.test(text),
        "the config.yaml transcripts: line must exist to be rewritten",
      ).toBe(true);
      const rewritten = text.replace(/^transcripts: \S+/m, `transcripts: ${mode}`);
      await writeFile(configPath, rewritten, "utf8");
    }

    it("`off` skips capture entirely: transcript_ref stays null, no 'could not locate' warning, no file written — even with a real transcript sitting right there", async () => {
      const { root, paths } = await makeFixtureRepo();
      await setTranscriptsMode(root, "off");
      const { slug, id } = newTicket(root, "Off mode ticket");

      const manualFile = join(root, "would-have-been-captured.jsonl");
      await writeFile(manualFile, "{}\n", "utf8");

      const started = runSlop(["start", slug], root);
      expect(started.status, started.stderr).toBe(0);
      const sessionId = await activeSessionId(paths, id);

      const stopped = runSlop(
        ["stop", slug, "--note", "off mode", "--transcript", manualFile],
        root,
      );
      expect(stopped.status, stopped.stderr).toBe(0);
      expect(stopped.stderr).not.toMatch(/could not locate a transcript/i);

      const session = await readSession(paths, sessionId);
      expect(session.transcript_ref).toBeNull();
      const ticket = await readTicket(paths, id);
      expect(ticket.state).toBe("open");
      expect(existsSync(join(root, ".slop", "transcripts", `${sessionId}.jsonl`))).toBe(false);
    });

    it("`local` and `commit` both capture identically — the mode only changes gitignore handling, never capture itself", async () => {
      for (const mode of ["local", "commit"] as const) {
        const { root, paths } = await makeFixtureRepo();
        await setTranscriptsMode(root, mode);
        const { slug, id } = newTicket(root, `${mode} mode ticket`);

        const manualFile = join(root, "src.jsonl");
        await writeFile(manualFile, `{"mode":"${mode}"}\n`, "utf8");

        const started = runSlop(["start", slug], root);
        expect(started.status, started.stderr).toBe(0);
        const sessionId = await activeSessionId(paths, id);

        const stopped = runSlop(["stop", slug, "--transcript", manualFile], root);
        expect(stopped.status, `mode=${mode}: ${stopped.stderr}`).toBe(0);

        const session = await readSession(paths, sessionId);
        expect(session.transcript_ref, `mode=${mode}`).toBe(`transcripts/${sessionId}.jsonl`);
        const copied = await readFile(
          join(root, ".slop", "transcripts", `${sessionId}.jsonl`),
          "utf8",
        );
        expect(copied, `mode=${mode}`).toBe(`{"mode":"${mode}"}\n`);
      }
    });

    // D1's init-time gitignore logic (src/cli/init/gitignore.ts) already
    // omits `.slop/transcripts/` specifically for `commit` mode — verified
    // directly against its own exported function (D1's own module, not
    // reimplemented here) rather than only through a fresh `slop init`
    // (which has no `--transcripts` flag to select a mode at init time in
    // v0 — see this file's note in the work item report about re-running
    // init after a hand-edited config not auto-rewriting .gitignore).
    it("D1's computeGitignoreLines omits `.slop/transcripts/` only for `commit` mode (confirms the D16 interaction)", () => {
      expect(computeGitignoreLines("local")).toContain(".slop/transcripts/");
      expect(computeGitignoreLines("off")).toContain(".slop/transcripts/");
      expect(computeGitignoreLines("commit")).not.toContain(".slop/transcripts/");
    });

    it("a fresh `slop init` (default transcripts: local) DOES gitignore .slop/transcripts/", async () => {
      const { root } = await makeFixtureRepo();
      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      expect(gitignore).toContain(".slop/transcripts/");
    });
  });
});
