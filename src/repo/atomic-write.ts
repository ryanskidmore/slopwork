/**
 * Atomic writes (design.md §3: "Atomic writes (tmp+rename) everywhere").
 *
 * Algorithm, per A3's brief:
 *   0. Self-heal a missing target directory (Fix 4, adversarial
 *      review/E2 Defect 2 — see below) — `mkdir(dir, {recursive: true})`
 *      before anything else.
 *   1. Write to a temp file in the *same directory* as the target (rename
 *      is only atomic within a filesystem — a cross-directory or
 *      cross-filesystem temp dir would silently downgrade this to a copy).
 *   2. `fsync` the temp file, so its content is durable before anything
 *      references it.
 *   3. `rename()` the temp file over the target. POSIX rename is atomic:
 *      a reader can only ever see the old complete content or the new
 *      complete content, never a partial mix.
 *   4. `fsync` the containing directory too, so the rename itself (the
 *      directory-entry update) is durable, not just the file content.
 *
 * Temp files are named `.tmp-<random>-<target-basename>` — the leading
 * dot plus the `.tmp-` marker makes them trivially distinguishable from
 * real entity filenames (`ticket_<ulid>.jsonc` etc.), and every reader in
 * this codebase lists directories by matching the strict `<kind>_<ULID>`
 * id pattern (see entity-file.ts's `listEntityIds`), so a leftover temp
 * file is never mistaken for an entity — it just doesn't match. A crash
 * between steps 2 and 3 leaves a complete-but-unrenamed temp file behind;
 * {@link sweepStaleTempFiles} cleans those up later.
 *
 * ---------------------------------------------------------------------
 * Fix 4 (adversarial review / E2 Defect 2): self-heal a missing target
 * directory, rather than crashing with a raw ENOENT
 * ---------------------------------------------------------------------
 *
 * Git does not track empty directories. A committed `.slop/db` can
 * therefore be missing `tickets/`/`sessions/`/`events/` entirely at
 * commit time (e.g. no session has EVER been created in that repo) — a
 * fresh `git clone` of it then has no such directory on disk at all,
 * until the first write of that kind. Before this fix, `atomicWriteFile`
 * never `mkdir`ed the target's directory, so `open(tmpPath, "wx")` threw a
 * raw ENOENT — the first `slop start` (or any other first-of-its-kind
 * write) in a fresh clone crashed outright, exit 1, no actionable
 * message, instead of either succeeding or failing with a clean
 * `SlopError`. `mkdir(dir, {recursive: true})` is idempotent and cheap
 * when the directory already exists (the overwhelmingly common case, one
 * extra `stat`-class syscall per write) — this is EVERY entity write's
 * shared choke point (`entity-file.ts`'s `createEntityFileCanonical`/
 * `updateEntityFile`, `lock.ts`'s lock-file write, `transcript.ts`'s
 * capture write, `init.ts`'s config/docs writes), so fixing it exactly
 * here makes every one of those call sites self-heal for free, without
 * threading "does this directory exist yet" through each of them
 * individually. `slop init` (Fix 4 part 2, `cli/commands/init.ts`) also
 * now lays down a tracked `.gitkeep` placeholder in each of `tickets/`/
 * `sessions/`/`events/`, so a freshly-initialized repo's directory
 * skeleton is always complete and committable — this self-heal is the
 * defense-in-depth backstop for every OTHER way an entity directory can
 * still end up missing (an older repo initialized before this fix, a
 * hand-deleted directory, etc.), not a replacement for it.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { isEnoent, readDirSafe } from "./fs-utils.js";

export const TEMP_FILE_PREFIX = ".tmp-";

/** Default minimum age before {@link sweepStaleTempFiles} will remove a
 * temp file — a defensive margin against sweeping a file another process
 * is genuinely still mid-write on (rare, but the whole point of a
 * "stale" sweep rather than an unconditional one). */
export const DEFAULT_SWEEP_MIN_AGE_MS = 60_000;

/**
 * Test-only crash-window widener for tests/acceptance/A3.test.ts's real
 * kill -9 test. When set via `SLOP_TEST_ATOMIC_WRITE_DELAY_MS`,
 * {@link atomicWriteFile} sleeps this many milliseconds after fsyncing
 * the temp file and before the rename, so a SIGKILL sent to a child
 * process at a randomised moment has a wide, reliable window to land
 * inside — without this knob, hitting that window purely by scheduler
 * luck across a bounded number of test iterations would either need
 * far more iterations or would be flaky. Unset (0, a no-op) on every
 * real code path; nothing outside that one test ever sets this env var.
 */
