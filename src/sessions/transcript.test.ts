import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  newSessionId,
  newTicketId,
  type Session,
  type SessionId,
  sessionSchema,
} from "../core/index.js";
import type { EventContext, MutationEventSpec } from "../repo/index.js";
import { createSession, ensureDbDirs, repoPaths } from "../repo/index.js";
import {
  captureTranscript,
  type LocateTranscriptRoots,
  locateTranscript,
  resolveTranscriptCapture,
  speculativeTranscriptCapture,
} from "./transcript.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-transcript-test-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function harness(kind: Harness["kind"], sessionId: string | null = null): Harness {
  return { kind, session_id: sessionId };
}

/** Shared fixture-session builder — module-scoped so both the original
 * `captureTranscript` suite and the Fix 1/Fix 2 suites below can use it. */
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_01ARZ3NDEKTSV4RRFFQ69G5FAV" as Session["id"],
    ticket: "ticket_01ARZ3NDEKTSV4RRFFQ69G5FAW" as Session["ticket"],
    actor: { name: "fixture", kind: "human" },
    harness: harness("other"),
    git: { branch: null, commit_at_start: null },
    started_at: "2026-07-23T10:00:00.000Z",
    ended_at: null,
    plan: [],
    end_summary: null,
    transcript_ref: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// locateTranscript — step 1: explicit --transcript path
// ---------------------------------------------------------------------------

