import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlopError } from "../cli/errors.js";
import { fixedClock } from "../core/clock.js";
import { EXIT_CODES } from "../core/exit-codes.js";
import { acquireLock, releaseLock, withLock } from "./lock.js";

/**
 * Deterministic interleaving control for the stale-break TOCTOU test below
 * (lock-stale-break-toctou). We need to force a specific race, not just
 * hope `Promise.all` schedules it: whichever contender's destructive
 * break call (`rm` pre-fix / `rename` post-fix) targeting `lockPath`
 * itself reaches the filesystem FIRST runs straight through; the SECOND
 * such call is paused — *before* it touches the filesystem — until the
 * test explicitly releases it, by which point the first contender has
 * fully finished recreating the lock. Calls targeting any other path
 * (e.g. a sentinel path used by the post-fix implementation) pass through
 * untouched, and outside of the one test that calls `gate.arm()`, this is
 * a no-op passthrough for every other test in this file.
 */
const gate = vi.hoisted(() => {
  let targetPath: string | null = null;
  let seen = 0;
  let heldResolve: (() => void) | null = null;
  let heldPromise: Promise<void> = Promise.resolve();
  let releaseResolve: (() => void) | null = null;
  let releasePromise: Promise<void> = Promise.resolve();

  return {
    arm(path: string) {
      targetPath = path;
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
    },
    /** Resolves once the second contender's destructive call has arrived and is being held. */
    held(): Promise<void> {
      return heldPromise;
    },
    /** Lets the held second contender's destructive call proceed. */
    release() {
      releaseResolve?.();
    },
    async beforeDestructive(path: string): Promise<void> {
      if (targetPath === null || path !== targetPath) return;
      seen += 1;
      if (seen === 2) {
        heldResolve?.();
        await releasePromise;
      }
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rm: typeof actual.rm = async (path, options) => {
    await gate.beforeDestructive(String(path));
    return actual.rm(path, options);
  };
  const rename: typeof actual.rename = async (oldPath, newPath) => {
    await gate.beforeDestructive(String(oldPath));
    return actual.rename(oldPath, newPath);
  };
  return { ...actual, rm, rename };
});

let scratch: string;
let lockPath: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-lock-test-"));
  lockPath = join(scratch, ".lock");
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("acquireLock / releaseLock — happy path", () => {
  it("creates a lock file recording holder pid and an ISO timestamp", async () => {
    await acquireLock(lockPath);
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
      acquired_at: string;
    };
    expect(raw.pid).toBe(process.pid);
    expect(() => new Date(raw.acquired_at).toISOString()).not.toThrow();
    await releaseLock(lockPath);
  });

  it("releaseLock removes the lock file", async () => {
    await acquireLock(lockPath);
    await releaseLock(lockPath);
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  it("releaseLock on an already-absent lock is a harmless no-op", async () => {
    await expect(releaseLock(lockPath)).resolves.toBeUndefined();
  });

  it("a second acquireLock succeeds immediately after the first releases", async () => {
    await acquireLock(lockPath);
    await releaseLock(lockPath);
    await expect(acquireLock(lockPath)).resolves.toBeUndefined();
    await releaseLock(lockPath);
  });
});

describe("withLock", () => {
  it("runs fn while holding the lock, releases on success, and returns fn's result", async () => {
    const result = await withLock(lockPath, async () => {
      await expect(readFile(lockPath, "utf8")).resolves.toBeTruthy();
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
    await expect(acquireLock(lockPath, { timeoutMs: 100 })).resolves.toBeUndefined();
    await releaseLock(lockPath);
  });
});

describe("contention: second acquirer waits, then times out with CONFLICT (exit 6)", () => {
  it("a live holder blocks a second acquirer until timeout", async () => {
    await acquireLock(lockPath); // held by this test process, never released during this test

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

    await releaseLock(lockPath);
  });

  it("the configured timeoutMs bounds the wait — a longer timeout waits longer", async () => {
    await acquireLock(lockPath);

    const start = Date.now();
    await expect(
      acquireLock(lockPath, { timeoutMs: 300, retryDelayMs: 10, staleTimeoutMs: 10_000 }),
    ).rejects.toBeInstanceOf(SlopError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(250);

    await releaseLock(lockPath);
  });

  it("a second acquirer succeeds once the first releases mid-wait", async () => {
    await acquireLock(lockPath);
    setTimeout(() => {
      releaseLock(lockPath).catch(() => {});
    }, 60);

    await expect(
      acquireLock(lockPath, { timeoutMs: 2_000, retryDelayMs: 10 }),
    ).resolves.toBeUndefined();
    await releaseLock(lockPath);
  });
});

describe("stale-lock recovery", () => {
  it("breaks a lock held by a dead pid instantly (no waiting out the full timeout)", async () => {
    // A pid essentially guaranteed not to be alive in this sandbox.
    const deadPid = 999_999_999;
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: deadPid, acquired_at: new Date().toISOString() }, null, 2)}\n`,
    );

    const start = Date.now();
    await acquireLock(lockPath, { timeoutMs: 5_000, retryDelayMs: 10, staleTimeoutMs: 10_000 });
    const elapsed = Date.now() - start;

    // Broke it well before the (generous) staleTimeoutMs/timeoutMs — dead
    // -pid detection is immediate, not a timeout fallback.
    expect(elapsed).toBeLessThan(2_000);

    const raw = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    expect(raw.pid).toBe(process.pid); // this process now genuinely holds it
    await releaseLock(lockPath);
  });

  it("breaks a lock whose holder is alive but old, by acquired_at rather than pid liveness", async () => {
    // Held "by us" (so the pid-liveness check alone would say "alive"),
    // but the recorded acquired_at is manually backdated well past
    // staleTimeoutMs — isolates the age-based half of staleness (which
    // also covers pid reuse after a crash) from the dead-pid half above.
    const oldAcquiredAt = new Date(Date.now() - 5_000).toISOString();
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, acquired_at: oldAcquiredAt }, null, 2)}\n`,
    );

    const start = Date.now();
    await acquireLock(lockPath, { timeoutMs: 3_000, retryDelayMs: 10, staleTimeoutMs: 200 });
    const elapsed = Date.now() - start;
    // Broke on (essentially) the first retry, not by waiting out timeoutMs.
    expect(elapsed).toBeLessThan(1_000);

    const raw = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    expect(raw.pid).toBe(process.pid);
    await releaseLock(lockPath);
  });

  it("does NOT break a lock that's alive and still fresh by acquired_at — times out instead", async () => {
    const freshAcquiredAt = new Date().toISOString();
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, acquired_at: freshAcquiredAt }, null, 2)}\n`,
    );
    await expect(
      acquireLock(lockPath, { timeoutMs: 100, retryDelayMs: 10, staleTimeoutMs: 60_000 }),
    ).rejects.toBeInstanceOf(SlopError);
    await rm(lockPath, { force: true });
  });

  it("uses the injected clock for the recorded acquired_at (uncontended acquire, no retry loop involved)", async () => {
    const clock = fixedClock(new Date("2026-07-23T10:00:00.000Z"));
    await acquireLock(lockPath, { clock });
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as { acquired_at: string };
    expect(raw.acquired_at).toBe("2026-07-23T10:00:00.000Z");
    await releaseLock(lockPath);
  });

  it("breaks a corrupt/unparseable lock file once it's old enough by mtime", async () => {
    await writeFile(lockPath, "not json at all {{{");
    await expect(
      acquireLock(lockPath, { timeoutMs: 2_000, retryDelayMs: 10, staleTimeoutMs: 0 }),
    ).resolves.toBeUndefined();
    await releaseLock(lockPath);
  });

  it("does NOT break a corrupt lock file that's still fresh — times out instead", async () => {
    await writeFile(lockPath, "not json at all {{{");
    await expect(
      acquireLock(lockPath, { timeoutMs: 100, retryDelayMs: 10, staleTimeoutMs: 60_000 }),
    ).rejects.toBeInstanceOf(SlopError);
  });
});

describe("stale-break TOCTOU: concurrent breakers never produce two holders (lock-stale-break-toctou)", () => {
  afterEach(() => {
    gate.disarm();
  });

  it("with a pre-existing stale lock, two concurrent acquireLock calls never both come away believing they hold it", async () => {
    // Plant an already-stale lock — backdated well past staleTimeoutMs —
    // that both contenders will independently read and judge breakable.
    const staleAcquiredAt = new Date(Date.now() - 5_000).toISOString();
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, acquired_at: staleAcquiredAt }, null, 2)}\n`,
    );

    gate.arm(lockPath);

    const attempt = (label: "first" | "second") =>
      acquireLock(lockPath, { timeoutMs: 300, retryDelayMs: 10, staleTimeoutMs: 2_000 }).then(
        () => ({ label, ok: true as const }),
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
    };
    expect(midRaw.pid).toBe(process.pid);
    expect(midRaw.acquired_at).not.toBe(staleAcquiredAt);
    const winnerAcquiredAt = midRaw.acquired_at;

    gate.release();
    const loser = winner.label === "first" ? await pSecond : await pFirst;

    // The crux of the fix: a contender that read the same stale lock but
    // arrived second must NEVER come away believing it also holds the
    // lock — it must be rejected, not silently dispossess the winner.
    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error("unreachable");
    expect(loser.error).toBeInstanceOf(SlopError);
    expect((loser.error as SlopError).exitCode).toBe(EXIT_CODES.CONFLICT);

    // And the winner's lock is still genuinely, un-clobbered held — the
    // loser's break attempt never got to delete or steal it.
    const finalRaw = JSON.parse(await readFile(lockPath, "utf8")) as { acquired_at: string };
    expect(finalRaw.acquired_at).toBe(winnerAcquiredAt);

    await releaseLock(lockPath);
  });
});

describe("release compare-and-delete", () => {
  it("releaseLock refuses to delete a lock now held by a different pid (stolen-back scenario)", async () => {
    // Simulate: we held the lock, it was declared stale and broken, and
    // someone else (a different pid) has since re-acquired it.
    await acquireLock(lockPath);
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid + 1, acquired_at: new Date().toISOString() }, null, 2)}\n`,
    );
    await releaseLock(lockPath);
    // Still there — releaseLock must not have deleted the other holder's lock.
    await expect(readFile(lockPath, "utf8")).resolves.toBeTruthy();
    await rm(lockPath, { force: true });
  });
});
