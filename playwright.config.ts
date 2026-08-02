import { spawnSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

/**
 * A hardcoded fixture-server port here was a PROVEN concurrency hazard
 * (t-ebgqb): two agents each running `bun run test:browser` in their own
 * worktree, at the same time, both try to bind the SAME port — every
 * `tests/acceptance/*.test.ts` file that spawns `slop web` already avoids
 * this by passing `--port 0` (ephemeral, OS-assigned) and parsing the
 * bound port back out of the server's own startup output; this file is the
 * one place that convention hadn't reached, since Playwright's `webServer`
 * is a single long-lived fixture server rather than a per-test spawn, and
 * needs a concrete URL up front (in static `use.baseURL`/`webServer.url`),
 * before the real server has even started to tell us what port it picked.
 *
 * Reproduced directly: two worktrees launched at the same instant, one
 * failed outright — `error: port 4765 is already in use — pass a
 * different --port, or --port 0 to pick a free one.` (slop's own
 * PortInUseError, from src/cli/commands/web.ts) — rather than either
 * queueing behind the other or (per `reuseExistingServer: !CI`, true
 * locally) transparently reusing it: the race window between "is anything
 * already listening on this port" and "bind it" meant both processes
 * decided to spawn their own server at effectively the same moment.
 *
 * Fix: pick a genuinely free port ourselves, synchronously, before
 * `defineConfig` runs, so each concurrent Playwright invocation gets its
 * own — same OS-assigned-ephemeral-port idea as `--port 0`, just resolved
 * up front here (via a throwaway `node:net` listener in a child process)
 * so the SAME concrete port number can be threaded into both
 * `use.baseURL` and `webServer.command`/`url`, which `defineConfig`'s
 * static shape requires.
 *
 * Playwright re-imports this config file fresh in EVERY worker process,
 * not just the main orchestrator (verified directly: without the
 * `process.env` round-trip below, each worker picked its OWN free port,
 * so `use.baseURL` pointed at a different port than the one `webServer`
 * actually bound — every test failed with `ERR_CONNECTION_REFUSED`
 * against a nothing-listening-there port). Stashing the chosen port back
 * onto `process.env.SLOP_TEST_BROWSER_PORT` the first time makes every
 * later re-import in this same process tree (workers are children of the
 * orchestrator and inherit its env at spawn time) see it already set and
 * reuse it, so the whole run agrees on one port. The same var doubles as
 * a manual override for anyone who wants a fixed, known port (e.g.
 * attaching a debugger to the fixture server by hand) — accepting that
 * concurrent runs must then pick different values themselves.
 */
function pickPort(): number {
  const override = process.env.SLOP_TEST_BROWSER_PORT;
  if (override !== undefined) {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const script =
    "const s=require('node:net').createServer();" +
    "s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});";
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000 });
  const port = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(
      `playwright.config.ts: could not pick a free port for the fixture server ` +
        `(status=${result.status}, stderr=${result.stderr})`,
    );
  }
  process.env.SLOP_TEST_BROWSER_PORT = String(port);
  return port;
}

const port = pickPort();

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  outputDir: "test-results/playwright",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    colorScheme: "light",
    locale: "en-US",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      `bun run build:web && cd tests/fixtures/web-db && ` +
      `SLOP_FAKE_NOW=2026-07-20T12:00:00.000Z bun ../../../src/cli/index.ts web --port ${port}`,
    url: `http://127.0.0.1:${port}/api/config`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
