import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlopError } from "../cli/errors.js";
import { fixedClock } from "../core/clock.js";
import { EXIT_CODES } from "../core/exit-codes.js";
import { acquireLock, releaseLock, withLock } from "./lock.js";

/**
 * Deterministic interleaving control, shared by two distinct races below:
 *
 *  - the pre-existing stale-BREAK TOCTOU (two concurrent `acquireLock`
 *    calls both judging the same stale lock breakable) — `arm`'s target is
 *    `lockPath` itself, held on the SECOND matching destructive call
 *    (`rm`/`rename`).
 *  - the RELEASE TOCTOU this work item fixes (a delayed `releaseLock` racing
 *    a concurrent stale-break-and-reacquire) — `arm`'s target is a specific
 *    call, held on the FIRST (and, in that test, only) matching call.
 *
 * `holdOn` picks which. Outside the tests that call `gate.arm()`, this is a
 * no-op passthrough for every other test in this file.
 */
const gate = vi.hoisted(() => {
  let targetPath: string | null = null;
  let holdOn = 2;
  let seen = 0;
  let heldResolve: (() => void) | null = null;
  let heldPromise: Promise<void> = Promise.resolve();
  let releaseResolve: (() => void) | null = null;
  let releasePromise: Promise<void> = Promise.resolve();
  const injectedFailures = new Map<string, { fn: "rename" | "rm" | "readFile"; code: string }>();

  return {
    arm(path: string, holdOnNth = 2) {
      targetPath = path;
      holdOn = holdOnNth;
      seen = 0;
      heldPromise = new Promise<void>((resolve) => {
        heldResolve = resolve;
      });
      releasePromise = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
    },
    disarm() {
      targetPath = null;
      injectedFailures.clear();
    },
    /** Resolves once the targeted destructive call has arrived and is being held. */
    held(): Promise<void> {
      return heldPromise;
    },
    /** Lets the held destructive call proceed. */
    release() {
      releaseResolve?.();
    },
    async beforeDestructive(path: string): Promise<void> {
      if (targetPath === null || path !== targetPath) return;
      seen += 1;
      if (seen === holdOn) {
        heldResolve?.();
        await releasePromise;
      }
    },
    /** Make the NEXT `fn` call against `path` throw a synthetic error with
     * `code`, instead of touching the real filesystem — for exercising a
     * defensive catch branch (an unexpected/unlikely fs error) that a real
     * interleaving can't reliably reproduce. One-shot: consumed on first
     * matching call. */
    failNext(fn: "rename" | "rm" | "readFile", path: string, code: string) {
      injectedFailures.set(`${fn}:${path}`, { fn, code });
    },
    takeInjectedFailure(fn: "rename" | "rm" | "readFile", path: string): string | null {
      const key = `${fn}:${path}`;
      const entry = injectedFailures.get(key);
      if (entry === undefined) return null;
      injectedFailures.delete(key);
      return entry.code;
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rm: typeof actual.rm = async (path, options) => {
    const injected = gate.takeInjectedFailure("rm", String(path));
    if (injected !== null) throw Object.assign(new Error(injected), { code: injected });
    await gate.beforeDestructive(String(path));
    return actual.rm(path, options);
  };
  const rename: typeof actual.rename = async (oldPath, newPath) => {
    const injected = gate.takeInjectedFailure("rename", String(oldPath));
    if (injected !== null) throw Object.assign(new Error(injected), { code: injected });
    await gate.beforeDestructive(String(oldPath));
    return actual.rename(oldPath, newPath);
  };
  // Narrowed to the one overload this codebase actually calls
  // (`readFile(path, "utf8")`) rather than the full overload set, which a
  // single wrapper function can't satisfy cleanly.
  const readFile = (async (path: string, options: BufferEncoding) => {
    const injected = gate.takeInjectedFailure("readFile", String(path));
    if (injected !== null) throw Object.assign(new Error(injected), { code: injected });
    return actual.readFile(path, options);
  }) as typeof actual.readFile;
  return { ...actual, rm, rename, readFile };
});

let scratch: string;
let lockPath: string;

/** Manually plant lock content for a test that needs to control every
 * field directly (rather than going through a real `acquireLock`). Every
 * planted lock is structurally complete (`pid`/`acquired_at`/`token`) so it
 * exercises the SAME parsed-info path a real acquisition would, unless a
 * test deliberately omits/corrupts a field to test the malformed-content
 * fallback. */
function lockJson(overrides: { pid?: number; acquired_at?: string; token?: string }): string {
  return `${JSON.stringify(
    {
      pid: overrides.pid ?? process.pid,
      acquired_at: overrides.acquired_at ?? new Date().toISOString(),
      token: overrides.token ?? randomUUID(),
    },
    null,
    2,
  )}\n`;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-lock-test-"));
  lockPath = join(scratch, ".lock");
});

afterEach(async () => {
  gate.disarm();
  await rm(scratch, { recursive: true, force: true });
});

describe("acquireLock / releaseLock — happy path", () => {
  it("creates a lock file recording holder pid, an ISO timestamp, and a unique token", async () => {
    const lock = await acquireLock(lockPath);
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
      acquired_at: string;
      token: string;
    };
    expect(raw.pid).toBe(process.pid);
    expect(() => new Date(raw.acquired_at).toISOString()).not.toThrow();
    expect(raw.token).toBe(lock.token);
    await releaseLock(lockPath, lock);
  });

  it("releaseLock removes the lock file", async () => {
    const lock = await acquireLock(lockPath);
    await releaseLock(lockPath, lock);
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  it("a second acquireLock succeeds immediately after the first releases, with a different token", async () => {
    const first = await acquireLock(lockPath);
    await releaseLock(lockPath, first);
    const second = await acquireLock(lockPath);
    expect(second.token).not.toBe(first.token);
    await releaseLock(lockPath, second);
  });
});

describe("withLock", () => {
  it("runs fn (passed the lock handle) while holding the lock, releases on success, and returns fn's result", async () => {
    const result = await withLock(lockPath, async (lock) => {
      const raw = JSON.parse(await readFile(lockPath, "utf8")) as { token: string };
      expect(raw.token).toBe(lock.token);
      return 42;
    });
    expect(result).toBe(42);
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  it("releases the lock even when fn throws (try/finally)", async () => {
    await expect(
      withLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Lock must be gone, not leaked.
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
    // And therefore immediately re-acquirable.
    const lock = await acquireLock(lockPath, { timeoutMs: 100 });
    await releaseLock(lockPath, lock);
  });
});

describe("contention: second acquirer waits, then times out with CONFLICT (exit 6)", () => {
  it("a live holder blocks a second acquirer until timeout", async () => {
    const lock = await acquireLock(lockPath); // held by this test process, never released during this test

    const start = Date.now();
    let threw: unknown;
    try {
      await acquireLock(lockPath, { timeoutMs: 150, retryDelayMs: 10, staleTimeoutMs: 10_000 });
    } catch (err) {
      threw = err;
    }
    const elapsed = Date.now() - start;

    expect(threw).toBeInstanceOf(SlopError);
    expect((threw as SlopError).exitCode).toBe(EXIT_CODES.CONFLICT);
    expect((threw as SlopError).message).toMatch(/timed out waiting for the db lock/i);
    expect((threw as SlopError).message).toMatch(new RegExp(String(process.pid)));
    // Genuinely waited roughly the bounded timeout, not an instant failure.
    expect(elapsed).toBeGreaterThanOrEqual(120);

    await releaseLock(lockPath, lock);
  });

  it("the configured timeoutMs bounds the wait — a longer timeout waits longer", async () => {
    const lock = await acquireLock(lockPath);

    const start = Date.now();
    await expect(
      acquireLock(lockPath, { timeoutMs: 300, retryDelayMs: 10, staleTimeoutMs: 10_000 }),
    ).rejects.toBeInstanceOf(SlopError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(250);

    await releaseLock(lockPath, lock);
  });

  it("a second acquirer succeeds once the first releases mid-wait", async () => {
    const first = await acquireLock(lockPath);
    setTimeout(() => {
      releaseLock(lockPath, first).catch(() => {});
    }, 60);

    const second = await acquireLock(lockPath, { timeoutMs: 2_000, retryDelayMs: 10 });
    await releaseLock(lockPath, second);
  });
});

describe("stale-lock recovery", () => {
  it("breaks a lock held by a dead pid instantly (no waiting out the full timeout)", async () => {
    // A pid essentially guaranteed not to be alive in this sandbox.
    const deadPid = 999_999_999;
    await writeFile(lockPath, lockJson({ pid: deadPid }));

    const start = Date.now();
    const lock = await acquireLock(lockPath, {
      timeoutMs: 5_000,
      retryDelayMs: 10,
      staleTimeoutMs: 10_000,
    });
    const elapsed = Date.now() - start;

    // Broke it well before the (generous) staleTimeoutMs/timeoutMs — dead
    // -pid detection is immediate, not a timeout fallback.
    expect(elapsed).toBeLessThan(2_000);

    const raw = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; token: string };
    expect(raw.pid).toBe(process.pid); // this process now genuinely holds it
    expect(raw.token).toBe(lock.token);
    await releaseLock(lockPath, lock);
  });

  it("breaks a lock whose holder is alive but old, by acquired_at rather than pid liveness", async () => {
    // Held "by us" (so the pid-liveness check alone would say "alive"),
    // but the recorded acquired_at is manually backdated well past
    // staleTimeoutMs — isolates the age-based half of staleness (which
    // also covers pid reuse after a crash) from the dead-pid half above.
    const oldAcquiredAt = new Date(Date.now() - 5_000).toISOString();
    await writeFile(lockPath, lockJson({ acquired_at: oldAcquiredAt }));

    const start = Date.now();
    const lock = await acquireLock(lockPath, {
      timeoutMs: 3_000,
      retryDelayMs: 10,
      staleTimeoutMs: 200,
    });
    const elapsed = Date.now() - start;
    // Broke on (essentially) the first retry, not by waiting out timeoutMs.
    expect(elapsed).toBeLessThan(1_000);

    const raw = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    expect(raw.pid).toBe(process.pid);
    await releaseLock(lockPath, lock);
  });

  it("does NOT break a lock that's alive and still fresh by acquired_at — times out instead", async () => {
    await writeFile(lockPath, lockJson({}));
    await expect(
      acquireLock(lockPath, { timeoutMs: 100, retryDelayMs: 10, staleTimeoutMs: 60_000 }),
    ).rejects.toBeInstanceOf(SlopError);
    await rm(lockPath, { force: true });
  });

  it("uses the injected clock for the recorded acquired_at (uncontended acquire, no retry loop involved)", async () => {
    const clock = fixedClock(new Date("2026-07-23T10:00:00.000Z"));
    const lock = await acquireLock(lockPath, { clock });
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as { acquired_at: string };
    expect(raw.acquired_at).toBe("2026-07-23T10:00:00.000Z");
    await releaseLock(lockPath, lock);
  });

  it("breaks a corrupt/unparseable lock file once it's old enough by mtime", async () => {
    await writeFile(lockPath, "not json at all {{{");
    const lock = await acquireLock(lockPath, {
      timeoutMs: 2_000,
      retryDelayMs: 10,
      staleTimeoutMs: 0,
    });
    await releaseLock(lockPath, lock);
  });

  it("does NOT break a corrupt lock file that's still fresh — times out instead", async () => {
    await writeFile(lockPath, "not json at all {{{");
    await expect(
      acquireLock(lockPath, { timeoutMs: 100, retryDelayMs: 10, staleTimeoutMs: 60_000 }),
    ).rejects.toBeInstanceOf(SlopError);
  });

  it("treats a legacy pre-token lock file ({pid, acquired_at} only) as unparseable, not as a live match", async () => {
    // A lock file written by a pre-t-cloj2-follow-up binary mid-upgrade has
    // no `token` at all — `tryParseLockInfo` must not silently accept it as
    // structurally valid (that would defeat the whole point of a token);
    // it falls back to the same mtime-based staleness every other
    // malformed lock uses.
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }, null, 2)}\n`,
    );
    await expect(
      acquireLock(lockPath, { timeoutMs: 100, retryDelayMs: 10, staleTimeoutMs: 60_000 }),
    ).rejects.toBeInstanceOf(SlopError);
    const lock = await acquireLock(lockPath, {
      timeoutMs: 2_000,
      retryDelayMs: 10,
      staleTimeoutMs: 0,
    });
    await releaseLock(lockPath, lock);
  });
});

describe("stale-break TOCTOU: concurrent breakers never produce two holders (lock-stale-break-toctou)", () => {
  it("with a pre-existing stale lock, two concurrent acquireLock calls never both come away believing they hold it", async () => {
    // Plant an already-stale lock — backdated well past staleTimeoutMs —
    // that both contenders will independently read and judge breakable.
    const staleAcquiredAt = new Date(Date.now() - 5_000).toISOString();
    await writeFile(lockPath, lockJson({ acquired_at: staleAcquiredAt }));

    gate.arm(lockPath, 2);

    const attempt = (label: "first" | "second") =>
      acquireLock(lockPath, { timeoutMs: 300, retryDelayMs: 10, staleTimeoutMs: 2_000 }).then(
        (lock) => ({ label, ok: true as const, lock }),
        (error: unknown) => ({ label, ok: false as const, error }),
      );

    const pFirst = attempt("first");
    const pSecond = attempt("second");

    // Wait until exactly one contender's destructive break call is being
    // held — the other one is free to run straight through to a full
    // acquisition.
    await gate.held();
    const winner = await Promise.race([pFirst, pSecond]);
    if (!winner.ok) {
      throw new Error(`expected the unheld contender to win cleanly, got: ${String(winner.error)}`);
    }

    // Before releasing the held contender: the winner's fresh lock really
    // is what's on disk right now (not the stale content both read).
    const midRaw = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
      acquired_at: string;
      token: string;
    };
    expect(midRaw.pid).toBe(process.pid);
    expect(midRaw.acquired_at).not.toBe(staleAcquiredAt);
    expect(midRaw.token).toBe(winner.lock.token);

    gate.release();
    const loser = winner.label === "first" ? await pSecond : await pFirst;

    // The crux of the (pre-existing) fix: a contender that read the same
    // stale lock but arrived second must NEVER come away believing it also
    // holds the lock — it must be rejected, not silently dispossess the
    // winner.
    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error("unreachable");
    expect(loser.error).toBeInstanceOf(SlopError);
    expect((loser.error as SlopError).exitCode).toBe(EXIT_CODES.CONFLICT);

    // And the winner's lock is still genuinely, un-clobbered held — the
    // loser's break attempt never got to delete or steal it.
    const finalRaw = JSON.parse(await readFile(lockPath, "utf8")) as { token: string };
    expect(finalRaw.token).toBe(winner.lock.token);

    await releaseLock(lockPath, winner.lock);
  });
});

describe("release compare-and-delete (token-based)", () => {
  it("releaseLock refuses to delete a lock now held by a different token (stolen-back scenario)", async () => {
    // Simulate: we held the lock, it was declared stale and broken, and
    // someone else has since re-acquired it (a fresh token, possibly even
    // the same pid — pid alone could never distinguish this).
    const lock = await acquireLock(lockPath);
    await writeFile(lockPath, lockJson({}));
    await releaseLock(lockPath, lock);
    // Still there — releaseLock must not have deleted the other holder's lock.
    await expect(readFile(lockPath, "utf8")).resolves.toBeTruthy();
    await rm(lockPath, { force: true });
  });

  it("same-pid back-to-back acquisitions get distinct tokens, and an obsolete handle cannot release its replacement", async () => {
    const obsolete = await acquireLock(lockPath);
    await rm(lockPath, { force: true }); // simulates someone else breaking + fully removing our stale hold
    const replacement = await acquireLock(lockPath);

    expect(replacement.token).not.toBe(obsolete.token);
    await releaseLock(lockPath, obsolete); // no-op: token no longer matches
    await expect(readFile(lockPath, "utf8")).resolves.toContain(replacement.token);
    await releaseLock(lockPath, replacement);
  });

  it("release is harmless once its lock has already disappeared", async () => {
    const lock = await acquireLock(lockPath);
    await rm(lockPath, { force: true });
    await expect(releaseLock(lockPath, lock)).resolves.toBeUndefined();
  });
});

describe("release TOCTOU (the race this work item closes)", () => {
  afterEach(() => {
    gate.disarm();
  });

  it("a delayed release does not destroy a lock legitimately reacquired by someone else in the gap", async () => {
    // Plant a lock recorded as held by THIS process but backdated well
    // past a short staleTimeoutMs — a holder that is genuinely still
    // alive (same pid, still running — e.g. a slow release call) but old
    // enough that another contender is entitled to reclaim it as stale
    // (the module's own documented, accepted trade-off).
    const oldAcquiredAt = new Date(Date.now() - 5_000).toISOString();
    const stale = lockJson({ acquired_at: oldAcquiredAt });
    await writeFile(lockPath, stale);
    const staleInfo = JSON.parse(stale) as { token: string };

    // Hold releaseLock's OWN rename call (the first, and only, rename of
    // `lockPath` this test drives directly) right after it re-reads and
    // confirms the token — before it acts on that confirmation.
    gate.arm(lockPath, 1);
    const releasing = releaseLock(lockPath, { token: staleInfo.token });
    await gate.held();

    // While the release is paused, a concurrent contender legitimately
    // reclaims the (stale-by-age) lock and re-acquires it fresh — a
    // DIFFERENT acquisition, but (same process) the same pid a pid-only
    // check could never distinguish from the one being released.
    const contender = await acquireLock(lockPath, {
      timeoutMs: 2_000,
      retryDelayMs: 10,
      staleTimeoutMs: 50,
    });
    expect(contender.token).not.toBe(staleInfo.token);

    // Let the stalled release proceed.
    gate.release();
    await releasing;

    // THE FIX: the stalled release's rename-then-verify sees a token
    // mismatch after relocating whatever was at `lockPath`, restores it
    // untouched, and never deletes it — the contender's lock survives.
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as { token: string };
    expect(raw.token).toBe(contender.token);

    await releaseLock(lockPath, contender);
  });
});

describe("releaseLock's own defensive fs-error branches", () => {
  afterEach(() => {
    gate.disarm();
  });

  it("treats the lock disappearing between the token check and its own rename as already-released", async () => {
    const lock = await acquireLock(lockPath);
    gate.failNext("rename", lockPath, "ENOENT");
    await expect(releaseLock(lockPath, lock)).resolves.toBeUndefined();
  });

  it("propagates an unexpected error from its own rename, rather than swallowing it", async () => {
    const lock = await acquireLock(lockPath);
    gate.failNext("rename", lockPath, "EPERM");
    await expect(releaseLock(lockPath, lock)).rejects.toMatchObject({ code: "EPERM" });
    await releaseLock(lockPath, lock); // clean up for afterEach's rm(scratch)
  });

  it("treats its own just-renamed retirement path disappearing as not its win to report", async () => {
    const lock = await acquireLock(lockPath);
    const retiredPath = `${lockPath}.released-${lock.token}`;
    gate.failNext("readFile", retiredPath, "ENOENT");
    await expect(releaseLock(lockPath, lock)).resolves.toBeUndefined();
  });

  it("propagates an unexpected error reading its own retirement path", async () => {
    const lock = await acquireLock(lockPath);
    const retiredPath = `${lockPath}.released-${lock.token}`;
    gate.failNext("readFile", retiredPath, "EIO");
    await expect(releaseLock(lockPath, lock)).rejects.toMatchObject({ code: "EIO" });
  });

  it("tolerates the restore-rename finding lockPath already reoccupied (EEXIST) after a token mismatch", async () => {
    const lock = await acquireLock(lockPath);
    const originalRaw = await readFile(lockPath, "utf8");
    const retiredPath = `${lockPath}.released-${lock.token}`;

    // Pause releaseLock's own rename-away right before it executes.
    gate.arm(lockPath, 1);
    const releasing = releaseLock(lockPath, lock);
    await gate.held();

    // While paused, someone else's cycle rewrites `lockPath`'s content IN
    // PLACE (simulating a stale-break-and-reacquire landing before our
    // rename runs) — different bytes under the SAME path, so the
    // post-rename re-read at `retiredPath` will mismatch what we
    // originally read.
    const replacement = `${JSON.stringify(
      { pid: process.pid, acquired_at: new Date(0).toISOString(), token: randomUUID() },
      null,
      2,
    )}\n`;
    await writeFile(lockPath, replacement);

    // The restore-back attempt (`rename(retiredPath, lockPath)`) is what a
    // FOURTH party landing in that narrow window would race — synthesize
    // its failure rather than trying to reproduce that directly.
    gate.failNext("rename", retiredPath, "EEXIST");

    gate.release();
    await expect(releasing).resolves.toBeUndefined(); // tolerated, not thrown
    void originalRaw;

    // The mismatched content survives, untouched, at the retired path —
    // the (synthetically blocked) restore never got to move it back.
    await expect(readFile(retiredPath, "utf8")).resolves.toBe(replacement);
  });

  it("propagates an unexpected error from the restore-rename, rather than swallowing it", async () => {
    const lock = await acquireLock(lockPath);
    const retiredPath = `${lockPath}.released-${lock.token}`;

    gate.arm(lockPath, 1);
    const releasing = releaseLock(lockPath, lock);
    await gate.held();

    const replacement = `${JSON.stringify(
      { pid: process.pid, acquired_at: new Date(0).toISOString(), token: randomUUID() },
      null,
      2,
    )}\n`;
    await writeFile(lockPath, replacement);
    gate.failNext("rename", retiredPath, "EPERM");

    gate.release();
    await expect(releasing).rejects.toMatchObject({ code: "EPERM" });
  });
});
