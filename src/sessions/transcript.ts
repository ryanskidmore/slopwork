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
 *   v0 outcome, not a gap to paper over. Fix 3 (below) additionally
 *   refuses to guess at all — falls straight to `null` plus a warning,
 *   rather than silently attaching the WRONG session's transcript — when
 *   more than one cwd-matching rollout is newer than this session's own
 *   `started_at`, i.e. exactly the case where a second, concurrent Codex
 *   session in the same cwd could be the one actually holding the
 *   newest mtime. `--transcript <path>` is the only reliable path once
 *   that happens; there is no way to auto-disambiguate two truly
 *   concurrent same-cwd Codex sessions without a session id Codex simply
 *   does not expose.
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
 *
 * ---------------------------------------------------------------------
 * Fix 1 (ticket_01KY93E2ZK6Z3TFEBP86ATMW37) — capture runs OUTSIDE the db
 * lock, and streams instead of buffering
 * ---------------------------------------------------------------------
 *
 * Step 2 above used to run `captureTranscript` INSIDE `withLock`, before
 * any `lock.assertHeld()` — for a large (tens-to-hundreds-of-MB)
 * transcript this held the exclusive `.slop/db/.lock` long enough to
 * time out a DIFFERENT concurrent command (default 5s acquire timeout,
 * lock.ts) into a CONFLICT, and buffered the whole file as one in-memory
 * string (a silent size ceiling -> `transcript_ref: null`). Both are
 * fixed structurally, not per-caller:
 *
 *   - {@link captureTranscript}'s own copy now streams source -> temp
 *     file (same directory as the destination) -> `rename`, mirroring
 *     `atomic-write.ts`'s own tmp+rename discipline (see
 *     `streamCopyFileAtomic` below) instead of `readFile` + a buffered
 *     `atomicWriteFile` — no full-file string buffering, no size
 *     ceiling.
 *   - Every caller now performs the locate+copy TWICE in the general
 *     shape, but only ever actually pays for it once in the common
 *     case: a {@link speculativeTranscriptCapture} call BEFORE
 *     `withLock`, keyed to whatever session is active on the
 *     already-unlocked-read `initialTicket` (`resolveTicketRef`'s
 *     result, which every caller already reads before its `withLock`
 *     call) — this is where the slow, streamed I/O actually happens,
 *     entirely outside the lock. Once inside the lock, the caller reads
 *     the AUTHORITATIVE session as before and calls {@link
 *     resolveTranscriptCapture} to reconcile: same session id (the
 *     overwhelmingly common case — nothing else can retarget a
 *     specific ticket's active session without holding this same lock
 *     first) -> reuse the speculative result outright, zero extra I/O
 *     under the lock. Different id, or the speculative read failed
 *     outright (rare: a genuinely concurrent command on this SAME
 *     ticket) -> fall back to an in-lock `captureTranscript` call, same
 *     as before this fix, just no longer the common path.
 *
 * ---------------------------------------------------------------------
 * Fix 2 (ticket_01KY9NVM1YRM1F7NX1QS5JJAW1) — a recapture that finds
 * nothing preserves an existing `transcript_ref`
 * ---------------------------------------------------------------------
 *
 * `review` and `done` (and `stop`/`drop`, for a session already reviewed
 * then dropped) each independently call `captureTranscript` against the
 * same session over its lifetime. Previously, a recapture that located
 * NOTHING new (e.g. harness `other`, no `--transcript` re-passed at
 * `done` after `review` DID capture one) unconditionally wrote
 * `transcript_ref: null`, silently discarding the earlier capture and
 * losing the audit trail. `captureTranscript`'s own "nothing located"
 * branch now checks `session.transcript_ref` (the PRE-mutation value,
 * always what every caller passes in per step 2 above): non-null ->
 * return that existing ref unchanged, with a warning that says "kept
 * the previously-captured transcript", not "could not locate"; null (a
 * transcript was never captured for this session) -> the original
 * "could not locate" behaviour, unchanged. This lives entirely inside
 * `captureTranscript` itself, so all four callers get it for free and
 * cannot drift out of sync with each other.
 *
 * ---------------------------------------------------------------------
 * Fix 3 (ticket_01KY93E3WYD13E71QM7GHWG1DE) — codex's newest-mtime
 * heuristic refuses to guess under genuine ambiguity
 * ---------------------------------------------------------------------
 *
 * `locateCodex`'s newest-mtime-among-cwd-matching-rollouts scan
 * (implemented below) is exactly the "known-unsound case" findings.md §5
 * calls out for its own step 3: two CONCURRENT Codex sessions in the same
 * cwd both produce cwd-matching rollout files with very recent mtimes,
 * and "newest" only answers "which rollout was touched most recently in
 * this cwd," not "which one is THIS session's" — unlike claude-code,
 * Codex has no session id to prefer instead (§1.3/§3.3), so there was
 * previously no way to tell a correct pick from a lucky guess apart, and
 * a wrong guess is silently wrong audit data — worse than a clean `null`.
 *
 * `locateCodex` now also takes the session's own `started_at` and
 * refuses to pick anything — returns `path: null`, not a guess — when
 * MORE THAN ONE cwd-matching rollout is newer than `started_at`: that is
 * exactly the condition under which a second, concurrent Codex session in
 * this same cwd could be the one actually holding the newest mtime. Zero
 * or exactly one newer-than-`started_at` candidate is unambiguous (this
 * session hasn't raced with another one in this cwd) and still resolves
 * exactly as before — newest-mtime overall. `captureTranscript` folds an
 * ambiguous refusal into a specific "refusing to guess" warning (still
 * `transcript_ref: null`, never blocking — findings.md §6's guarantee is
 * unaffected either way) instead of the generic "could not locate" one,
 * by re-running the same cheap, bounded scan a second time purely to
 * build that message — see its own inline comment for why that is fine.
 * `--transcript <path>` remains the only reliable override once this
 * happens; there is no way to auto-disambiguate two truly concurrent
 * same-cwd Codex sessions without a session id Codex does not expose.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Harness, Session, SessionId, TranscriptsMode } from "../core/index.js";
