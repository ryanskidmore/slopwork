import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// web-second-slop-web-on: a second `slop web` started on an already-occupied
// port used to bind "successfully" on Linux anyway — reproduced directly
// against Bun 1.3.11 (two instances both printed their listen URL, and
// requests round-robined between them) — because Bun sets SO_REUSEPORT
// regardless of createWebServer's own `reusePort` docs claiming a `false`
// default. server.ts now passes `reusePort: false` explicitly. This file
// spawns two real `slop web` processes from source against the same port
// (Bun globals aren't available inside vitest test workers, see
// tests/acceptance/D5.test.ts's header comment for why every `slop web`
// assertion in this repo is a real spawned process) and asserts the second
// one fails fast with the friendly port-in-use message instead of silently
// double-binding.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");
const fixtureParentDir = join(repoRoot, "tests", "fixtures", "web-db");

interface RunningServer {
  proc: ChildProcess;
  port: number;
}

function spawnAndWaitForUrl(port: number, timeoutMs = 15_000): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [cliEntry, "web", "--port", String(port)], { cwd: fixtureParentDir });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error(`timed out waiting for slop web to print a listen URL.\nstderr: ${stderr}`));
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /https?:\/\/127\.0\.0\.1:(\d+)\//.exec(stdout);
      if (match?.[1] && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, port: Number.parseInt(match[1], 10) });
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`slop web exited early (code ${code}) before printing a URL.\n${stderr}`));
    });
  });
}

/** Spawn `slop web` on `port` and wait for it to exit (it's expected to fail immediately — the port is already taken). */
function spawnAndWaitForExit(
  port: number,
  timeoutMs = 15_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [cliEntry, "web", "--port", String(port)], { cwd: fixtureParentDir });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`timed out waiting for the second slop web to exit.\nstderr: ${stderr}`));
    }, timeoutMs);
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function stopServer(server: RunningServer | undefined): Promise<void> {
  if (!server) return;
  if (server.proc.exitCode !== null || server.proc.signalCode !== null) return;
  server.proc.kill();
  await Promise.race([once(server.proc, "exit"), new Promise((r) => setTimeout(r, 3000))]);
}

let firstServer: RunningServer | undefined;

afterEach(async () => {
  await stopServer(firstServer);
  firstServer = undefined;
});

describe("web: a second slop web on an occupied port fails instead of silently double-binding", () => {
  it("second instance exits non-zero with the friendly port-in-use message; first instance keeps serving", async () => {
    firstServer = await spawnAndWaitForUrl(0);
    const occupiedPort = firstServer.port;

    const second = await spawnAndWaitForExit(occupiedPort);
    expect(second.code, `stdout: ${second.stdout}\nstderr: ${second.stderr}`).not.toBe(0);
    expect(second.stderr).toContain(`port ${occupiedPort} is already in use`);
    // Never printed a listen URL — proof it didn't quietly bind alongside the first.
    expect(second.stdout).not.toMatch(/https?:\/\/127\.0\.0\.1:\d+\//);

    // The first instance is still the one and only server actually serving this port.
    const res = await fetch(`http://127.0.0.1:${occupiedPort}/tickets`);
    expect(res.status).toBe(200);
  });
});
