import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SlopError } from "../cli/errors.js";
import { fixedClock } from "../core/clock.js";
import { EXIT_CODES } from "../core/exit-codes.js";
import { acquireLock, releaseLock, withLock } from "./lock.js";

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
  it("creates a lock file recording holder pid, ISO timestamp, and a fencing token", async () => {
    const handle = await acquireLock(lockPath);
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
      acquired_at: string;
      token: string;
    };
    expect(raw.pid).toBe(process.pid);
    expect(() => new Date(raw.acquired_at).toISOString()).not.toThrow();
    expect(raw.token).toBe(handle.token);
    expect(typeof handle.token).toBe("string");
    expect(handle.token.length).toBeGreaterThan(0);
    await releaseLock(lockPath, handle.token);
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
    await expect(acquireLock(lockPath)).resolves.toMatchObject({ token: expect.any(String) });
    await releaseLock(lockPath);
  });
});

describe("withLock", () => {
  it("runs fn while holding the lock, hands fn the lock handle, releases on success, and returns fn's result", async () => {
    const result = await withLock(lockPath, async (lock) => {
      await expect(readFile(lockPath, "utf8")).resolves.toBeTruthy();
      expect(typeof lock.token).toBe("string");
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
    await expect(acquireLock(lockPath, { timeoutMs: 100 })).resolves.toMatchObject({
      token: expect.any(String),
    });
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

  it("a second acquirer succeeds once the first releases mid-wait", async () => {
    await acquireLock(lockPath);
    setTimeout(() => {
      releaseLock(lockPath).catch(() => {});
    }, 60);

    await expect(
      acquireLock(lockPath, { timeoutMs: 2_000, retryDelayMs: 10 }),
    ).resolves.toMatchObject({ token: expect.any(String) });
    await releaseLock(lockPath);
  });
});

describe("stale-lock recovery", () => {
  it("breaks a lock held by a dead pid instantly (no waiting out the full timeout)", async () => {
    // A pid essentially guaranteed not to be alive in this sandbox.
    const deadPid = 999_999_999;
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: deadPid, acquired_at: new Date().toISOString(), token: "dead-pid-token" }, null, 2)}\n`,
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
    // staleTimeoutMs — isolates the age-based half of staleness from the
    // dead-pid half tested above.
    const oldAcquiredAt = new Date(Date.now() - 5_000).toISOString();
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, acquired_at: oldAcquiredAt, token: "old-token" }, null, 2)}\n`,
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
      `${JSON.stringify({ pid: process.pid, acquired_at: freshAcquiredAt, token: "fresh-token" }, null, 2)}\n`,
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
    ).resolves.toMatchObject({ token: expect.any(String) });
    await releaseLock(lockPath);
  });

  it("does NOT break a corrupt lock file that's still fresh — times out instead", async () => {
    await writeFile(lockPath, "not json at all {{{");
    await expect(
      acquireLock(lockPath, { timeoutMs: 100, retryDelayMs: 10, staleTimeoutMs: 60_000 }),
    ).rejects.toBeInstanceOf(SlopError);
  });
});

describe("release-on-throw compare-and-delete", () => {
  it("releaseLock (no token, legacy pid-based fallback) refuses to delete a lock now held by a different pid (stolen-back scenario)", async () => {
    // Simulate: we held the lock, it was declared stale and broken, and
    // someone else (a different pid) has since re-acquired it.
    await acquireLock(lockPath);
    await writeFile(
      lockPath,
      `${JSON.stringify(
        {
          pid: process.pid + 1,
          acquired_at: new Date().toISOString(),
          token: "someone-elses-token",
        },
        null,
        2,
      )}\n`,
    );
    await releaseLock(lockPath); // no expectedToken — exercises the pid-fallback path specifically
    // Still there — releaseLock must not have deleted the other holder's lock.
    await expect(readFile(lockPath, "utf8")).resolves.toBeTruthy();
    await rm(lockPath, { force: true });
  });

  it("releaseLock(lockPath, token) refuses to delete a lock now held by a different token, even with the SAME pid (a re-acquire by this same process)", async () => {
    // A stronger version of the scenario above: fencing tokens catch a
    // steal-back even when pid alone couldn't (e.g. this process's own
    // lock was reclaimed and then re-acquired again, by this same pid,
    // producing a fresh token) — token-based compare-and-delete is what
    // withLock actually uses.
    const handle = await acquireLock(lockPath);
    await writeFile(
      lockPath,
      `${JSON.stringify(
        { pid: process.pid, acquired_at: new Date().toISOString(), token: "a-different-token" },
        null,
        2,
      )}\n`,
    );
    await releaseLock(lockPath, handle.token);
    await expect(readFile(lockPath, "utf8")).resolves.toBeTruthy();
    await rm(lockPath, { force: true });
  });
});

