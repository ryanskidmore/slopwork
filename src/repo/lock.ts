/**
 * `.slop/db/.lock` — the flatfile db's single write lock.
 *
 * Despite its original "multi-file transactions only" billing, this lock
 * serializes the WHOLE write path: every mutating command (13 of them —
 * `new`, `update` with any real field, `edit`, `draft`, `undraft`,
 * `start`, `stop`, `review`, `done`, `drop`, `plan`, `split`, and
 * `reindex --heal`) takes it around its read-modify-write, both for
 * multi-file units (the done-cascade, a reparent) AND to keep a plain
 * single-ticket read-modify-write from clobbering a concurrent writer's
 * change. The only mutating operation that skips it is the lock-free pure
 * `update --progress` event append (see docs/concurrency-and-merging.md).
 *
 * G2 (simplify-db-lock) deliberately reduced this module from a ~518-line
 * fencing protocol (per-acquisition tokens, `assertHeld()` renewal,
 * dispossession detection) to the plain mechanism below. The fencing
 * machinery guarded exactly one scenario — a live holder running past the
 * stale timeout getting silently dispossessed mid-transaction — and its
 * own decision log conceded no real call site runs anywhere near the
 * 5-minute stale timeout (every real transaction is a handful of
 * millisecond-scale file writes). What remains is the part with real call
 * sites:
 *
 *   - **Acquisition** is exclusive file creation (`O_EXCL`) — atomic at
 *     the OS level, never a check-then-create race. The lock file records
 *     `{pid, acquired_at}` so a stuck lock is diagnosable by reading it.
 *   - **Bounded waiting**: retries with capped exponential backoff until
 *     `timeoutMs` elapses (default {@link DEFAULT_TIMEOUT_MS}, 5s —
 *     configurable via `.slop/config.yaml`'s `defaults.lock_timeout`, see
 *     docs/configuration.md; the storage layer threads it through), then
 *     throws a {@link SlopError} with the CONFLICT exit code (6) naming
 *     the holder.
 *   - **Stale-lock recovery**: a lock is breakable if its recorded pid is
 *     no longer alive (`process.kill(pid, 0)` raises `ESRCH`) — the
 *     `kill -9` case, recovered instantly — or if it is older than
 *     `staleTimeoutMs` (default 5 minutes; also covers pid reuse, where a
 *     crashed holder's pid now names some unrelated long-lived process).
 *     An unparseable lock file is breakable once it's older than
 *     `staleTimeoutMs` by mtime. KEPT from the old design (and proven by
 *     its own test): breaking relocates the lock via an atomic `rename`
 *     to a breaker-unique sentinel and verifies, by content match, that
 *     what was relocated is the same stale lock this breaker inspected —
 *     a plain `rm` is a TOCTOU race in which contender B can delete the
 *     fresh, live lock contender A just legitimately created after
 *     breaking the same stale lock B read. That race is real and cheap to
 *     prevent; the fencing protocol was neither.
 *   - **Release** always runs in a `finally` and is a compare-and-delete
 *     on the recorded pid, so a process never deletes a lock that is no
 *     longer its own (e.g. its stale lock was broken and re-acquired by
 *     someone else while it slept).
 *
 * The accepted trade (documented, deliberate): a holder that genuinely
 * runs longer than `staleTimeoutMs` can have its lock broken while still
 * alive, and — with `assertHeld()` gone — nothing detects the overlap.
 * No real transaction in this codebase runs for minutes (they run for
 * milliseconds); if one ever does, that transaction needs redesigning,
 * not this lock re-complicating.
 */
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
  /** Total bounded time to wait for the lock before giving up with
   * CONFLICT (exit 6). Default {@link DEFAULT_TIMEOUT_MS} (5s) — generous
   * enough for a real transaction elsewhere to finish, short enough that
   * a CLI invocation doesn't hang indefinitely. Configurable per repo via
   * `.slop/config.yaml`'s `defaults.lock_timeout` (the storage layer
   * threads the configured value through to every `withLock` call). */
  timeoutMs?: number;
  /** Base retry backoff; doubles (capped) on each failed attempt. */
  retryDelayMs?: number;
  /** How old (by recorded `acquired_at`, or by file mtime if the lock
   * file is unparseable) a lock must be before it's considered stale even
   * if its holder pid is still alive — covers a genuinely hung holder and
   * pid reuse after a crash, not just a confirmed-dead pid. Default 5
   * minutes: generous relative to any real transaction (milliseconds),
   * short enough to self-heal a wedged repo within one coffee break. */
  staleTimeoutMs?: number;
  clock?: Clock;
}

