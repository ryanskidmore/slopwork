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
 *   - The lock file's content records the holder's pid, an ISO timestamp,
 *     and a unique **fencing token** (a ULID) — so a stuck lock is
 *     diagnosable by reading it, and so a dispossessed holder can tell it
 *     no longer legitimately holds the lock (see "Fencing" below).
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
 *
 * ## Fencing (adversarial-review Finding 1)
 *
 * Staleness alone can't distinguish a **hung** holder from a **slow but
 * alive** one — a legitimate holder that runs past `staleTimeoutMs`
 * (contended, I/O-stalled, GC-paused, cgroup-throttled) looks identical,
 * from the outside, to a genuinely dead one. Without fencing, a slow
 * holder's lock could be silently stolen while it keeps writing, giving
 * two processes the "exclusive" section at once with no error at all —
 * reproduced by the reviewer as a lost update to a shared counter, with
 * neither writer ever seeing an error.
 *
 * The fix has two halves:
 *   1. Every acquisition mints a unique **fencing token** (a ULID),
 *      recorded in the lock file alongside pid/`acquired_at`.
 *      {@link acquireLock} (and therefore {@link withLock}) returns a
 *      {@link LockHandle} exposing `assertHeld()`, which re-reads the
 *      lock file and throws a {@link SlopError} (CONFLICT, exit 6) if the
 *      recorded token no longer matches this handle's — i.e. this
 *      process has been dispossessed (its lock was declared stale and
 *      broken by someone else). **A dispossessed holder must fail loudly
 *      rather than continue writing** — that's what `assertHeld()` is
 *      for.
 *   2. `assertHeld()` also **renews** the lock: on success (token still
 *      matches), it refreshes the recorded `acquired_at` to "now". A
 *      holder that calls `assertHeld()` regularly as it works is
 *      therefore never reclaimed merely for running long — this turns
 *      the staleness timeout into "no progress for `staleTimeoutMs`", not
 *      "started more than `staleTimeoutMs` ago", which is what it should
 *      have meant all along.
 *
 * **Every call site that performs more than one write inside a single
 * {@link withLock} block MUST call the handle's `assertHeld()` between
 * writes** (not just once at the top) — B4's done-cascade and any future
 * reparent are the intended callers. Skipping it defeats the whole
 * mechanism: a transaction that never checks back in can still be
 * dispossessed partway through and keep writing under someone else's
 * nose, exactly the silent-two-holders failure this exists to prevent.
 * Calling `assertHeld()` liberally is cheap (one `readFile` + one
 * `atomicWriteFile`) relative to any real entity write, so there's no
 * reason to economize on it.
 *
 *   - {@link withLock} always releases in a `finally`, so a thrown error
 *     from the wrapped function still releases the lock.
 *   - Release is a compare-and-delete: it re-reads the lock file first and
 *     only removes it if it's still this acquisition's lock — by fencing
 *     token when the caller has one (every {@link withLock}/{@link
 *     acquireLock} caller does, via {@link LockHandle.token}), falling
 *     back to pid-comparison for a caller that only ever had a bare
 *     `lockPath`. This matters for the (rare, but real) case where this
 *     process held the lock, stalled long enough to be declared stale and
 *     broken by someone else, and then woke back up — without this check
 *     its release would delete the *new* rightful holder's lock instead
 *     of its own (already-gone) one.
 */
import { open, readFile, rm, stat } from "node:fs/promises";
import { ulid } from "ulid";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import { EXIT_CODES } from "../core/exit-codes.js";
import { SlopError } from "../cli/errors.js";
import { atomicWriteFile } from "./atomic-write.js";
import { isEexist, isEnoent } from "./fs-utils.js";

export interface LockInfo {
  pid: number;
  acquired_at: string;
  /** Unique per-acquisition fencing token (adversarial-review Finding 1) — see the module doc's "Fencing" section. */
  token: string;
}

/**
 * Returned by {@link acquireLock} and handed to {@link withLock}'s
 * callback. See the module doc's "Fencing" section for the full contract.
 */
