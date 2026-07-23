/**
 * `.slop/db/.lock` for multi-file transactions (design.md §3: "`.slop/db/
 * .lock` for multi-file transactions (done-cascade, reparent)").
 *
 * Single-file entity writes never need this — {@link "./atomic-write.js"}
 * already makes any one file's write atomic on its own. This lock exists
 * purely for operations that must touch more than one file as one logical
 * unit (B4's done-cascade, a future reparent) so a reader never observes
 * half of a multi-file change.
 *
 * Algorithm:
 *   - Acquire by creating the lock file with `O_EXCL` (`open(path, "wx")`)
 *     — exclusive creation is atomic at the OS level, so this is never a
 *     check-then-create race between two processes.
 *   - The lock file's content records the holder's pid and an ISO
 *     timestamp, so a stuck lock is diagnosable by reading it.
 *   - **Stale-lock recovery**: if creation fails with `EEXIST`, read the
 *     existing lock. It is breakable (unlinked, then creation retried) if
 *     either: its recorded pid is no longer alive (`process.kill(pid, 0)`
 *     raises `ESRCH`), or it is older than `staleTimeoutMs`. A lock file
 *     that can't even be parsed is treated as breakable once it's older
 *     than `staleTimeoutMs` by mtime. This is what stops one `kill -9`
 *     from bricking the repo permanently — a dead holder's lock is always
 *     eventually recoverable, either instantly (dead pid) or after the
 *     generous timeout (hung-but-alive holder).
 *   - Acquisition is bounded: retries with capped exponential backoff
 *     until `timeoutMs` elapses, then throws a {@link SlopError} with the
 *     CONFLICT exit code (6) naming what's blocking it.
 *   - {@link withLock} always releases in a `finally`, so a thrown error
 *     from the wrapped function still releases the lock.
 *   - Release is a compare-and-delete: it re-reads the lock file first and
 *     only removes it if the recorded pid is still this process's pid.
 *     This matters for the (rare, but real) case where this process held
 *     the lock, stalled long enough to be declared stale and broken by
 *     someone else, and then woke back up — without this check its
 *     release would delete the *new* rightful holder's lock instead of
 *     its own (already-gone) one.
 */
import { open, readFile, rm, stat } from "node:fs/promises";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import { EXIT_CODES } from "../core/exit-codes.js";
import { SlopError } from "../cli/errors.js";
import { isEexist, isEnoent } from "./fs-utils.js";

export interface LockInfo {
  pid: number;
  acquired_at: string;
}

export interface AcquireLockOptions {
  /** Total bounded time to wait for the lock before giving up. Default 5s
   * — generous enough for a real multi-file transaction elsewhere to
   * finish, short enough that a CLI invocation doesn't hang indefinitely. */
  timeoutMs?: number;
  /** Base retry backoff; doubles (capped) on each failed attempt. */
  retryDelayMs?: number;
  /** How old (by recorded `acquired_at`, or by file mtime if the lock file
   * is unparseable) a lock must be before it's considered stale even if
   * its holder pid is still alive — covers a genuinely hung/looping
   * holder, not just a dead one. Default 5 minutes: generous relative to
   * any real v0 transaction, short enough to still self-heal a repo
   * within one coffee break. */
  staleTimeoutMs?: number;
  clock?: Clock;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const MAX_RETRY_DELAY_MS = 400;
const DEFAULT_STALE_TIMEOUT_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function isEsrch(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === "ESRCH"
  );
}

/** Is `pid` a live process? `EPERM` (exists, but we can't signal it — e.g.
 * a different user) still counts as alive, so it's treated conservatively
 * — only a confirmed `ESRCH` ("no such process") counts as dead. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !isEsrch(err);
  }
}

function tryParseLockInfo(raw: string): LockInfo | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { pid?: unknown }).pid === "number" &&
      typeof (parsed as { acquired_at?: unknown }).acquired_at === "string"
    ) {
      return parsed as LockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * If the lock at `lockPath` is stale (dead holder, or older than
 * `staleTimeoutMs`), unlink it and return `true` so the caller retries
 * acquisition immediately. Returns `false` if the lock is live and not
 * stale. Returns `true` (nothing to break) if the lock already
 * disappeared between the failed `open` and this check — a normal race
 * with whoever held it finishing up, not an error.
 */