describe("fencing token / assertHeld (adversarial-review Finding 1)", () => {
  it("assertHeld() succeeds and renews acquired_at while genuinely still held", async () => {
    const clock = fixedClock(new Date("2026-07-23T10:00:00.000Z"));
    const handle = await acquireLock(lockPath, { clock });
    clock.advance(1_000);
    await expect(handle.assertHeld()).resolves.toBeUndefined();
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as {
      acquired_at: string;
      token: string;
    };
    expect(raw.acquired_at).toBe("2026-07-23T10:00:01.000Z");
    expect(raw.token).toBe(handle.token); // the token itself never changes across a renewal
    await releaseLock(lockPath, handle.token);
  });

  it("assertHeld() throws SlopError CONFLICT (exit 6) once this holder has been dispossessed", async () => {
    const handle = await acquireLock(lockPath);
    // Simulate exactly what a real contender's tryBreakStaleLock + re
    // -acquire produces: the lock file now names a different holder/token.
    await writeFile(
      lockPath,
      `${JSON.stringify(
        {
          pid: process.pid + 1,
          acquired_at: new Date().toISOString(),
          token: "someone-elses-token",
        },
        null,
        2,
      )}\n`,
    );
    let threw: unknown;
    try {
      await handle.assertHeld();
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SlopError);
    expect((threw as SlopError).exitCode).toBe(EXIT_CODES.CONFLICT);
    expect((threw as SlopError).message).toMatch(/dispossessed/i);
    await rm(lockPath, { force: true });
  });

  it("assertHeld() throws CONFLICT if the lock file is gone entirely (broken and not yet re-acquired by anyone)", async () => {
    const handle = await acquireLock(lockPath);
    await rm(lockPath, { force: true });
    await expect(handle.assertHeld()).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFLICT });
  });

  it("renewal prevents a live, slow holder from being reclaimed merely for running past staleTimeoutMs", async () => {
    const handle = await acquireLock(lockPath, { staleTimeoutMs: 80 });
    const renewals = setInterval(() => {
      handle.assertHeld().catch(() => {});
    }, 20);
    try {
      // Without renewal this would be clearly stale well before 200ms —
      // the holder has been renewing the whole time via assertHeld(), so
      // a contender must still time out rather than steal it.
      await expect(
        acquireLock(lockPath, { timeoutMs: 200, retryDelayMs: 10, staleTimeoutMs: 80 }),
      ).rejects.toBeInstanceOf(SlopError);
    } finally {
      clearInterval(renewals);
      await releaseLock(lockPath, handle.token);
    }
  });

  it("withLock hands fn a handle whose assertHeld() a multi-write transaction can call between writes", async () => {
    const order: string[] = [];
    const result = await withLock(lockPath, async (lock) => {
      order.push("write1");
      await lock.assertHeld();
      order.push("write2");
      return "done";
    });
    expect(order).toEqual(["write1", "write2"]);
    expect(result).toBe("done");
  });

  it("a multi-write withLock transaction aborts loudly (CONFLICT) via assertHeld() if dispossessed between writes, and the second write never runs", async () => {
    let secondWriteRan = false;
    await expect(
      withLock(lockPath, async (lock) => {
        // Same simulated steal as above, mid-transaction.
        await writeFile(
          lockPath,
          `${JSON.stringify(
            {
              pid: process.pid + 1,
              acquired_at: new Date().toISOString(),
              token: "someone-elses-token",
            },
            null,
            2,
          )}\n`,
        );
        await lock.assertHeld();
        secondWriteRan = true;
      }),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFLICT });
    expect(secondWriteRan).toBe(false);

    // And release (in withLock's finally) correctly refused to clobber
    // the "new holder's" lock — token-based compare-and-delete held.
    const remaining = JSON.parse(await readFile(lockPath, "utf8")) as { token: string };
    expect(remaining.token).toBe("someone-elses-token");
    await rm(lockPath, { force: true });
  });
});