export interface LockHandle {
  /** This acquisition's fencing token — the same value recorded in the lock file at acquire time. */
  readonly token: string;
  /**
   * Re-reads the lock file and confirms this handle's token still
   * matches what's on disk. Throws a {@link SlopError} (CONFLICT, exit 6)
   * if not — this process has been dispossessed and MUST stop writing.
   * On success, also renews the lock by refreshing its recorded
   * `acquired_at`, so a genuinely-alive holder that calls this regularly
   * is never reclaimed merely for running past `staleTimeoutMs`.
   */
  assertHeld(): Promise<void>;
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
   * within one coffee break. A holder that calls its acquired {@link
   * LockHandle}'s `assertHeld()` regularly renews `acquired_at`, so this
   * is really "no progress for this long", not "acquired this long ago"
   * — see the module doc's "Fencing" section. */
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
      typeof (parsed as { acquired_at?: unknown }).acquired_at === "string" &&
      typeof (parsed as { token?: unknown }).token === "string"
    ) {
      return parsed as LockInfo;
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
 * If the lock at `lockPath` is stale (dead holder, or older than
 * `staleTimeoutMs`), unlink it and return `true` so the caller retries
 * acquisition immediately. Returns `false` if the lock is live and not
 * stale. Returns `true` (nothing to break) if the lock already
 * disappeared between the failed `open` and this check — a normal race
 * with whoever held it finishing up, not an error.
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
    // Corrupt/unreadable lock content — fall back to mtime so a hand
    // -mangled lock file doesn't wedge the repo forever either. A lock
    // file written before fencing tokens existed (no `token` field) also
    // lands here — harmless: it's just treated by mtime instead of by
    // its (otherwise well-formed) acquired_at/pid, and still self-heals
    // once it's old enough.
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
 * {@link LockHandle.assertHeld}'s implementation — see the module doc's
 * "Fencing" section for the full contract. Treats a lock file that is
 * simply gone (ENOENT) the same as one now naming a different
 * token/holder: both mean this process no longer holds it.
 */
async function assertLockHeld(lockPath: string, token: string, clock: Clock): Promise<void> {
  let raw: string | null;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      raw = null;
    } else {
      throw err;
    }
  }

  const info = raw === null ? null : tryParseLockInfo(raw);
  if (info === null || info.token !== token) {
    const holderDescription =
      info !== null
        ? `pid ${info.pid}, held since ${info.acquired_at}`
        : "another process (the lock file is gone or unreadable)";
    throw new SlopError(
      `lost the db lock at ${lockPath} — it is now held by ${holderDescription}, not this process. ` +
        "This process was dispossessed (its stale timeout elapsed and another process reclaimed the " +
        "lock) and must stop writing immediately rather than continue a multi-file transaction under " +
        "the assumption of exclusivity.",
      EXIT_CODES.CONFLICT,
    );
  }

  // Still genuinely held — renew so a slow-but-alive holder that calls
  // this regularly is never reclaimed merely for running past
  // staleTimeoutMs (module doc's "Fencing", half 2).
  await atomicWriteFile(
    lockPath,
    lockInfoText({ pid: info.pid, acquired_at: clock.now().toISOString(), token: info.token }),
  );
}

/**
 * Acquire `lockPath` exclusively, breaking a stale lock and retrying with
 * capped backoff until `timeoutMs` elapses. Throws a {@link SlopError}
 * (CONFLICT, exit 6) naming the holder if the lock is genuinely
 * contended and the timeout is reached. Returns a {@link LockHandle} —
 * see the module doc's "Fencing" section for why every multi-write
 * caller needs it.
 */
export async function acquireLock(
  lockPath: string,
  options: AcquireLockOptions = {},
): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const clock = options.clock ?? systemClock;

  const deadline = clock.now().getTime() + timeoutMs;
  let attempt = 0;
  let lastHolderDescription = "another process";

  for (;;) {
    try {
      const token = ulid();
      const info: LockInfo = { pid: process.pid, acquired_at: clock.now().toISOString(), token };
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(lockInfoText(info), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        token,
        assertHeld: () => assertLockHeld(lockPath, token, clock),
      };
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
 * acquisition — see the module doc's "compare-and-delete" note. Never
 * throws if the lock is already gone.
 *
 * Pass `expectedToken` (every {@link withLock}/{@link acquireLock} caller
 * has one, via {@link LockHandle.token}) for an exact, fencing-token
 * compare-and-delete. Omitting it falls back to the older, coarser
 * pid-based comparison — kept only for a caller that released a bare
 * `lockPath` without ever holding onto its handle.
 */
export async function releaseLock(lockPath: string, expectedToken?: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }

  const info = tryParseLockInfo(raw);
  if (info !== null) {
    const stillOurs =
      expectedToken !== undefined ? info.token === expectedToken : info.pid === process.pid;
    if (!stillOurs) {
      // Our hold was declared stale and broken by someone else, who has
      // since re-acquired it — do not delete it out from under them.
      return;
    }
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
 *
 * `fn` receives the {@link LockHandle} this acquisition produced.
 * **Every `fn` that performs more than one entity write MUST call
 * `lock.assertHeld()` between writes** — see the module doc's "Fencing"
 * section for why: without it, a transaction that runs long enough to be
 * declared stale can be silently dispossessed partway through and keep
 * writing as if nothing happened, which is exactly the two-concurrent-
 * holders failure this whole mechanism exists to prevent. A single-write
 * `fn` doesn't strictly need to call it (the `acquireLock` that already
 * ran inside `withLock` established exclusivity for that one write), but
 * doing so anyway is always safe and cheap.
 */
export async function withLock<T>(
  lockPath: string,
  fn: (lock: LockHandle) => Promise<T>,
  options?: AcquireLockOptions,
): Promise<T> {
  const lock = await acquireLock(lockPath, options);
  try {
    return await fn(lock);
  } finally {
    await releaseLock(lockPath, lock.token);
  }
}