const TEST_WRITE_DELAY_MS = (() => {
  const raw = process.env.SLOP_TEST_ATOMIC_WRITE_DELAY_MS;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export function isTempFileName(name: string): boolean {
  return name.startsWith(TEMP_FILE_PREFIX);
}

function tempFilePathFor(targetPath: string): string {
  return join(dirname(targetPath), `${TEMP_FILE_PREFIX}${randomUUID()}-${basename(targetPath)}`);
}

/**
 * fsync a directory so a rename's directory-entry update is durable, not
 * just visible. POSIX-only (opening a directory for reading works on
 * Linux/macOS; there is no Windows equivalent, which is fine — v0 only
 * targets POSIX per the compiled-binary/CI setup).
 */
async function fsyncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Durability follow-up to Fix 4's self-heal (module doc above): `mkdir(dir,
 * {recursive: true})` resolves to the path of the FIRST (topmost)
 * directory it actually had to create, or `undefined` if `dir` already
 * existed (Node's documented `recursive: true` return value — the
 * overwhelmingly common case, unaffected by any of this). When it DID
 * create something, every directory from `firstCreated` down through
 * `dir` itself is brand new — and each one's own directory *entry* lives
 * in its PARENT, not in itself. `atomicWriteFile` already fsyncs `dir`
 * after the rename below, which makes durable what's INSIDE `dir` (the
 * renamed file's entry); it says nothing about whether `dir` — or any
 * newly-created ancestor of it — durably exists as an entry in ITS OWN
 * parent. A power loss right after a fresh-clone `slop start` self-heals
 * `.slop/db/sessions/` could otherwise durably write `session_x.jsonc`
 * inside `sessions/`, yet lose the `sessions` directory-entry in `db/`
 * itself, orphaning the file. Walks the newly-created chain top-down,
 * fsyncing each level's PARENT (`firstCreated`'s parent, then
 * `firstCreated` itself for its child, and so on down to — but not
 * including — `dir`, which the caller fsyncs separately right after this
 * for the rename anyway).
 */
async function fsyncNewlyCreatedDirChain(firstCreated: string, dir: string): Promise<void> {
  let level = firstCreated;
  for (;;) {
    await fsyncDir(dirname(level));
    if (level === dir) return;
    const nextSegment = relative(level, dir).split(sep)[0] ?? "";
    level = join(level, nextSegment);
  }
}

/**
 * Write `contents` to `targetPath` atomically: tmp file in the same
 * directory, fsynced, renamed over the target, then the containing
 * directory is fsynced. On any failure before the rename completes, the
 * temp file is best-effort cleaned up immediately (this is the *normal*
 * error path — disk full, permission denied, etc.); a temp file only
 * survives on disk past this function returning/throwing if the process
 * is killed outright (SIGKILL), which no in-process cleanup can catch —
 * that's what {@link sweepStaleTempFiles} is for.
 *
 * Self-heals a missing target directory first (Fix 4 — see module doc,
 * "self-heal a missing target directory"): a fresh clone missing
 * `.slop/db/sessions/` (git doesn't track empty directories) must never
 * crash on its first write of that kind. When that self-heal actually
 * creates one or more directory levels, each newly-created level's
 * parent is fsynced too (see {@link fsyncNewlyCreatedDirChain}) — the
 * common case (`dir` already exists, `mkdir` returns `undefined`) does
 * exactly one extra `stat`-class syscall and nothing more, unchanged
 * from before.
 */
export async function atomicWriteFile(targetPath: string, contents: string): Promise<void> {
  const dir = dirname(targetPath);
  const firstCreated = await mkdir(dir, { recursive: true });
  if (firstCreated !== undefined) {
    await fsyncNewlyCreatedDirChain(firstCreated, dir);
  }
  const tmpPath = tempFilePathFor(targetPath);
  let renamed = false;
  try {
    const handle = await open(tmpPath, "wx");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (TEST_WRITE_DELAY_MS > 0) {
      await sleep(TEST_WRITE_DELAY_MS);
    }

    await rename(tmpPath, targetPath);
    renamed = true;
    await fsyncDir(dir);
  } catch (err) {
    if (!renamed) {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
    throw err;
  }
}

/**
 * Remove leftover temp files from a crashed write (or, in principle, a
 * failed non-atomic step that couldn't run its own cleanup). Scans each
 * directory in `dirs` (non-recursive, each is a `tickets/`/`sessions/`/
 * `events/`/db-root directory) and removes any `.tmp-*` entry at least
 * `minAgeMs` old (default {@link DEFAULT_SWEEP_MIN_AGE_MS}), so a temp
 * file another process is legitimately still writing right now is never
 * swept out from under it. Returns the full paths removed.
 */
export async function sweepStaleTempFiles(
  dirs: string[],
  options: { minAgeMs?: number } = {},
): Promise<string[]> {
  const minAgeMs = options.minAgeMs ?? DEFAULT_SWEEP_MIN_AGE_MS;
  const removed: string[] = [];
  const now = Date.now();

  for (const dir of dirs) {
    const names = await readDirSafe(dir);
    for (const name of names) {
      if (!isTempFileName(name)) continue;
      const full = join(dir, name);
      const handle = await open(full, "r").catch((err) => {
        if (isEnoent(err)) return null;
        throw err;
      });
      if (handle === null) continue; // already gone (race with another sweep/reader)
      let ageMs: number;
      try {
        // `stat().mtimeMs` carries sub-millisecond (fractional) precision
        // on this filesystem, while `now` (captured once via `Date.now()`
        // above) is truncated to integer milliseconds. For a file written
        // in the same millisecond as `now` was captured, `mtimeMs` can be
        // numerically *greater* than `now`, making the naive `now -
        // mtimeMs` subtraction go slightly negative — which would make
        // `minAgeMs: 0` ("remove regardless of age") wrongly treat a
        // brand-new file as too fresh to sweep. Clamp to 0 so age is
        // never negative (see db-index.ts's module doc, "Content
        // staleness", for this codebase's other run-in with sub-ms/
        // coarse mtime precision).
        ageMs = Math.max(0, now - (await handle.stat()).mtimeMs);
      } finally {
        await handle.close();
      }
      if (ageMs < minAgeMs) continue;
      await rm(full, { force: true });
      removed.push(full);
    }
  }
  return removed;
}
