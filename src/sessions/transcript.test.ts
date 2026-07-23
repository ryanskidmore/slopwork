import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness, Session } from "../core/index.js";
import { ensureDbDirs, repoPaths } from "../repo/index.js";
import { captureTranscript, type LocateTranscriptRoots, locateTranscript } from "./transcript.js";

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

    const dayDirA = join(codexHome, "sessions", "2026", "05", "26");
    await mkdir(dayDirA, { recursive: true });
    const wrongCwd = join(dayDirA, "rollout-2026-05-26T01-00-00-aaa.jsonl");
    await writeFile(wrongCwd, sessionMetaLine("/some/other/project", "aaa"), "utf8");

    await new Promise((r) => setTimeout(r, 5));
    const dayDirB = join(codexHome, "sessions", "2026", "05", "27");
    await mkdir(dayDirB, { recursive: true });
    const rightCwdOld = join(dayDirB, "rollout-2026-05-27T01-00-00-bbb.jsonl");
    await writeFile(rightCwdOld, sessionMetaLine(cwd, "bbb"), "utf8");

    await new Promise((r) => setTimeout(r, 5));
    const dayDirC = join(codexHome, "sessions", "2026", "05", "28");
    await mkdir(dayDirC, { recursive: true });
    const rightCwdNew = join(dayDirC, "rollout-2026-05-28T01-00-00-ccc.jsonl");
    await writeFile(rightCwdNew, sessionMetaLine(cwd, "ccc"), "utf8");

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