import type { RepoPaths } from "../repo/paths.js";
import { readSession } from "../repo/sessions.js";

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
 * `.` in the cwd becomes `-`. A leading `/` becomes a leading `-`.
 *
 * The `win32` branch below is a BEST-EFFORT, UNVERIFIED guess, not an
 * observed rule like the POSIX one above — there is no Windows environment
 * available to check it against a real Claude Code install. A Windows cwd
 * (e.g. `C:\Users\x\proj`) has neither `/` nor `.` as its path separator,
 * so applying the POSIX regex as-is would leave `\` and `:` completely
 * unencoded, virtually guaranteeing a miss against whatever the real
 * on-disk project directory name turns out to be. Folding `\` and `:` to
 * `-` too (in addition to `/` and `.`, in case either appears) is a
 * reasonable guess at the analogous encoding, in the same shape as the
 * POSIX rule, and nothing more.
 *
 * A miss here carries no correctness risk either way: `encodeClaudeCwd`
 * only ever produces a candidate directory name inside
 * {@link locateClaudeCode}'s step 3 (newest-mtime last resort) and feeds
 * the exact-path check in its step 1 — both already sit behind the
 * session-id glob fallback, and the module's never-block guarantee (see
 * top-of-file doc) means a wrong guess here degrades to
 * `transcript_ref: null` plus a warning, never a crash or a silently wrong
 * transcript. It only affects how OFTEN Windows auto-detection succeeds,
 * not whether `slop stop`/`review`/`done`/`drop` can complete.
 */
function encodeClaudeCwd(cwd: string): string {
  if (process.platform === "win32") {
    return cwd.replace(/[/.\\:]/g, "-");
  }
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

/** `session.started_at` (ISO 8601) -> epoch ms, or `null` if absent or
 * unparseable — feeds `locateCodex`'s ambiguity check (Fix 3) only; never
 * throws, and a `null` here simply disables that check (falls back to
 * the old newest-mtime-overall behaviour), same never-block posture as
 * everything else in this module. */
function parseStartedAtMs(startedAt: string | null | undefined): number | null {
  if (startedAt === null || startedAt === undefined) return null;
  const ms = Date.parse(startedAt);
  return Number.isNaN(ms) ? null : ms;
}

/** {@link locateCodex}'s result — `path` is what callers actually use;
 * `ambiguous`/`newerThanSessionCount` exist purely so `captureTranscript`
 * can build a specific warning (Fix 3) without `locateTranscript` itself
 * having to change its own `string | null` return contract. */
interface CodexLocateResult {
  path: string | null;
  ambiguous: boolean;
  /** Count of cwd-matching rollouts strictly newer than
   * `sessionStartedAtMs` — 0 when that wasn't provided/parseable. Only
   * meaningful when `ambiguous` is true (>1); a caller diagnosing a
   * `null` result should check `ambiguous` first. */
  newerThanSessionCount: number;
}

/**
 * Fix 3 (ticket_01KY93E3WYD13E71QM7GHWG1DE): the same cwd-matching /
 * date-partitioned scan as before, but now REFUSES to pick a "newest
 * mtime" winner — returns `path: null, ambiguous: true` instead — when
 * more than one cwd-matching rollout is newer than `sessionStartedAtMs`
 * (see this module's top-of-file Fix 3 doc for the full rationale). Zero
 * or exactly one newer-than-`started_at` candidate is unambiguous and
 * resolves exactly as before: overall newest mtime among cwd matches.
 */
function locateCodex(
  codexHome: string,
  cwd: string,
  sessionStartedAtMs: number | null,
): CodexLocateResult {
  const sessionsDir = join(codexHome, "sessions");
  let best: { path: string; mtimeMs: number } | null = null;
  let newerThanSessionCount = 0;

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
          if (sessionStartedAtMs !== null && mtimeMs > sessionStartedAtMs) {
            newerThanSessionCount++;
          }
        }
      }
    }
  }

  if (sessionStartedAtMs !== null && newerThanSessionCount > 1) {
    return { path: null, ambiguous: true, newerThanSessionCount };
  }
  return { path: best?.path ?? null, ambiguous: false, newerThanSessionCount };
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
 *   3. Newest-mtime heuristic, scoped per harness, LAST RESORT. For
 *      codex specifically, this now REFUSES to pick (falls to step 4)
 *      when more than one cwd-matching candidate is newer than
 *      `sessionStartedAt` — see Fix 3 in this module's top-of-file doc.
 *   4. Nothing found (or step 3's codex ambiguity refusal fired) → `null`.
 *
 * `sessionStartedAt` (ISO 8601, optional) is the session's own
 * `started_at` — pass it whenever it's known (every real caller has it;
 * `captureTranscript` below always supplies it). Omitting it disables
 * ONLY step 3's codex ambiguity check (falls back to the pre-Fix-3
 * newest-mtime-overall behaviour) — every other harness/step is
 * unaffected either way.
 */
export function locateTranscript(
  harness: Harness,
  cwd: string,
  explicitTranscriptPath?: string | null,
  roots: LocateTranscriptRoots = {},
  sessionStartedAt?: string | null,
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
        return locateCodex(codexHome, cwd, parseStartedAtMs(sessionStartedAt)).path;
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
/**
 * Test-only artificial delay for {@link streamCopyFileAtomic}, in
 * milliseconds — lets a test simulate a large (tens-to-hundreds-of-MB)
 * transcript's copy taking real wall-clock time WITHOUT actually writing
 * a huge file to disk (a genuinely large file copies far faster on local
 * disk/tmpfs than it would over whatever real filesystem a harness's
 * transcript directory lives on, so a size-based test alone would not
 * reliably distinguish "the copy ran outside the db lock" from "it ran
 * inside it and just finished before anything could time out"). Read
 * once via `SLOP_TEST_TRANSCRIPT_COPY_DELAY_MS`; unset (0, a no-op) on
 * every real invocation — mirrors `atomic-write.ts`'s own
 * `SLOP_TEST_ATOMIC_WRITE_DELAY_MS` / this module's own
 * `SLOP_TEST_CLAUDE_HOME` test-knob convention.
 */
const TEST_COPY_DELAY_MS = (() => {
  const raw = process.env.SLOP_TEST_TRANSCRIPT_COPY_DELAY_MS;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fsync `path` — a plain file OR a directory. Opening a directory
 * read-only and syncing its fd is the standard POSIX trick for making a
 * `rename`'s directory-entry update durable, not just visible — the same
 * one `atomic-write.ts`'s own (unexported) `fsyncDir` uses; reimplemented
 * here rather than imported since it isn't part of that module's public
 * surface.
 */
async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Stream `sourcePath` -> `targetPath`: a temp file in `targetPath`'s own
 * directory, fsynced, `rename`d into place, then the containing directory
 * is fsynced too — mirroring `atomic-write.ts`'s own tmp+rename
 * discipline (see that module's doc) but for a filesystem-to-filesystem
 * copy instead of a string write. This is what lets {@link
 * captureTranscript} handle a tens-to-hundreds-of-MB transcript without
 * ever buffering the whole thing as one in-memory string (Fix 1,
 * ticket_01KY93E2ZK6Z3TFEBP86ATMW37 — see this module's top-of-file doc).
 * A reader of `targetPath` only ever observes complete old content or
 * complete new content, never a partial copy — `rename` is atomic within
 * one filesystem, which is why the temp file must live alongside the
 * target rather than in some other (possibly different-filesystem) temp
 * directory.
 */
async function streamCopyFileAtomic(sourcePath: string, targetPath: string): Promise<void> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}-${basename(targetPath)}`);
  let renamed = false;
  try {
    await pipeline(createReadStream(sourcePath), createWriteStream(tmpPath, { flags: "wx" }));
    if (TEST_COPY_DELAY_MS > 0) {
      await sleep(TEST_COPY_DELAY_MS);
    }
    await fsyncPath(tmpPath);
    await rename(tmpPath, targetPath);
    renamed = true;
    await fsyncPath(dir);
  } catch (err) {
    if (!renamed) {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
    throw err;
  }
}

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
      session.started_at,
    );

    if (sourcePath === null) {
      const hadExplicit =
        explicitTranscriptPath !== undefined &&
        explicitTranscriptPath !== null &&
        explicitTranscriptPath.trim().length > 0;
      const explicitNote = hadExplicit
        ? ` (the given --transcript path "${explicitTranscriptPath}" does not exist or is not a readable file)`
        : "";

      // Fix 3 (ticket_01KY93E3WYD13E71QM7GHWG1DE): `locateTranscript`'s
      // codex branch above already refused to return a (possibly WRONG)
      // guessed path when the cwd-matching-rollout scan was genuinely
      // ambiguous — see this module's top-of-file Fix 3 doc. This
      // re-runs that SAME cheap, bounded scan a second time, ONLY on
      // this already-"nothing to copy" path, purely so the warning below
      // can say *why* (ambiguity vs. genuinely nothing found) instead of
      // both collapsing into the same generic message.
      let ambiguityNote = "";
      if (session.harness.kind === "codex") {
        const codexHome =
          resolvedRoots.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
        const diag = locateCodex(codexHome, cwd, parseStartedAtMs(session.started_at));
        if (diag.ambiguous) {
          ambiguityNote =
            ` — ${diag.newerThanSessionCount} candidate Codex rollout files in this cwd are all ` +
            "newer than this session's own started_at (Codex exposes no session id, so mtime is " +
            "the only signal available); refusing to guess which one is this session's rather " +
            "than risk silently attaching another concurrent session's transcript";
        }
      }

      // Fix 2 (ticket_01KY9NVM1YRM1F7NX1QS5JJAW1): a RECAPTURE that finds
      // nothing new must not clobber a transcript_ref an EARLIER capture
      // on this exact session already set — `session` here is always the
      // PRE-mutation session every caller passes in (this module's
      // top-of-file doc, step 2), so `session.transcript_ref` is the
      // value already on disk. Only genuinely "never captured anything
      // for this session" still returns null.
      if (session.transcript_ref !== null) {
        return {
          transcriptRef: session.transcript_ref,
          sourcePath: null,
          warning:
            `no new transcript located for session ${session.id} on this recapture ` +
            `(harness=${session.harness.kind})${explicitNote}${ambiguityNote} — kept the ` +
            `previously-captured transcript (${session.transcript_ref}) rather than resetting ` +
            "it to null.",
        };
      }

      return {
        transcriptRef: null,
        sourcePath: null,
        warning:
          `could not locate a transcript for session ${session.id} (harness=${session.harness.kind})` +
          `${explicitNote}${ambiguityNote} — recording transcript_ref: null, never blocking. Pass ` +
          "--transcript <path> next time to point at it directly.",
      };
    }

    const transcriptsDir = join(paths.slopDir, TRANSCRIPTS_SUBDIR);
    // Defensive: `slop init` already creates this directory (D1), but
    // capture must not depend on that having happened (a pre-D1-feature
    // repo, a hand-pruned directory, ...).
    await mkdir(transcriptsDir, { recursive: true });

    const fileName = `${session.id}.jsonl`;
    // Fix 1 (ticket_01KY93E2ZK6Z3TFEBP86ATMW37): stream source -> temp ->
    // rename instead of `readFile` (whole file, buffered as one string)
    // + `atomicWriteFile` — see `streamCopyFileAtomic`'s own doc.
    await streamCopyFileAtomic(sourcePath, join(transcriptsDir, fileName));

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