describe("locateTranscript — step 1: explicit --transcript path", () => {
  it("returns the explicit path verbatim when it exists, for ANY harness kind including 'other'", async () => {
    const file = join(scratch, "manual.jsonl");
    await writeFile(file, '{"hello":"world"}\n', "utf8");

    for (const kind of ["claude-code", "opencode", "codex", "other"] as const) {
      expect(locateTranscript(harness(kind), scratch, file)).toBe(file);
    }
  });

  it("falls through to auto-detection (not a hard failure) when the explicit path doesn't exist", () => {
    const missing = join(scratch, "does-not-exist.jsonl");
    // 'other' has no auto-detection at all, so this proves the fallthrough
    // lands on a clean `null`, not a throw and not the (nonexistent) path.
    expect(locateTranscript(harness("other"), scratch, missing)).toBeNull();
  });

  it("ignores an empty-string or whitespace-only explicit path", () => {
    expect(locateTranscript(harness("other"), scratch, "")).toBeNull();
    expect(locateTranscript(harness("other"), scratch, "   ")).toBeNull();
  });

  it("rejects a directory given as the explicit path (not a regular file) and falls through", async () => {
    const dir = join(scratch, "a-directory.jsonl");
    await mkdir(dir);
    expect(locateTranscript(harness("other"), scratch, dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// locateTranscript — claude-code
// ---------------------------------------------------------------------------

describe("locateTranscript — claude-code", () => {
  async function fakeClaudeHome(): Promise<string> {
    const claudeHome = join(scratch, "fake-claude-home");
    await mkdir(claudeHome, { recursive: true });
    return claudeHome;
  }

  it("encodes the cwd (every / and . -> -) and finds <session_id>.jsonl at the exact path", async () => {
    const claudeHome = await fakeClaudeHome();
    const cwd = "/home/ryan/go/src/github.com/ryanskidmore/slopwork";
    const encoded = "-home-ryan-go-src-github-com-ryanskidmore-slopwork";
    const projectDir = join(claudeHome, "projects", encoded);
    await mkdir(projectDir, { recursive: true });
    const target = join(projectDir, "e918eac1-44bc-4d17-84dd-9a68736f92e4.jsonl");
    await writeFile(target, '{"type":"user"}\n', "utf8");

    const roots: LocateTranscriptRoots = { claudeHome };
    const found = locateTranscript(
      harness("claude-code", "e918eac1-44bc-4d17-84dd-9a68736f92e4"),
      cwd,
      undefined,
      roots,
    );
    expect(found).toBe(target);
  });

  it("never re-derives 'the current session' from mtime when a session id was captured: two concurrent sessions in the SAME cwd resolve to DIFFERENT transcripts, not 'newest wins'", async () => {
    const claudeHome = await fakeClaudeHome();
    const cwd = "/some/shared/cwd";
    const projectDir = join(claudeHome, "projects", "-some-shared-cwd");
    await mkdir(projectDir, { recursive: true });

    // Session A's file, written (and thus mtime-stamped) BEFORE session B's.
    const fileA = join(projectDir, "session-aaaa.jsonl");
    await writeFile(fileA, '{"session":"a"}\n', "utf8");
    await new Promise((r) => setTimeout(r, 5));
    const fileB = join(projectDir, "session-bbbb.jsonl");
    await writeFile(fileB, '{"session":"b"}\n', "utf8");

    const roots: LocateTranscriptRoots = { claudeHome };
    // Session A's own captured id must resolve to file A, even though
    // file B is strictly newer — proving this is NOT a newest-mtime pick.
    expect(locateTranscript(harness("claude-code", "session-aaaa"), cwd, undefined, roots)).toBe(
      fileA,
    );
    expect(locateTranscript(harness("claude-code", "session-bbbb"), cwd, undefined, roots)).toBe(
      fileB,
    );
  });

  it("defensively globs every project dir by session id when the exact encoded-cwd path misses (cwd-encoding edge case)", async () => {
    const claudeHome = await fakeClaudeHome();
    // The transcript lives under some OTHER project dir than what this
    // cwd would encode to — simulating an encoding-rule miss.
    const otherProjectDir = join(claudeHome, "projects", "-some-other-encoded-cwd");
    await mkdir(otherProjectDir, { recursive: true });
    const target = join(otherProjectDir, "orphan-session-id.jsonl");
    await writeFile(target, "{}\n", "utf8");

    const roots: LocateTranscriptRoots = { claudeHome };
    const found = locateTranscript(
      harness("claude-code", "orphan-session-id"),
      "/this/cwd/does/not/match/the/dir/above",
      undefined,
      roots,
    );
    expect(found).toBe(target);
  });

  it("falls back to newest-mtime-in-cwd's-own-dir when no session id is available at all", async () => {
    const claudeHome = await fakeClaudeHome();
    const cwd = "/no/session/id/cwd";
    const projectDir = join(claudeHome, "projects", "-no-session-id-cwd");
    await mkdir(projectDir, { recursive: true });
    const older = join(projectDir, "older.jsonl");
    await writeFile(older, "{}\n", "utf8");
    await new Promise((r) => setTimeout(r, 5));
    const newer = join(projectDir, "newer.jsonl");
    await writeFile(newer, "{}\n", "utf8");

    const roots: LocateTranscriptRoots = { claudeHome };
    expect(locateTranscript(harness("claude-code", null), cwd, undefined, roots)).toBe(newer);
  });

  it("returns null (never throws) when the project directory exists but has zero .jsonl files (confirmed real failure mode, findings.md §3.1)", async () => {
    const claudeHome = await fakeClaudeHome();
    const cwd = "/empty/project/cwd";
    const projectDir = join(claudeHome, "projects", "-empty-project-cwd");
    await mkdir(join(projectDir, "memory"), { recursive: true }); // unrelated subdir, no .jsonl

    const roots: LocateTranscriptRoots = { claudeHome };
    expect(() =>
      locateTranscript(harness("claude-code", null), cwd, undefined, roots),
    ).not.toThrow();
    expect(locateTranscript(harness("claude-code", null), cwd, undefined, roots)).toBeNull();
  });

  it("returns null (never throws) when the project directory doesn't exist at all", () => {
    const roots: LocateTranscriptRoots = { claudeHome: join(scratch, "nonexistent-claude-home") };
    expect(() =>
      locateTranscript(harness("claude-code", "whatever"), "/some/cwd", undefined, roots),
    ).not.toThrow();
    expect(
      locateTranscript(harness("claude-code", "whatever"), "/some/cwd", undefined, roots),
    ).toBeNull();
  });

  it("ignores the <session-uuid>/ auxiliary subdirectory next to the real transcript (subagents/tool-results, not the transcript itself)", async () => {
    const claudeHome = await fakeClaudeHome();
    const cwd = "/aux/dir/cwd";
    const projectDir = join(claudeHome, "projects", "-aux-dir-cwd");
    const sessionId = "abc-123";
    await mkdir(join(projectDir, sessionId, "subagents"), { recursive: true });
    const target = join(projectDir, `${sessionId}.jsonl`);
    await writeFile(target, "{}\n", "utf8");

    const roots: LocateTranscriptRoots = { claudeHome };
    expect(locateTranscript(harness("claude-code", sessionId), cwd, undefined, roots)).toBe(target);
  });
});

// ---------------------------------------------------------------------------
// locateTranscript — claude-code cwd encoding on win32 (Windows portability,
// best-effort/unverified — see encodeClaudeCwd's own doc in transcript.ts).
// `encodeClaudeCwd` isn't exported (same as every other internal helper in
// this module); this exercises it the same indirect way the POSIX encoding
// tests above already do, through `locateTranscript`'s public surface, with
// `process.platform` mocked since this suite runs on a Linux host.
// ---------------------------------------------------------------------------

describe("locateTranscript — claude-code cwd encoding on win32", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("also folds \\ and : to - (in addition to / and .), producing a stable encoding for a Windows-shaped cwd", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const claudeHome = join(scratch, "fake-claude-home-win32");
    await mkdir(claudeHome, { recursive: true });
    const cwd = "C:\\Users\\x\\proj";
    const encoded = "C--Users-x-proj";
    const projectDir = join(claudeHome, "projects", encoded);
    await mkdir(projectDir, { recursive: true });
    const target = join(projectDir, "win-session.jsonl");
    await writeFile(target, "{}\n", "utf8");

    // No session id: this deliberately skips locateClaudeCode's step-1
    // exact-match AND step-2 defensive cross-project-dir glob fallback
    // (both gated on `sessionId !== null`), which would otherwise find the
    // file by scanning every project dir regardless of how the cwd was
    // encoded and mask a broken encoding — leaving ONLY step 3
    // (newest-mtime inside the win32-encoded `projectDir`) as the path
    // that can locate it, so this genuinely exercises `encodeClaudeCwd`'s
    // win32 branch, not the glob safety net.
    const roots: LocateTranscriptRoots = { claudeHome };
    const found = locateTranscript(harness("claude-code", null), cwd, undefined, roots);
    expect(found).toBe(target);
  });

  it("the win32 encoding is stable/deterministic across repeated calls for the same cwd", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const cwd = "C:\\Users\\x\\proj";
    const roots: LocateTranscriptRoots = { claudeHome: join(scratch, "unused") };
    // Two calls with no matching transcript both return null via the exact
    // same code path either way — this only proves no throw/crash and no
    // nondeterminism (e.g. from a Map/Set iteration order) creeps in.
    expect(locateTranscript(harness("claude-code", null), cwd, undefined, roots)).toBeNull();
    expect(locateTranscript(harness("claude-code", null), cwd, undefined, roots)).toBeNull();
  });

  it("does NOT affect the POSIX encoding when explicitly on linux (unchanged)", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const claudeHome = join(scratch, "fake-claude-home-posix-explicit");
    await mkdir(claudeHome, { recursive: true });
    const cwd = "/home/ryan/proj";
    const encoded = "-home-ryan-proj";
    const projectDir = join(claudeHome, "projects", encoded);
    await mkdir(projectDir, { recursive: true });
    const target = join(projectDir, "posix-session-id.jsonl");
    await writeFile(target, "{}\n", "utf8");

    const roots: LocateTranscriptRoots = { claudeHome };
    const found = locateTranscript(
      harness("claude-code", "posix-session-id"),
      cwd,
      undefined,
      roots,
    );
    expect(found).toBe(target);
  });
});

// ---------------------------------------------------------------------------
// locateTranscript — codex
// ---------------------------------------------------------------------------

describe("locateTranscript — codex", () => {
  async function fakeCodexHome(): Promise<string> {
    const codexHome = join(scratch, "fake-codex-home");
    await mkdir(codexHome, { recursive: true });
    return codexHome;
  }

  function sessionMetaLine(cwd: string, id: string): string {
    return `${JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id, cwd } })}\n`;
  }

  it("finds the newest rollout whose first-line payload.cwd matches, among several date-partitioned candidates with different cwds", async () => {
    const codexHome = await fakeCodexHome();
    const cwd = "/my/codex/project";

    // mtime ordering is forced deterministically via `utimes` (same
    // pattern as tests/acceptance/A3.test.ts's mtime-fingerprint tests)
    // rather than relying on real wall-clock gaps between writes, which
    // was flaky on filesystems/CI runners with coarse or contended mtime
    // resolution — the timestamps below, not write order, drive the
    // assertion.
    const baseTime = new Date("2026-05-26T01:00:00.000Z");

    const dayDirA = join(codexHome, "sessions", "2026", "05", "26");
    await mkdir(dayDirA, { recursive: true });
    const wrongCwd = join(dayDirA, "rollout-2026-05-26T01-00-00-aaa.jsonl");
    await writeFile(wrongCwd, sessionMetaLine("/some/other/project", "aaa"), "utf8");
    await utimes(wrongCwd, baseTime, baseTime);

    const dayDirB = join(codexHome, "sessions", "2026", "05", "27");
    await mkdir(dayDirB, { recursive: true });
    const rightCwdOld = join(dayDirB, "rollout-2026-05-27T01-00-00-bbb.jsonl");
    await writeFile(rightCwdOld, sessionMetaLine(cwd, "bbb"), "utf8");
    const rightCwdOldTime = new Date(baseTime.getTime() + 60_000);
    await utimes(rightCwdOld, rightCwdOldTime, rightCwdOldTime);

    const dayDirC = join(codexHome, "sessions", "2026", "05", "28");
    await mkdir(dayDirC, { recursive: true });
    const rightCwdNew = join(dayDirC, "rollout-2026-05-28T01-00-00-ccc.jsonl");
    await writeFile(rightCwdNew, sessionMetaLine(cwd, "ccc"), "utf8");
    const rightCwdNewTime = new Date(baseTime.getTime() + 120_000);
    await utimes(rightCwdNew, rightCwdNewTime, rightCwdNewTime);

    const roots: LocateTranscriptRoots = { codexHome };
    expect(locateTranscript(harness("codex", null), cwd, undefined, roots)).toBe(rightCwdNew);
  });

  it("returns null when nothing matches the cwd, or $CODEX_HOME/sessions doesn't exist — never throws", () => {
    const roots: LocateTranscriptRoots = { codexHome: join(scratch, "nonexistent-codex-home") };
    expect(() => locateTranscript(harness("codex", null), "/x", undefined, roots)).not.toThrow();
    expect(locateTranscript(harness("codex", null), "/x", undefined, roots)).toBeNull();
  });

  it("never throws on a rollout file with garbage/non-JSON first-line content", async () => {
    const codexHome = await fakeCodexHome();
    const dayDir = join(codexHome, "sessions", "2026", "01", "01");
    await mkdir(dayDir, { recursive: true });
    await writeFile(join(dayDir, "rollout-garbage.jsonl"), "not json at all\nmore\n", "utf8");

    const roots: LocateTranscriptRoots = { codexHome };
    expect(() =>
      locateTranscript(harness("codex", null), "/whatever", undefined, roots),
    ).not.toThrow();
    expect(locateTranscript(harness("codex", null), "/whatever", undefined, roots)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// locateTranscript — codex Fix 3 (ticket_01KY93E3WYD13E71QM7GHWG1DE):
// refuses to guess under genuine cwd-matching-rollout ambiguity
// ---------------------------------------------------------------------------

describe("locateTranscript — codex Fix 3: ambiguity refusal", () => {
  async function fakeCodexHome(): Promise<string> {
    const codexHome = join(scratch, "fake-codex-home-fix3");
    await mkdir(codexHome, { recursive: true });
    return codexHome;
  }

  function sessionMetaLine(cwd: string, id: string): string {
    return `${JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id, cwd } })}\n`;
  }

  it("returns null (refuses to guess) when TWO cwd-matching rollouts are both newer than the session's started_at, instead of silently picking the newest one", async () => {
    const codexHome = await fakeCodexHome();
    const cwd = "/concurrent/codex/project";
    // Both rollouts below are given mtimes well after this — the exact
    // shape of two genuinely concurrent Codex sessions racing in the same
    // cwd.
    const sessionStartedAt = "2020-01-01T00:00:00.000Z";

    const dayDir = join(codexHome, "sessions", "2026", "06", "01");
    await mkdir(dayDir, { recursive: true });
    const rolloutA = join(dayDir, "rollout-2026-06-01T01-00-00-aaa.jsonl");
    await writeFile(rolloutA, sessionMetaLine(cwd, "aaa"), "utf8");
    // mtimes are forced deterministically via `utimes` rather than a real
    // wall-clock gap between writes (same reasoning as the "finds the
    // newest rollout ..." test above) so ordering can't flake on
    // filesystems/CI runners with coarse or contended mtime resolution.
    const rolloutATime = new Date("2026-06-01T01:00:00.000Z");
    await utimes(rolloutA, rolloutATime, rolloutATime);
    const rolloutB = join(dayDir, "rollout-2026-06-01T02-00-00-bbb.jsonl");
    await writeFile(rolloutB, sessionMetaLine(cwd, "bbb"), "utf8");
    const rolloutBTime = new Date(rolloutATime.getTime() + 60_000);
    await utimes(rolloutB, rolloutBTime, rolloutBTime);

    const roots: LocateTranscriptRoots = { codexHome };
    // Sanity check first: without the ambiguity check (no started_at
    // passed), this exact fixture WOULD resolve to rolloutB (newest) —
    // proving the null below comes from the new refusal, not from the
    // fixture failing to match at all.
    expect(locateTranscript(harness("codex", null), cwd, undefined, roots)).toBe(rolloutB);
    expect(
      locateTranscript(harness("codex", null), cwd, undefined, roots, sessionStartedAt),
    ).toBeNull();
  });

  it("a SINGLE cwd-matching rollout newer than started_at still attaches (unambiguous), even alongside older cwd-matching rollouts", async () => {
    const codexHome = await fakeCodexHome();
    const cwd = "/single-match/codex/project";

    // Real mtimes (not the date-partitioned directory names, which are
    // just a path convention) drive the ambiguity check. Every timestamp
    // below is forced via `utimes` against a fixed base time rather than
    // real wall-clock gaps between writes, so ordering relative to
    // `started_at` can't flake on filesystems/CI runners with coarse or
    // contended mtime resolution (same reasoning as every other
    // mtime-ordering test in this file, e.g. the "finds the newest
    // rollout ..." test above).
    const baseTime = new Date("2026-05-01T00:00:00.000Z");

    const oldDayDir = join(codexHome, "sessions", "2026", "05", "01");
    await mkdir(oldDayDir, { recursive: true });
    const oldRollout = join(oldDayDir, "rollout-2026-05-01T00-00-00-old.jsonl");
    await writeFile(oldRollout, sessionMetaLine(cwd, "old"), "utf8");
    await utimes(oldRollout, baseTime, baseTime);

    // started_at sits strictly between the old rollout above and the new
    // one below, so exactly ONE cwd-matching candidate ends up newer.
    const sessionStartedAt = new Date(baseTime.getTime() + 60_000).toISOString();

    const newDayDir = join(codexHome, "sessions", "2026", "07", "23");
    await mkdir(newDayDir, { recursive: true });
    const newRollout = join(newDayDir, "rollout-2026-07-23T00-00-00-new.jsonl");
    await writeFile(newRollout, sessionMetaLine(cwd, "new"), "utf8");
    const newRolloutTime = new Date(baseTime.getTime() + 120_000);
    await utimes(newRollout, newRolloutTime, newRolloutTime);

    const roots: LocateTranscriptRoots = { codexHome };
    expect(locateTranscript(harness("codex", null), cwd, undefined, roots, sessionStartedAt)).toBe(
      newRollout,
    );
  });

  it("omitting sessionStartedAt entirely preserves the pre-Fix-3 newest-mtime-overall behaviour — no ambiguity check performed", async () => {
    const codexHome = await fakeCodexHome();
    const cwd = "/no-started-at/codex/project";

    const dayDir = join(codexHome, "sessions", "2026", "06", "01");
    await mkdir(dayDir, { recursive: true });
    const rolloutA = join(dayDir, "rollout-2026-06-01T01-00-00-aaa.jsonl");
    await writeFile(rolloutA, sessionMetaLine(cwd, "aaa"), "utf8");
    // mtimes forced deterministically via `utimes` — see the "finds the
    // newest rollout ..." test above for why.
    const rolloutATime = new Date("2026-06-01T01:00:00.000Z");
    await utimes(rolloutA, rolloutATime, rolloutATime);
    const rolloutB = join(dayDir, "rollout-2026-06-01T02-00-00-bbb.jsonl");
    await writeFile(rolloutB, sessionMetaLine(cwd, "bbb"), "utf8");
    const rolloutBTime = new Date(rolloutATime.getTime() + 60_000);
    await utimes(rolloutB, rolloutBTime, rolloutBTime);

    const roots: LocateTranscriptRoots = { codexHome };
    expect(locateTranscript(harness("codex", null), cwd, undefined, roots)).toBe(rolloutB);
  });
});

// ---------------------------------------------------------------------------
// locateTranscript — opencode / other: no v0 auto-detection
// ---------------------------------------------------------------------------

describe("locateTranscript — opencode/other: no auto-detection in v0 (documented gap)", () => {
  it("opencode always returns null with no explicit path, regardless of session id", () => {
    expect(locateTranscript(harness("opencode", null), "/x")).toBeNull();
    expect(locateTranscript(harness("opencode", "ses_whatever"), "/x")).toBeNull();
  });

  it("other always returns null with no explicit path", () => {
    expect(locateTranscript(harness("other", null), "/x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// locateTranscript — never throws, general
// ---------------------------------------------------------------------------

describe("locateTranscript — never throws under weird input", () => {
  it("survives a symlink loop / broken symlink in a claude project dir without throwing", async () => {
    const claudeHome = join(scratch, "claude-home-symlink");
    const cwd = "/symlink/cwd";
    const projectDir = join(claudeHome, "projects", "-symlink-cwd");
    await mkdir(projectDir, { recursive: true });
    await symlink(join(projectDir, "nonexistent-target"), join(projectDir, "broken.jsonl"));

    const roots: LocateTranscriptRoots = { claudeHome };
    expect(() =>
      locateTranscript(harness("claude-code", null), cwd, undefined, roots),
    ).not.toThrow();
  });

  it("survives an empty cwd string and a cwd with no matching directory anywhere", () => {
    expect(() => locateTranscript(harness("claude-code", "x"), "")).not.toThrow();
    expect(locateTranscript(harness("claude-code", "x"), "")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// captureTranscript
// ---------------------------------------------------------------------------

describe("captureTranscript", () => {
  it("transcripts: off skips capture entirely — clean null, no warning, no file written", async () => {
    const paths = await ensureDbDirs(scratch);
    const session = makeSession();

    const result = await captureTranscript({
      session,
      paths,
      cwd: scratch,
      transcriptsMode: "off",
      explicitTranscriptPath: join(scratch, "some-transcript.jsonl"),
    });

    expect(result).toEqual({ transcriptRef: null, warning: null, sourcePath: null });
    await expect(
      readFile(join(paths.slopDir, "transcripts", `${session.id}.jsonl`)),
    ).rejects.toThrow();
  });

  it("transcripts: local copies the located file into .slop/transcripts/<session.id>.jsonl and returns a ref RELATIVE to the .slop root", async () => {
    const paths = repoPaths(scratch);
    const source = join(scratch, "source.jsonl");
    const content = '{"type":"user","message":{"role":"user","content":"hi"}}\n';
    await writeFile(source, content, "utf8");
    const session = makeSession();

    const result = await captureTranscript({
      session,
      paths,
      cwd: scratch,
      transcriptsMode: "local",
      explicitTranscriptPath: source,
    });

    expect(result.warning).toBeNull();
    expect(result.sourcePath).toBe(source);
    expect(result.transcriptRef).toBe(`transcripts/${session.id}.jsonl`);
    const written = await readFile(
      join(paths.slopDir, "transcripts", `${session.id}.jsonl`),
      "utf8",
    );
    expect(written).toBe(content);
  });

  it("transcripts: commit captures identically to local (the mode only affects gitignore, not capture)", async () => {
    const paths = repoPaths(scratch);
    const source = join(scratch, "source-commit.jsonl");
    await writeFile(source, "{}\n", "utf8");
    const session = makeSession();

    const result = await captureTranscript({
      session,
      paths,
      cwd: scratch,
      transcriptsMode: "commit",
      explicitTranscriptPath: source,
    });

    expect(result.transcriptRef).toBe(`transcripts/${session.id}.jsonl`);
    expect(result.warning).toBeNull();
  });

  it("not found: transcriptRef null, a non-null warning, still resolves cleanly (never throws/rejects) — the load-bearing never-block contract", async () => {
    const paths = repoPaths(scratch);
    const session = makeSession({ harness: harness("other") });

    const result = await captureTranscript({
      session,
      paths,
      cwd: scratch,
      transcriptsMode: "local",
      roots: { claudeHome: join(scratch, "nonexistent") },
    });

    expect(result.transcriptRef).toBeNull();
    expect(result.warning).not.toBeNull();
    expect(result.warning).toMatch(new RegExp(session.id));
  });

  it("Fix 3 (ticket_01KY93E3WYD13E71QM7GHWG1DE): codex ambiguity refusal — null transcriptRef with a warning explaining WHY (not the generic 'could not locate' message), suggesting --transcript", async () => {
    const paths = repoPaths(scratch);
    const codexHome = join(scratch, "fake-codex-home-capture-fix3");
    const cwd = "/concurrent/codex/capture-project";
    const sessionStartedAt = "2020-01-01T00:00:00.000Z";
    const session = makeSession({ harness: harness("codex"), started_at: sessionStartedAt });

    const dayDir = join(codexHome, "sessions", "2026", "06", "01");
    await mkdir(dayDir, { recursive: true });
    const metaLine = (id: string) =>
      `${JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id, cwd } })}\n`;
    await writeFile(join(dayDir, "rollout-2026-06-01T01-00-00-aaa.jsonl"), metaLine("aaa"), "utf8");
    await new Promise((r) => setTimeout(r, 5));
    await writeFile(join(dayDir, "rollout-2026-06-01T02-00-00-bbb.jsonl"), metaLine("bbb"), "utf8");

    const result = await captureTranscript({
      session,
      paths,
      cwd,
      transcriptsMode: "local",
      roots: { codexHome },
    });

    expect(result.transcriptRef).toBeNull();
    expect(result.sourcePath).toBeNull();
    expect(result.warning).not.toBeNull();
    // Distinguishes the ambiguity refusal from the generic "could not
    // locate" wording exercised by the test above.
    expect(result.warning).toMatch(/ambiguous|refus/i);
    expect(result.warning).toContain("--transcript");
  });

  it("mentions the given --transcript path explicitly in the warning when it was provided but didn't exist", async () => {
    const paths = repoPaths(scratch);
    const session = makeSession();
    const badPath = join(scratch, "i-do-not-exist.jsonl");

    const result = await captureTranscript({
      session,
      paths,
      cwd: scratch,
      transcriptsMode: "local",
      explicitTranscriptPath: badPath,
    });

    expect(result.transcriptRef).toBeNull();
    expect(result.warning).toContain(badPath);
  });

  it("creates .slop/transcripts/ on demand if it doesn't already exist (doesn't depend on `slop init` having run)", async () => {
    const paths = repoPaths(scratch);
    // Deliberately do NOT call ensureDbDirs or create .slop/transcripts —
    // capture must be self-sufficient.
    const source = join(scratch, "source2.jsonl");
    await writeFile(source, "{}\n", "utf8");
    const session = makeSession();

    const result = await captureTranscript({
      session,
      paths,
      cwd: scratch,
      transcriptsMode: "local",
      explicitTranscriptPath: source,
    });

    expect(result.transcriptRef).not.toBeNull();
  });

  it("a directory given as --transcript is treated as 'not found', not a crash", async () => {
    const paths = repoPaths(scratch);
    const dirAsSource = join(scratch, "a-directory-not-a-file");
    await mkdir(dirAsSource);
    const session = makeSession();

    await expect(
      captureTranscript({
        session,
        paths,
        cwd: scratch,
        transcriptsMode: "local",
        explicitTranscriptPath: dirAsSource,
      }),
    ).resolves.toMatchObject({ transcriptRef: null });
  });

  it("never throws (resolves with a warning) when the located source exists but genuinely can't be read (permission denied)", async () => {
    const paths = repoPaths(scratch);
    const unreadable = join(scratch, "unreadable.jsonl");
    await writeFile(unreadable, "{}\n", "utf8");
    await chmod(unreadable, 0o000);
    const session = makeSession();

    try {
      const result = await captureTranscript({
        session,
        paths,
        cwd: scratch,
        transcriptsMode: "local",
        explicitTranscriptPath: unreadable,
      });
      expect(result.transcriptRef).toBeNull();
      expect(result.warning).not.toBeNull();
      expect(result.warning).toContain("transcript capture failed");
    } finally {
      // Restore permissions so the scratch dir can be cleaned up in afterEach.
      await chmod(unreadable, 0o644);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 1 (ticket_01KY93E2ZK6Z3TFEBP86ATMW37) — streams the copy instead of
// buffering, and the outside-the-lock speculative/reconcile seam.
// ---------------------------------------------------------------------------

describe("captureTranscript — Fix 1: streams the copy (tmp+rename), no full-file buffering", () => {
  it("copies a multi-MB transcript byte-for-byte via the streamed tmp+rename path", async () => {
    const paths = repoPaths(scratch);
    const source = join(scratch, "large-source.jsonl");
    const line = `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "x".repeat(200) },
    })}\n`;
    // ~4.5MB — small enough to keep the test fast, large enough that a
    // naive buffered readFile+atomicWriteFile would still "work" here too
    // (this asserts correctness of the NEW streamed path, not a size
    // ceiling — see stop.test.ts for the outside-the-lock timing proof).
    const content = line.repeat(20_000);
    await writeFile(source, content, "utf8");
    const session = makeSession();

    const result = await captureTranscript({
      session,
      paths,
      cwd: scratch,
      transcriptsMode: "local",
      explicitTranscriptPath: source,
    });

    expect(result.warning).toBeNull();
    const target = join(paths.slopDir, "transcripts", `${session.id}.jsonl`);
    const written = await readFile(target, "utf8");
    expect(written.length).toBe(content.length);
    expect(written).toBe(content);
  });

  it("leaves no leftover .tmp- file behind in the transcripts dir after a successful capture", async () => {
    const paths = repoPaths(scratch);
    const source = join(scratch, "src-for-tmp-check.jsonl");
    await writeFile(source, "{}\n", "utf8");
    const session = makeSession();

    await captureTranscript({
      session,
      paths,
      cwd: scratch,
      transcriptsMode: "local",
      explicitTranscriptPath: source,
    });

    const entries = await readdir(join(paths.slopDir, "transcripts"));
    expect(entries).toEqual([`${session.id}.jsonl`]);
    expect(entries.some((name) => name.startsWith(".tmp-"))).toBe(false);
  });
});

describe("speculativeTranscriptCapture / resolveTranscriptCapture — the outside-the-lock seam", () => {
  const actor = { name: "ryan", kind: "human" } as const;
  const ctx: EventContext = { actor, session: null };
  const startedEvent: MutationEventSpec = { verb: "session.started" };

  function realSession(overrides: Partial<Session> = {}): Session {
    return sessionSchema.parse({
      id: newSessionId(),
      ticket: newTicketId(),
      actor,
      harness: harness("other"),
      git: { branch: null, commit_at_start: null },
      started_at: "2026-07-23T10:00:00.000Z",
      ...overrides,
    });
  }

  it("returns null (nothing to do speculatively) when there is no active session", async () => {
    const paths = await ensureDbDirs(scratch);
    const result = await speculativeTranscriptCapture(paths, null, {
      paths,
      cwd: scratch,
      transcriptsMode: "local",
    });
    expect(result).toBeNull();
  });

  it("returns null — never throws — when the given session id doesn't resolve to a real on-disk session", async () => {
    const paths = await ensureDbDirs(scratch);
    const result = await speculativeTranscriptCapture(
      paths,
      "session_01ARZ3NDEKTSV4RRFFQ69G5FAV" as SessionId,
      { paths, cwd: scratch, transcriptsMode: "local" },
    );
    expect(result).toBeNull();
  });

  it("captures against the real on-disk session and reports the exact session id it captured against", async () => {
    const paths = await ensureDbDirs(scratch);
    const source = join(scratch, "spec-source.jsonl");
    await writeFile(source, "{}\n", "utf8");
    const session = realSession();
    await createSession(paths, session, ctx, startedEvent);

    const speculative = await speculativeTranscriptCapture(paths, session.id, {
      paths,
      cwd: scratch,
      transcriptsMode: "local",
      explicitTranscriptPath: source,
    });

    expect(speculative).not.toBeNull();
    expect(speculative?.sessionId).toBe(session.id);
    expect(speculative?.result.transcriptRef).toBe(`transcripts/${session.id}.jsonl`);
  });

  it("resolveTranscriptCapture reuses the speculative result outright when it's keyed to the SAME session id as the authoritative session", async () => {
    const paths = repoPaths(scratch);
    const session = makeSession();
    const speculative = {
      sessionId: session.id,
      result: {
        transcriptRef: `transcripts/${session.id}.jsonl`,
        warning: null,
        sourcePath: "/speculative/source/never/actually/read/again.jsonl",
      },
    };

    // Deliberately no explicitTranscriptPath and harness "other" — if this
    // were actually RE-run against `options` alone it would find nothing.
    // Getting the speculative transcriptRef back proves reuse, not a
    // fresh in-lock capture.
    const resolved = await resolveTranscriptCapture(speculative, {
      session,
      paths,
      cwd: scratch,
      transcriptsMode: "local",
    });

    expect(resolved).toEqual(speculative.result);
    await expect(
      readFile(join(paths.slopDir, "transcripts", `${session.id}.jsonl`)),
    ).rejects.toThrow();
  });

  it("resolveTranscriptCapture falls back to an in-lock capture when the speculative result is keyed to a DIFFERENT session id (stale/racy speculative read)", async () => {
    const paths = repoPaths(scratch);
    const authoritativeSource = join(scratch, "authoritative-source.jsonl");
    await writeFile(authoritativeSource, '{"authoritative":true}\n', "utf8");
    const session = makeSession();

    const staleSpeculative = {
      sessionId: "session_01BADBADBADBADBADBADBADBAD" as SessionId,
      result: {
        transcriptRef: "transcripts/wrong-session.jsonl",
        warning: null,
        sourcePath: "/wrong",
      },
    };

    const resolved = await resolveTranscriptCapture(staleSpeculative, {
      session,
      paths,
      cwd: scratch,
      transcriptsMode: "local",
      explicitTranscriptPath: authoritativeSource,
    });

    expect(resolved.transcriptRef).toBe(`transcripts/${session.id}.jsonl`);
    const written = await readFile(
      join(paths.slopDir, "transcripts", `${session.id}.jsonl`),
      "utf8",
    );
    expect(written).toBe('{"authoritative":true}\n');
  });

  it("resolveTranscriptCapture falls back to an in-lock capture when there was no speculative result at all", async () => {
    const paths = repoPaths(scratch);
    const source = join(scratch, "null-speculative-source.jsonl");
    await writeFile(source, "{}\n", "utf8");
    const session = makeSession();

    const resolved = await resolveTranscriptCapture(null, {
      session,
      paths,
      cwd: scratch,
      transcriptsMode: "local",
      explicitTranscriptPath: source,
    });

    expect(resolved.transcriptRef).toBe(`transcripts/${session.id}.jsonl`);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 (ticket_01KY9NVM1YRM1F7NX1QS5JJAW1) — a recapture that finds
// nothing preserves an existing transcript_ref rather than clearing it.
// ---------------------------------------------------------------------------

describe("captureTranscript — Fix 2: a recapture that locates nothing preserves an existing transcript_ref", () => {
  it("keeps session.transcript_ref, with a 'kept the previously-captured transcript' warning, when nothing new is located", async () => {
    const paths = repoPaths(scratch);
    const session = makeSession({
      harness: harness("other"),
      transcript_ref: "transcripts/some-earlier-capture.jsonl",
    });

    // harness "other" + no --transcript => locateTranscript always
    // returns null (no auto-detection in v0).
    const result = await captureTranscript({
      session,
      paths,
      cwd: scratch,
      transcriptsMode: "local",
    });

    expect(result.transcriptRef).toBe("transcripts/some-earlier-capture.jsonl");
    expect(result.warning).not.toBeNull();
    expect(result.warning).toMatch(/kept the previously-captured transcript/i);
    expect(result.warning).not.toMatch(/could not locate/i);
  });

  it("still returns null with the original 'could not locate' warning when the session never had a transcript_ref to begin with (unchanged regression guard)", async () => {
    const paths = repoPaths(scratch);
    const session = makeSession({ harness: harness("other"), transcript_ref: null });

    const result = await captureTranscript({
      session,
      paths,
      cwd: scratch,
      transcriptsMode: "local",
    });

    expect(result.transcriptRef).toBeNull();
    expect(result.warning).toMatch(/could not locate a transcript/i);
  });

  it("does NOT mask a genuinely NEW transcript: a located file overrides the previously-captured ref rather than keeping the stale one", async () => {
    const paths = repoPaths(scratch);
    const newSource = join(scratch, "genuinely-new.jsonl");
    await writeFile(newSource, '{"new":"content"}\n', "utf8");
    const session = makeSession({
      harness: harness("other"),
      transcript_ref: "transcripts/stale-old-ref.jsonl",
    });

    const result = await captureTranscript({
      session,
      paths,
      cwd: scratch,
      transcriptsMode: "local",
      explicitTranscriptPath: newSource,
    });

    expect(result.transcriptRef).toBe(`transcripts/${session.id}.jsonl`);
    expect(result.transcriptRef).not.toBe("transcripts/stale-old-ref.jsonl");
    expect(result.warning).toBeNull();
    const written = await readFile(
      join(paths.slopDir, "transcripts", `${session.id}.jsonl`),
      "utf8",
    );
    expect(written).toBe('{"new":"content"}\n');
  });
});
