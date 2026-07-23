/**
 * Transcript capture (D16, design.md §4.3, §3; work item C4) — flagged in
 * v0-implementation-plan.md §6 risk 2 as "the least specifiable item":
 * harness internals are undocumented and shift, so the manual
 * `--transcript` fallback and the never-block guarantee below are
 * first-class requirements, not edge cases.
 *
 * Two halves:
 *
 *   - {@link locateTranscript} — spikes/findings.md §5's locator function
 *     spec, implemented close to verbatim: given a harness + cwd (+ an
 *     optional explicit `--transcript` path), returns an absolute path to
 *     a transcript file readable right now, or `null`. Synchronous,
 *     matching the spec's own signature, and MUST NOT throw under any
 *     condition — every internal step is defensive (missing dirs, empty
 *     globs, garbage file content all degrade to `null`/`false`, never an
 *     exception).
 *
 *   - {@link captureTranscript} — the session-end orchestration `stop`
 *     (this item) and `review`/`done`/`drop` (C3, not yet built — see
 *     "How C3 must call this" below) all need: locates, copies into
 *     `.slop/transcripts/<session.id>.jsonl`, and returns a result the
 *     caller folds into the `Session` it's about to write. Never throws —
 *     the entire body is one try/catch that turns any failure (locate,
 *     mkdir, read, atomic write) into `{transcriptRef: null, warning}`,
 *     so the never-block guarantee is structural: nothing upstream of a
 *     `captureTranscript` call can be broken by adding one.
 *
 * ---------------------------------------------------------------------
 * Per-harness capture status (v0 honest accounting — findings.md §7)
 * ---------------------------------------------------------------------
 *
 * claude-code — WORKS end-to-end, no manual flag needed in the common
 *   case. The session id was captured ONCE at `start` time onto the
 *   session entity (see harness.ts's module doc) and is read back from
 *   there — never re-derived here by mtime, which findings.md §5 calls
 *   out as concurrency-unsound (two concurrent sessions in the same cwd
 *   would otherwise silently resolve to whichever transcript was touched
 *   most recently, not "mine"). Falls back to a bounded glob-by-session-id
 *   search across every project dir (covers the cwd-encoding rule's
 *   untested-character-set gap, findings.md §3.1/§7 risk 4), then to a
 *   newest-mtime scan of the cwd's own project dir as a last resort.
 *
 * codex — best-effort auto-detection only: no session id is ever exposed
 *   to the environment (findings.md §1.3/§3.3), so this always falls
 *   straight to a newest-mtime-among-cwd-matching-rollouts scan under
 *   `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (each candidate's
 *   first line is parsed to check `payload.cwd === cwd`, since Codex's
 *   on-disk layout is date-partitioned, not project-partitioned). Works
 *   when Codex was run in this exact cwd and nothing else touched that
 *   cwd more recently; `--transcript <path>` is the reliable path for
 *   anything else — findings.md §7 risk 3 frames `--harness codex`
 *   resolving to a `--transcript`-only flow as a first-class, expected
 *   v0 outcome, not a gap to paper over.
 *
 * opencode — NO auto-detection in v0. opencode exposes no session id to
 *   the environment at all and stores sessions in a SQLite db, not flat
 *   files (findings.md §3.2) — reading that db and shelling out to
 *   `opencode export <id> --sanitize` is real, separate implementation
 *   work this item deliberately does not take on, especially since
 *   `opencode export`'s output is a single pretty-printed JSON object
 *   (`{info, messages}`), NOT JSONL (findings.md §7 risk 1) — copying it
 *   straight to `session_<ulid>.jsonl` would produce a file shaped
 *   differently from every other harness's transcript, which needs its
 *   own resolved decision (normalize at capture time, or teach D5's
 *   viewer to sniff both shapes) that is out of scope here. `slop
 *   stop/review/done --transcript <path>` (run `opencode export
 *   <sessionID> --sanitize > file.json` yourself first, and expect D5 to
 *   render it oddly today) is the only supported path for opencode in
 *   v0. A documented gap, not a silent one.
 *
 * other — NO auto-detection (no known on-disk convention exists for an
 *   unrecognised harness). `--transcript <path>` only.
 *
 * In every case where nothing is found, capture degrades to
 * `transcript_ref: null` plus a warning — never a blocked state
 * transition (design.md §4.3 / findings.md §6, restated below).
 *
 * ---------------------------------------------------------------------
 * Exactly how C3 (`done`/`review`/`drop`) must call this
 * ---------------------------------------------------------------------
 *
 * `src/cli/commands/stop.ts` (this item) is the reference implementation
 * — C3 should follow the identical shape for each of `done`/`review`/
 * `drop`, inside the SAME `withLock` transaction each already uses to
 * finalize the session:
 *
 *   1. Register a `--transcript <path>` option on that command (same as
 *      `stop`'s), and read the active session the same way `stop` does.
 *   2. Call:
 *        const capture = await captureTranscript({
 *          session,                      // the session BEFORE this
 *                                         // command's own end-of-session
 *                                         // field changes — harness/id
 *                                         // never change, so this is
 *                                         // safe and matches `stop`.
 *          paths,
 *          cwd: root,
 *          transcriptsMode: config.transcripts,
 *          explicitTranscriptPath: opts.transcript,
 *        });
 *   3. Fold `capture.transcriptRef` into the SAME `Session` object the
 *      command was already about to build (end_summary/ended_at for
 *      `done`/`drop`; review doesn't end the session, see below) and
 *      write it in the SAME `updateSession` call — one write, one event —
 *      by passing `[...SESSION_END_FIELDS, "transcript_ref"]` (imported
 *      from `./patch.js`) as `diffSessionPatch`'s third argument, exactly
 *      as `stop.ts` does. Do not add a second `updateSession` call just
 *      for the transcript — there is no generic "session updated" event
 *      verb in `EVENT_VERBS` (`src/core/entities/event.ts`), and folding
 *      it into the existing end-of-session write keeps one session-end =
 *      one write = one event, same as `stop`.
 *   4. If `capture.warning !== null`, `printWarning(capture.warning)`
 *      (from `../../cli/commands/shared.js`) AFTER the transaction
 *      commits — never let it affect whether the transaction succeeds.
 *
 * `done` and `drop` end the session the same way `stop` does. `review`
 * (`in_progress` -> `review`, D15) does NOT end the session — the session
 * stays active across a review round-trip — but design.md §4.3 still
 * lists it as a capture point ("On stop/review/done ... copies it"): call
 * `captureTranscript` and fold `transcript_ref` into the session the same
 * way, just without setting `ended_at`/`end_summary`, and use whatever
 * verb `review --mr` already emits (`review.requested`) for the one
 * `updateSession` write instead of inventing a new one.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Harness, Session, TranscriptsMode } from "../core/index.js";
import { atomicWriteFile } from "../repo/atomic-write.js";
import type { RepoPaths } from "../repo/paths.js";

/** The `<root>/.slop/transcripts/` subdirectory name (design.md §3). */
export const TRANSCRIPTS_SUBDIR = "transcripts";