// ---------------------------------------------------------------------------
// Fix 1 (ticket_01KY93E2ZK6Z3TFEBP86ATMW37) — running the locate+copy
// OUTSIDE the db lock. See this module's top-of-file doc, "Fix 1", for the
// full rationale; this is the pair of functions every stop/review/done/
// drop caller uses to do it, so all four stay identical rather than each
// growing its own copy of this logic.
// ---------------------------------------------------------------------------

/**
 * A {@link captureTranscript} result performed speculatively, OUTSIDE the
 * db lock, keyed to whichever session was active on a ticket at the time
 * of an UNLOCKED read (see {@link speculativeTranscriptCapture}). Never
 * persist `result` directly — always reconcile it against the
 * AUTHORITATIVE in-lock session via {@link resolveTranscriptCapture}
 * first, since the two reads are not atomic with each other.
 */
export interface SpeculativeTranscriptCapture {
  result: CaptureTranscriptResult;
  /** The session id `result` is actually keyed to. */
  sessionId: SessionId;
}

/**
 * Best-effort, UNLOCKED locate+copy for `activeSessionId` — the session
 * id off of a ticket a caller already read BEFORE acquiring `withLock`
 * (every `stop`/`review`/`done`/`drop` caller already does this via
 * `resolveTicketRef`, so this needs no extra ticket read of its own).
 * This is what actually moves the slow, streamed transcript I/O out from
 * under the exclusive db lock.
 *
 * Returns `null` — never throws — when `activeSessionId` is `null` (no
 * active session to capture against yet) or the speculative session read
 * itself fails for any reason (e.g. a genuinely concurrent command on
 * this exact ticket already ended that session and moved the ticket on
 * by the time this runs). Either way, {@link resolveTranscriptCapture}'s
 * in-lock fallback covers it — a `null` here never blocks the caller's
 * own state transition.
 */