async function tryBreakStaleLock(lockPath: string, staleTimeoutMs: number, now: number): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) return true;
    throw err;
  }

  const info = tryParseLockInfo(raw);
  let stale: boolean;
  if (info === null) {
    // Corrupt/unreadable lock content — fall back to mtime so a hand
    // -mangled lock file doesn't wedge the repo forever either.
    try {
      const st = await stat(lockPath);
      stale = now - st.mtimeMs >= staleTimeoutMs;
    } catch (err) {
      if (isEnoent(err)) return true;
      throw err;
    }
  } else {
    const deadHolder = !isProcessAlive(info.pid);
    const tooOld = now - Date.parse(info.acquired_at) >= staleTimeoutMs;
    stale = deadHolder || tooOld;
  }

  if (!stale) return false;

  try {
    await rm(lockPath, { force: true });
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  return true;
}

/**
 * Acquire `lockPath` exclusively, breaking a stale lock and retrying with
 * capped backoff until `timeoutMs` elapses. Throws a {@link SlopError}
 * (CONFLICT, exit 6) naming the holder if the lock is genuinely
 * contended and the timeout is reached.
 */
export async function acquireLock(lockPath: string, options: AcquireLockOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const clock = options.clock ?? systemClock;

  const deadline = clock.now().getTime() + timeoutMs;
  let attempt = 0;
  let lastHolderDescription = "another process";

  for (;;) {
    try {
      const info: LockInfo = { pid: process.pid, acquired_at: clock.now().toISOString() };
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (err) {
      if (!isEexist(err)) throw err;

      const broke = await tryBreakStaleLock(lockPath, staleTimeoutMs, clock.now().getTime());
      if (broke) {
        // Retry acquisition immediately, no backoff needed — but still
        // respect the deadline, so a pathological case (something else
        // keeps recreating a stale lock faster than we can claim it)
        // can't spin past `timeoutMs` without ever raising CONFLICT.
        if (clock.now().getTime() >= deadline) {
          throw new SlopError(
            `timed out waiting for the db lock at ${lockPath} (repeatedly found and broke a stale lock without acquiring it)`,
            EXIT_CODES.CONFLICT,
          );
        }
        continue;
      }

      const raw = await readFile(lockPath, "utf8").catch(() => null);
      const info = raw !== null ? tryParseLockInfo(raw) : null;
      lastHolderDescription = info
        ? `pid ${info.pid}, held since ${info.acquired_at}`
        : "another process (lock file unreadable)";

      if (clock.now().getTime() >= deadline) {
        throw new SlopError(
          `timed out waiting for the db lock at ${lockPath} (held by ${lastHolderDescription})`,
          EXIT_CODES.CONFLICT,
        );
      }

      const backoff = Math.min(retryDelayMs * 2 ** attempt, MAX_RETRY_DELAY_MS);
      attempt++;
      await sleep(backoff);
    }
  }
}

/**
 * Release `lockPath`, but only if it's still recorded as held by this
 * process (see the module doc's "compare-and-delete" note) — never
 * throws if the lock is already gone.
 */
export async function releaseLock(lockPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }

  const info = tryParseLockInfo(raw);
  if (info !== null && info.pid !== process.pid) {
    // Our hold was declared stale and broken by someone else, who has
    // since re-acquired it — do not delete it out from under them.
    return;
  }

  try {
    await rm(lockPath, { force: true });
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

/**
 * Run `fn` while holding `lockPath` exclusively; always releases,
 * including when `fn` throws. This is the only sanctioned way to perform
 * a multi-file transaction (done-cascade, reparent) — single-file writes
 * must not call this, they're already atomic on their own.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: AcquireLockOptions,
): Promise<T> {
  await acquireLock(lockPath, options);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath);
  }
}