/**
 * Test-only override for Claude Code's project-transcript root, normally
 * `~/.claude` — there is no officially documented env var for this (unlike
 * Codex's real `$CODEX_HOME`, which {@link locateTranscript} already
 * honours directly). Read only by {@link captureTranscript}, mirroring
 * `src/cli/commands/web.ts`'s `SLOP_WEB_FAKE_NOW` convention (DECISIONS.md
 * D5 entry): undocumented as a user-facing flag, exists purely so
 * `tests/acceptance/C4.test.ts` can point a REAL spawned `slop stop` at a
 * fake `~/.claude`-shaped tree without touching the actual one. Never set
 * on any real invocation.
 */
const CLAUDE_HOME_TEST_OVERRIDE_ENV = "SLOP_TEST_CLAUDE_HOME";

/**
 * Search roots {@link locateTranscript} looks under — injectable so unit
 * tests never depend on the real `~/.claude` or `$CODEX_HOME`. Both are
 * optional; omitted fields fall back to the real production defaults
 * (`~/.claude`, `$CODEX_HOME`/`~/.codex`).
 */
export interface LocateTranscriptRoots {
  claudeHome?: string;
  codexHome?: string;
}

// ---------------------------------------------------------------------------
// Small sync fs helpers — locateTranscript's own contract (findings.md §5)
// is synchronous, and every one of these MUST degrade to a safe default
// rather than throw: a missing directory, a dangling symlink, a directory
// where a file was expected, and a truncated/garbage file are all
// ordinary, expected conditions here (findings.md §3.1's "directories can
// exist with zero transcripts" failure mode, confirmed live), not bugs.
// ---------------------------------------------------------------------------

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function listDirSync(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function listSubdirsSync(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function mtimeMsSync(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Newest `*.jsonl` directly inside `dir` by mtime, or `null` if `dir`
 * doesn't exist or contains none (findings.md §3.1's confirmed empty-dir
 * case) — never throws. */
function newestJsonlIn(dir: string): string | null {
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of listDirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    const mtimeMs = mtimeMsSync(path);
    if (mtimeMs === null) continue;
    if (best === null || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
  }
  return best?.path ?? null;
}

/** First line of `path`, bounded to `maxBytes` (a `session_meta`/
 * first-record line is always well within this) — `null` if the file
 * can't be opened/read, or if no newline was found within the bound (a
 * truncated read we can't safely treat as a complete line). Never
 * throws. */
function readFirstLineSync(path: string, maxBytes = 65_536): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const newlineIdx = text.indexOf("\n");
    if (newlineIdx !== -1) return text.slice(0, newlineIdx);
    return bytesRead < maxBytes ? text : null;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best-effort close only
    }
  }
}