export async function speculativeTranscriptCapture(
  paths: RepoPaths,
  activeSessionId: SessionId | null,
  options: Omit<CaptureTranscriptOptions, "session">,
): Promise<SpeculativeTranscriptCapture | null> {
  if (activeSessionId === null) return null;
  try {
    const session = await readSession(paths, activeSessionId);
    const result = await captureTranscript({ ...options, session });
    return { result, sessionId: session.id };
  } catch {
    return null;
  }
}

/**
 * Reconcile a {@link speculativeTranscriptCapture} result against
 * `options.session` — the AUTHORITATIVE session a caller reads once
 * INSIDE `withLock`. Reuses the speculative result outright when it was
 * keyed to the exact same session id (the overwhelmingly common case:
 * nothing can retarget a specific ticket's active session without
 * holding this same db lock first, so the session read speculatively and
 * the one read authoritatively are the same file with the same content).
 * Otherwise — a `null` speculative result, or one keyed to a DIFFERENT
 * session id (a genuinely concurrent command on this same ticket raced
 * between the speculative read and the lock) — falls back to an in-lock
 * `captureTranscript` call: still never throws, still streams, just no
 * longer overlapped with other commands in that narrow window.
 */
export async function resolveTranscriptCapture(
  speculative: SpeculativeTranscriptCapture | null,
  options: CaptureTranscriptOptions,
): Promise<CaptureTranscriptResult> {
  if (speculative !== null && speculative.sessionId === options.session.id) {
    return speculative.result;
  }
  return captureTranscript(options);
}
