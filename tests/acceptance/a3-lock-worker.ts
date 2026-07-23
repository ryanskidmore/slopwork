#!/usr/bin/env bun
/**
 * Child-process worker for tests/acceptance/A3.test.ts's real multi
 * -process lock-fencing test (adversarial-review Finding 1). Two roles:
 *
 *   holder    — acquires the lock, then goes "unresponsive" for
 *               `hangMs` (simulates a GC pause / cgroup throttle / I/O
 *               stall — anything that makes a genuinely-alive holder run
 *               past staleTimeoutMs without calling assertHeld()), then
 *               calls assertHeld() exactly once and records whether it
 *               threw. Only writes to the shared counter file if
 *               assertHeld() *succeeded* — that write is exactly what a
 *               dispossessed holder must never reach.
 *   contender — waits `stealDelayMs` (chosen to land well past
 *               staleTimeoutMs), then acquires the same lock (which
 *               requires breaking the holder's now-stale lock) and
 *               increments the shared counter file itself.
 *
 * Both append one line per step to `resultPath` so the parent test can
 * assert on outcome without racing stdout parsing across two processes.
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { SlopError } from "../../src/cli/errors.js";
import { acquireLock, releaseLock } from "../../src/repo/lock.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function log(resultPath: string, line: string): Promise<void> {
  await appendFile(resultPath, `${line}\n`);
}

/** A deliberately non-atomic read-then-write, exactly the shape of the
 * "shared counter" the reviewer used to demonstrate the lost-update
 * failure: correctness here depends ENTIRELY on the lock actually being
 * held exclusively, not on this increment being atomic by itself. */
async function bumpCounter(counterPath: string): Promise<void> {
  const current = Number((await readFile(counterPath, "utf8")).trim());
  await sleep(50);
  await writeFile(counterPath, String(current + 1));
}

async function main(): Promise<void> {
  const [, , role, lockPath, resultPath, counterPath, ...rest] = process.argv;
  if (!role || !lockPath || !resultPath || !counterPath) {
    throw new Error(
      "usage: a3-lock-worker.ts <holder|contender> <lockPath> <resultPath> <counterPath> <staleTimeoutMs> <delayMs>",
    );
  }

  if (role === "holder") {
    const staleTimeoutMs = Number(rest[0]);
    const hangMs = Number(rest[1]);
    const handle = await acquireLock(lockPath, {
      staleTimeoutMs,
      timeoutMs: 10_000,
      retryDelayMs: 10,
    });
    await log(resultPath, "holder:acquired");
    await sleep(hangMs); // simulate a hang — no assertHeld() calls during this window
    try {
      await handle.assertHeld();
      await log(resultPath, "holder:assertHeld:ok");
      await bumpCounter(counterPath);
      await log(resultPath, "holder:wrote");
      await releaseLock(lockPath, handle.token);
    } catch (err) {
      const exitCode = err instanceof SlopError ? err.exitCode : "unknown";
      await log(resultPath, `holder:assertHeld:threw:${exitCode}`);
    }
    return;
  }

  if (role === "contender") {
    const staleTimeoutMs = Number(rest[0]);
    const stealDelayMs = Number(rest[1]);
    await sleep(stealDelayMs);
    const handle = await acquireLock(lockPath, {
      staleTimeoutMs,
      timeoutMs: 10_000,
      retryDelayMs: 10,
    });
    await log(resultPath, "contender:acquired");
    await bumpCounter(counterPath);
    await log(resultPath, "contender:wrote");
    await releaseLock(lockPath, handle.token);
    return;
  }

  throw new Error(`unknown role: ${role}`);
}

await main();