// ---------------------------------------------------------------------------
// Claude Code (findings.md §3.1)
// ---------------------------------------------------------------------------

/** Encoding rule, as observed live (findings.md §3.1): every `/` and every
 * `.` in the cwd becomes `-`. A leading `/` becomes a leading `-`. */
function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

function locateClaudeCode(
  claudeHome: string,
  cwd: string,
  sessionId: string | null,
): string | null {
  const projectsRoot = join(claudeHome, "projects");
  const projectDir = join(projectsRoot, encodeClaudeCwd(cwd));

  if (sessionId !== null) {
    const exact = join(projectDir, `${sessionId}.jsonl`);
    if (isRegularFile(exact)) return exact;

    // Defensive glob-by-session-id fallback (findings.md §5 step 2 /
    // §3.1's untested-character-set caveat): bounded — an exact-filename
    // match against a known-unique UUID across each project dir, not an
    // open-ended scan.
    for (const name of listSubdirsSync(projectsRoot)) {
      const candidate = join(projectsRoot, name, `${sessionId}.jsonl`);
      if (isRegularFile(candidate)) return candidate;
    }
  }

  // Step 3, LAST RESORT ONLY (findings.md §5's "known-unsound case"):
  // never preferred over a captured session id — two concurrent sessions
  // in the same cwd would otherwise silently resolve to whichever
  // transcript was touched most recently, not "mine".
  return newestJsonlIn(projectDir);
}

// ---------------------------------------------------------------------------
// Codex (findings.md §3.3) — date-partitioned, not project-partitioned, so
// every candidate's own `payload.cwd` has to be checked, not just its path.
// ---------------------------------------------------------------------------

function rolloutMatchesCwd(path: string, cwd: string): boolean {
  const line = readFirstLineSync(path);
  if (line === null || line.trim().length === 0) return false;
  try {
    const parsed = JSON.parse(line) as { type?: unknown; payload?: { cwd?: unknown } };
    return parsed.type === "session_meta" && parsed.payload?.cwd === cwd;
  } catch {
    return false;
  }
}

