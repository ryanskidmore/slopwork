import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_NOW_ISO } from "../fixtures/web-db-meta.js";

// web-add-host-header-allowlist: createWebServer (src/web/server.ts) binds
// 127.0.0.1 only, but binding to loopback alone does not stop DNS rebinding
// — a malicious external page can rebind a hostname it controls to
// 127.0.0.1 and have the victim's own browser send same-origin-looking
// requests straight at this server. Nothing previously checked the `Host`
// header a request actually arrived with, so a DNS-rebound request was
// served identically to a real request. `.slop/db` routinely contains
// secrets, so this is a real scrape vector.
//
// The Fetch API (including Node/undici's global `fetch`, verified
// directly) refuses to let a caller override the `Host` header — it's a
// forbidden request-header name per the WHATWG spec — so this file uses
// `node:http`'s lower-level `request()` instead, which has no such
// restriction and can send an arbitrary `Host` header exactly like a real
// DNS-rebound browser request would.
//
// Same real-spawned-server convention as tests/acceptance/D5.test.ts (Bun
// globals aren't available inside vitest test workers, see that file's
// header comment) — this server is spawned from source against the
// committed fixture db.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");
const fixtureParentDir = join(repoRoot, "tests", "fixtures", "web-db");

interface RunningServer {
  proc: ChildProcess;
  port: number;
}

function spawnAndWaitForUrl(timeoutMs = 15_000): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [cliEntry, "web", "--port", "0"], {
      cwd: fixtureParentDir,
      env: { ...process.env, SLOP_FAKE_NOW: FIXTURE_NOW_ISO },
    });
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

async function stopServer(server: RunningServer | undefined): Promise<void> {
  if (!server) return;
  if (server.proc.exitCode !== null || server.proc.signalCode !== null) return;
  server.proc.kill();
  await Promise.race([once(server.proc, "exit"), new Promise((r) => setTimeout(r, 3000))]);
}

/** GET `path` against the running server with an explicit `Host` header, via `node:http` (the Fetch API forbids overriding `Host` — see this file's header comment). */
function getWithHost(port: number, path: string, host: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: host } },
      (res) => {
        res.resume(); // drain, we only need status/headers
        res.on("end", () => resolve(res));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let server: RunningServer | undefined;

beforeAll(async () => {
  server = await spawnAndWaitForUrl();
}, 20_000);

afterAll(async () => {
  await stopServer(server);
});

describe("web: Host-header allowlist blocks DNS rebinding", () => {
  it("a foreign Host header gets 403 on the ticket list", async () => {
    if (!server) throw new Error("server not started");
    const res = await getWithHost(server.port, "/tickets", "evil.example");
    expect(res.statusCode).toBe(403);
  });

  it("a foreign Host header gets 403 even on an unmatched path (fetch fallback)", async () => {
    if (!server) throw new Error("server not started");
    const res = await getWithHost(server.port, "/nope/at/all", "evil.example");
    expect(res.statusCode).toBe(403);
  });

  it("a foreign Host header with the real port still gets 403 (DNS-rebinding shape)", async () => {
    if (!server) throw new Error("server not started");
    const res = await getWithHost(server.port, "/tickets", `attacker.example:${server.port}`);
    expect(res.statusCode).toBe(403);
  });

  it("localhost is allowed", async () => {
    if (!server) throw new Error("server not started");
    const res = await getWithHost(server.port, "/tickets", `localhost:${server.port}`);
    expect(res.statusCode).toBe(200);
  });

  it("127.0.0.1 is allowed", async () => {
    if (!server) throw new Error("server not started");
    const res = await getWithHost(server.port, "/tickets", `127.0.0.1:${server.port}`);
    expect(res.statusCode).toBe(200);
  });

  it("the IPv6 loopback literal [::1] is allowed", async () => {
    if (!server) throw new Error("server not started");
    const res = await getWithHost(server.port, "/tickets", `[::1]:${server.port}`);
    expect(res.statusCode).toBe(200);
  });

  it("normal browsing (real requests, no Host tampering) is unaffected", async () => {
    if (!server) throw new Error("server not started");
    for (const path of [
      "/tickets",
      "/tree",
      "/review",
      "/stale",
      "/assets/app.css",
      "/assets/app.js",
      "/api/tickets",
      "/api/tree",
      "/api/review",
      "/api/stale",
    ]) {
      const res = await getWithHost(server.port, path, `127.0.0.1:${server.port}`);
      expect(res.statusCode, path).not.toBe(403);
    }
  });
});