export const DEFAULT_TIMEOUT_MS = 5_000;
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
      return { pid: (parsed as LockInfo).pid, acquired_at: (parsed as LockInfo).acquired_at };
    }
    return null;
  } catch {
    return null;
  }
}

function lockInfoText(info: LockInfo): string {
  return `${JSON.stringify(info, null, 2)}\n`;
}

/**
 * If the lock at `lockPath` is stale (dead holder pid, older than
 * `staleTimeoutMs`, or unparseable and old by mtime), break it and return
 * `true` so the caller retries acquisition immediately. Returns `false`
 * if the lock is live and not stale. Returns `true` (nothing to break) if
 * the lock already disappeared between the failed `open` and this check —
 * a normal race with whoever held it finishing up, not an error.
 *
 * Breaking is an atomic rename-away to a breaker-unique sentinel, then a
 * verify-by-content-match, NOT a plain `rm` — see the module doc's
 * "Stale-lock recovery" for the TOCTOU race this closes (two contenders
 * both judging the same stale lock breakable; the loser's blind `rm`
 * would otherwise delete the winner's fresh, live lock).
 */
async function tryBreakStaleLock(
  lockPath: string,
  staleTimeoutMs: number,
  now: number,
): Promise<boolean> {
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
    // Corrupt/unreadable lock content — fall back to mtime so a
    // hand-mangled or half-written lock file doesn't wedge the repo
    // forever either.
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

  const sentinelPath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, sentinelPath);
  } catch (err) {
    if (isEnoent(err)) return true; // someone else already broke/released it
    throw err;
  }

  let sentinelRaw: string;
  try {
    sentinelRaw = await readFile(sentinelPath, "utf8");
  } catch (err) {
    // We just created this path via `rename` — an ENOENT here would mean
    // someone else deleted it from under us, which nothing in this module
    // ever does to a sentinel path. Treat defensively as "not our win"
    // rather than throw.
    if (isEnoent(err)) return false;
    throw err;
  }

  if (sentinelRaw !== raw) {
    // We relocated a DIFFERENT (live) lock than the one we inspected —
    // someone else's winning `open(wx)` recreated `lockPath` in the gap
    // between our read above and the `rename`. Put it back and report
    // "not broken"; the caller recontends fairly via normal EEXIST
    // retry/backoff, exactly as if our rename had never happened.
    try {
      await rename(sentinelPath, lockPath);
    } catch (err) {
      // Best effort: if `lockPath` is occupied again by the time we try
      // to restore (yet another acquisition landed), there's nothing sane
      // to restore into. The rightful holder's content is still preserved
      // verbatim at `sentinelPath` either way.
      if (!isEexist(err)) throw err;
    }
    return false;
  }

  try {
    await rm(sentinelPath, { force: true });
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  return true;
}

/**
 * Acquire `lockPath` exclusively, breaking a stale lock and retrying with
 * capped backoff until `timeoutMs` elapses. Throws a {@link SlopError}
 * (CONFLICT, exit 6) naming the holder if the lock is genuinely contended
 * and the timeout is reached.
 */
export async function acquireLock(
  lockPath: string,
  options: AcquireLockOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const clock = options.clock ?? systemClock;

  const deadline = clock.now().getTime() + timeoutMs;
  let attempt = 0;

  for (;;) {
    try {
      const info: LockInfo = { pid: process.pid, acquired_at: clock.now().toISOString() };
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(lockInfoText(info), "utf8");
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

      if (clock.now().getTime() >= deadline) {
        const raw = await readFile(lockPath, "utf8").catch(() => null);
        const info = raw !== null ? tryParseLockInfo(raw) : null;
        const holderDescription = info
          ? `pid ${info.pid}, held since ${info.acquired_at}`
          : "another process (lock file unreadable)";
        throw new SlopError(
          `timed out waiting for the db lock at ${lockPath} (held by ${holderDescription})`,
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
 * process — a compare-and-delete on the recorded pid, never a blind
 * delete. This matters for the (rare, but real) case where this process
 * held the lock, stalled long enough to be declared stale and broken by
 * someone else, and then woke back up — a blind delete here would remove
 * the *new* rightful holder's lock instead of this process's own
 * (already-gone) one. Never throws if the lock is already gone.
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
 * including when `fn` throws. This is the flatfile driver's write-scope
 * primitive — commands reach it through `StorageBackend.transact`
 * (src/storage/), never directly.
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