function locateCodex(codexHome: string, cwd: string): string | null {
  const sessionsDir = join(codexHome, "sessions");
  let best: { path: string; mtimeMs: number } | null = null;

  for (const year of listSubdirsSync(sessionsDir)) {
    const yearDir = join(sessionsDir, year);
    for (const month of listSubdirsSync(yearDir)) {
      const monthDir = join(yearDir, month);
      for (const day of listSubdirsSync(monthDir)) {
        const dayDir = join(monthDir, day);
        for (const name of listDirSync(dayDir)) {
          if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
          const full = join(dayDir, name);
          if (!rolloutMatchesCwd(full, cwd)) continue;
          const mtimeMs = mtimeMsSync(full);
          if (mtimeMs === null) continue;
          if (best === null || mtimeMs > best.mtimeMs) best = { path: full, mtimeMs };
        }
      }
    }
  }
  return best?.path ?? null;
}

// ---------------------------------------------------------------------------
// The locator
// ---------------------------------------------------------------------------

/**
 * spikes/findings.md §5's locator, implemented. Returns an absolute path
 * to a transcript readable NOW, or `null` if nothing could be found.
 * MUST NOT throw under any condition — every branch below is backed by
 * the defensive helpers above.
 *
 * Ordered strategy (§5, applied uniformly per design.md §4.3):
 *   1. `explicitTranscriptPath` (`--transcript <path>`), if given and it
 *      names an existing regular file → returned verbatim, any harness
 *      kind including `"other"`. If given but it does NOT exist, this
 *      deliberately falls through to steps 2-3 rather than failing
 *      outright — consistent with "never block": a stale/typo'd
 *      `--transcript` value degrades to ordinary auto-detection instead
 *      of forcing a hard `null`. `captureTranscript`'s warning message
 *      calls this out explicitly when it happens, so it's never silent.
 *   2. Env-derived session id (claude-code only — opencode/codex never
 *      expose one, findings.md §1.2/§1.3, so this is an unconditional
 *      no-op for them).
 *   3. Newest-mtime heuristic, scoped per harness, LAST RESORT.
 *   4. Nothing found → `null`.
 */
export function locateTranscript(
  harness: Harness,
  cwd: string,
  explicitTranscriptPath?: string | null,
  roots: LocateTranscriptRoots = {},
): string | null {
  try {
    if (
      explicitTranscriptPath !== undefined &&
      explicitTranscriptPath !== null &&
      explicitTranscriptPath.trim().length > 0 &&
      isRegularFile(explicitTranscriptPath)
    ) {
      return explicitTranscriptPath;
    }

    const claudeHome = roots.claudeHome ?? join(homedir(), ".claude");
    // $CODEX_HOME is Codex's own documented config-root var (findings.md
    // §3.3) — honouring it directly here (rather than only via `roots`)
    // means locateTranscript does the right thing against a real Codex
    // install with a customised CODEX_HOME with zero extra wiring.
    const codexHome = roots.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");

    switch (harness.kind) {
      case "claude-code":
        return locateClaudeCode(claudeHome, cwd, harness.session_id);
      case "codex":
        return locateCodex(codexHome, cwd);
      case "opencode":
      case "other":
        // No auto-detection for either in v0 — see this module's doc.
        return null;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// captureTranscript — the session-end orchestration
// ---------------------------------------------------------------------------

export interface CaptureTranscriptOptions {
  /** The session being ended/reviewed — `harness` and `id` drive
   * everything here; pass the session as read from disk, unmodified. */
  session: Session;
  paths: RepoPaths;
  /** The repo root — what a `claude-code`/`codex` lookup matches against. */
  cwd: string;
  /** `.slop/config.yaml`'s `transcripts:` (D16) — `"off"` skips capture
   * entirely (still a clean, successful `{transcriptRef: null}`, not an
   * error). `"local"` and `"commit"` behave identically here; they only
   * differ in whether `.slop/transcripts/` ends up gitignored, which is
   * `slop init`'s concern (`src/cli/init/gitignore.ts`), not capture's. */
  transcriptsMode: TranscriptsMode;
  /** `--transcript <path>`, if the calling command registered and was
   * passed one. */
  explicitTranscriptPath?: string | null;
  /** Test-only root override, forwarded to {@link locateTranscript}. Real
   * callers should omit this — see {@link CLAUDE_HOME_TEST_OVERRIDE_ENV}
   * for how tests reach it through a real spawned process instead. */
  roots?: LocateTranscriptRoots;
}

export interface CaptureTranscriptResult {
  /** Value for `Session.transcript_ref` — a path relative to the `.slop`
   * root (e.g. `"transcripts/session_01ABC....jsonl"`, matching D5's
   * documented assumption, DECISIONS.md's D5 entry), or `null` if nothing
   * was captured. */
  transcriptRef: string | null;
  /**
   * Non-null iff there's something worth telling a human/agent about:
   * nothing found, an explicit `--transcript` path that didn't exist, or
   * a copy failure. The caller should `printWarning` this to stderr and
   * otherwise ignore it entirely — it is NEVER a reason to fail whatever
   * state transition is in progress (design.md §4.3 / findings.md §6).
   * `null` on a clean skip (`transcripts: off`) or a successful capture.
   */
  warning: string | null;
  /** The absolute source path that was copied, when capture succeeded.
   * Exposed for logging/tests only — callers persist `transcriptRef`, not
   * this. */
  sourcePath: string | null;
}

/**
 * Locate + copy the harness transcript for `options.session` into
 * `.slop/transcripts/<session.id>.jsonl`, for a `stop`/`review`/`done`/
 * `drop` call to fold into the `Session` write it's already making. See
 * this module's own top-of-file doc for the exact shape C3's
 * `done`/`review`/`drop` must use.
 *
 * NEVER throws: the entire body below is one try/catch, so any failure —
 * locate, `mkdir`, `readFile`, the atomic write itself — degrades to
 * `{transcriptRef: null, warning: "..."}` rather than propagating. This
 * is what makes the never-block guarantee structural rather than
 * "every caller remembered to wrap this in try/catch": a caller that
 * simply `await`s this function and writes whatever it returns can never
 * have its own state transition broken by a transcript problem.
 */
export async function captureTranscript(
  options: CaptureTranscriptOptions,
): Promise<CaptureTranscriptResult> {
  const { session, paths, cwd, transcriptsMode, explicitTranscriptPath, roots } = options;

  if (transcriptsMode === "off") {
    return { transcriptRef: null, warning: null, sourcePath: null };
  }

  try {
    const resolvedRoots: LocateTranscriptRoots = {
      claudeHome: roots?.claudeHome ?? process.env[CLAUDE_HOME_TEST_OVERRIDE_ENV] ?? undefined,
      codexHome: roots?.codexHome,
    };

    const sourcePath = locateTranscript(
      session.harness,
      cwd,
      explicitTranscriptPath,
      resolvedRoots,
    );

    if (sourcePath === null) {
      const hadExplicit =
        explicitTranscriptPath !== undefined &&
        explicitTranscriptPath !== null &&
        explicitTranscriptPath.trim().length > 0;
      const explicitNote = hadExplicit
        ? ` (the given --transcript path "${explicitTranscriptPath}" does not exist or is not a readable file)`
        : "";
      return {
        transcriptRef: null,
        sourcePath: null,
        warning:
          `could not locate a transcript for session ${session.id} (harness=${session.harness.kind})` +
          `${explicitNote} — recording transcript_ref: null, never blocking. Pass ` +
          "--transcript <path> next time to point at it directly.",
      };
    }

    const transcriptsDir = join(paths.slopDir, TRANSCRIPTS_SUBDIR);
    // Defensive: `slop init` already creates this directory (D1), but
    // capture must not depend on that having happened (a pre-D1-feature
    // repo, a hand-pruned directory, ...).
    await mkdir(transcriptsDir, { recursive: true });

    const fileName = `${session.id}.jsonl`;
    const contents = await readFile(sourcePath, "utf8");
    await atomicWriteFile(join(transcriptsDir, fileName), contents);

    return {
      transcriptRef: `${TRANSCRIPTS_SUBDIR}/${fileName}`,
      warning: null,
      sourcePath,
    };
  } catch (err) {
    return {
      transcriptRef: null,
      sourcePath: null,
      warning:
        `transcript capture failed for session ${session.id}: ` +
        `${err instanceof Error ? err.message : String(err)} — recording transcript_ref: null, ` +
        "never blocking.",
    };
  }
}
