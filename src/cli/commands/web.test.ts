import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// web-one-malformed-db-file-500s-every-page-and-leaks-filesyst:
//
// Before this fix, `readJsoncDir`/`parseEntity` (src/web/fixture-data
// -source.ts) threw on the FIRST corrupt/schema-drifted `.jsonc` file in a
// directory listing, and every §4.4 view that needs the full ticket list
// (`/tickets`, `/tree`, `/review`, `/stale`) — plus `findTicketByRef`,
// which re-lists every ticket to resolve a single ref — called it. So one
// bad ticket file 500'd every one of those views, including an UNRELATED
// well-formed ticket's own detail page. Separately, `slop web` ran
// `Bun.serve` with no `NODE_ENV` set, so Bun's default `development: true`
// rendered that (or any other) unhandled exception as a debug page
// containing a full stack trace and the server's absolute filesystem path.
//
// This file proves both halves of the fix, end to end, over real HTTP
// against a REAL `slop init`/`slop new`/`slop start`-produced repo (never
// a hand-built fixture) with one ticket file and one session file
// deliberately corrupted after the fact — same "drive the compiled/source
// CLI, assert over HTTP" shape as tests/acceptance/D5.test.ts and
// tests/acceptance/web-real-repo.test.ts, and for the same reason: every
// Bun-only global this server is built on (`Bun.serve`, `Bun.file`,
// `Bun.YAML`) is unavailable inside a vitest test worker (verified there
// too — `typeof Bun` is `"undefined"` here), so there is no in-process way
// to drive this server; a spawned child process is the only option, and
// arguably the more honest one for exactly this ticket (dev-mode header
// leakage can only be observed on the real wire response, not by calling
// a handler function directly).
//
// Spawned from SOURCE (`bun <cliEntry> ...`) throughout — no
// `bun run build` / `dist/slop` dependency anywhere in this file, so it
// never contends with a concurrent rebuild of the shared compiled binary.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

// ---------------------------------------------------------------------------
// CLI spawn helper — strips the same harness-identity env vars
// tests/acceptance/D2.test.ts / web-real-repo.test.ts's `runSlop` does, so
// `start`'s harness auto-detection is deterministic regardless of what's
// actually running this suite.
// ---------------------------------------------------------------------------

function runSlop(
  args: string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      CLAUDE_CODE_CHILD_SESSION: undefined,
      CLAUDE_CODE_SESSION_ID: undefined,
      OPENCODE: undefined,
      OPENCODE_PID: undefined,
      CODEX_SANDBOX: undefined,
      CODEX_SANDBOX_NETWORK_DISABLED: undefined,
      CODEX_HOME: undefined,
      SLOP_TEST_CLAUDE_HOME: undefined,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface NewTicketJson {
  id: string;
  slug: string;
  name: string;
}

function newTicket(root: string, name: string): NewTicketJson {
  const result = runSlop(["new", name, "--json"], root);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as NewTicketJson;
}

interface StartJson {
  session: { id: string };
}

function startTicket(root: string, ref: string): StartJson {
  const result = runSlop(["start", ref, "--json"], root);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as StartJson;
}

// ---------------------------------------------------------------------------
// Web-server spawn/teardown — same shape as D5.test.ts's
// spawnAndWaitForUrl/stopServer (duplicated rather than imported: those are
// test-file-local helpers there too, not an exported module). `--port 0`
// (not a hardcoded port) so this suite never collides with another agent's
// concurrent `slop web` run against this same shared working tree.
// ---------------------------------------------------------------------------

interface RunningServer {
  proc: ChildProcess;
  baseUrl: string;
}

function spawnAndWaitForUrl(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 15_000,
): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(
        new Error(
          `timed out waiting for "${cmd} ${args.join(" ")}" to print a listen URL.\nstdout: ${stdout}\nstderr: ${stderr}`,
        ),
      );
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /https?:\/\/127\.0\.0\.1:\d+\//.exec(stdout);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, baseUrl: match[0] });
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(`process exited early (code ${code}) before printing a URL.\nstderr: ${stderr}`),
      );
    });
    proc.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function stopServer(server: RunningServer | undefined): Promise<void> {
  if (!server) return;
  if (server.proc.exitCode !== null || server.proc.signalCode !== null) return;
  server.proc.kill();
  await Promise.race([once(server.proc, "exit"), new Promise((r) => setTimeout(r, 3000))]);
}

// ---------------------------------------------------------------------------
// Fixture repo — built once in beforeAll, entirely through the real CLI
// (spawned from source), with two files corrupted directly on disk
// afterward:
//
//  - goodTicket: never touched. Proves an UNRELATED ticket's own detail
//    page still 200s even though badTicket's file is corrupt.
//  - badTicket: its own ticket .jsonc gets overwritten with invalid JSONC
//    after `new` creates it. Proves the listing views degrade to "N-1
//    tickets", never a 500.
//  - sessionTicket + its one session: the session's .jsonc gets overwritten
//    with invalid JSONC after `start` creates it. `getSessionById` (a
//    direct-by-id read, deliberately left strict — see fixture-data
//    -source.ts's `readJsoncDir` doc) still throws on it, so hitting its
//    transcript route is this suite's forced, genuinely-unexpected 500 —
//    proving THAT 500's body carries no filesystem path or stack trace,
//    per this ticket's `development: false` half of the fix.
// ---------------------------------------------------------------------------

let root: string;
let server: RunningServer | undefined;
let goodTicket: NewTicketJson;
let badTicket: NewTicketJson;
let sessionTicket: NewTicketJson;
let corruptedSessionId: string;

async function get(path: string, init?: RequestInit): Promise<Response> {
  if (!server) throw new Error("server not started");
  return fetch(new URL(path, server.baseUrl), init);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "slop-web-fault-tolerance-"));

  // Valid config with a jira remote (house rule: isolates this suite from
  // the separate null-remotes config-validity bug another agent is fixing
  // concurrently).
  const init = runSlop(
    [
      "init",
      "--yes",
      "--project",
      "web-fault-tolerance-fixture",
      "--user",
      "tester",
      "--jira",
      "https://web-fault-tolerance-fixture.atlassian.net",
    ],
    root,
  );
  expect(init.status, init.stderr).toBe(0);

  goodTicket = newTicket(root, "Well-formed ticket unrelated to the corrupted one");
  badTicket = newTicket(root, "Ticket whose file gets corrupted on disk");
  sessionTicket = newTicket(root, "Ticket whose session file gets corrupted on disk");

  const started = startTicket(root, sessionTicket.slug);
  corruptedSessionId = started.session.id;

  // Corrupt badTicket's own ticket file — not valid JSONC at all.
  const badTicketPath = join(root, ".slop", "db", "tickets", `${badTicket.id}.jsonc`);
  await writeFile(badTicketPath, "{ this is not valid jsonc at all !!!", "utf8");

  // Corrupt sessionTicket's one session file the same way.
  const badSessionPath = join(root, ".slop", "db", "sessions", `${corruptedSessionId}.jsonc`);
  await writeFile(badSessionPath, "{ this is not valid jsonc at all !!!", "utf8");

  server = await spawnAndWaitForUrl(
    "bun",
    [cliEntry, "web", "--port", "0"],
    root,
    // Deliberately NOT setting NODE_ENV (or SLOP_WEB_DEBUG) here — this is
    // exactly the "nothing special in the environment" real-usage case the
    // ticket describes. `Bun.serve`'s `development` option is passed
    // explicitly by `createWebServer` (src/web/server.ts), defaulting to
    // `false` off of `SLOP_WEB_DEBUG` alone — never off `NODE_ENV` — so
    // this test must pass with neither var set.
    process.env,
  );
}, 30_000);

afterAll(async () => {
  await stopServer(server);
  if (root) await rm(root, { recursive: true, force: true });
});

describe("web-one-malformed-db-file-500s-every-page-and-leaks-filesyst", () => {
  describe("a corrupt ticket file no longer breaks the listing views", () => {
    // /tickets and /tree render every ticket regardless of state, so the
    // two good tickets (freshly created, neither in "review" nor stale)
    // are asserted present there. /review and /stale are STATE-filtered
    // views — none of this fixture's tickets are in "review" state or old
    // enough to be stale, so both legitimately render an empty table; the
    // real assertion for them is simply "200, not 500" (proven separately
    // below), not that they list tickets which were never going to be in
    // an empty-by-construction filtered view in the first place.
    it.each(["/tickets", "/tree"] as const)(
      "%s still 200s and lists the good tickets, excluding only the corrupt one",
      async (path) => {
        const res = await get(path);
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain(goodTicket.name);
        expect(body).toContain(sessionTicket.name);
        // The corrupt ticket itself is simply absent, not rendered garbled.
        expect(body).not.toContain(badTicket.name);
      },
    );

    it.each(["/review", "/stale"] as const)("%s still 200s (never a 500)", async (path) => {
      const res = await get(path);
      expect(res.status).toBe(200);
      const body = await res.text();
      // Never the corrupt ticket, whatever the view's own state filter did.
      expect(body).not.toContain(badTicket.name);
    });
  });

  describe("an unrelated ticket's own detail page is unaffected", () => {
    it("200s and renders the real, unrelated, well-formed ticket", async () => {
      const res = await get(`/tickets/${goodTicket.id}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(goodTicket.name);
    });
  });

  describe("the corrupted ticket's own detail page degrades to 404, not 500", () => {
    it("404s rather than crashing (it's excluded from the tolerant listing findTicketByRef scans)", async () => {
      const res = await get(`/tickets/${badTicket.id}`);
      expect(res.status).toBe(404);
    });
  });

  describe("a genuinely unexpected 500 (corrupt session file, strict by-id read) leaks nothing", () => {
    it("still 500s — this fix does not paper over real errors", async () => {
      const res = await get(
        `/tickets/${sessionTicket.id}/sessions/${corruptedSessionId}/transcript`,
      );
      expect(res.status).toBe(500);
    });

    it("the 500 body contains no server filesystem path", async () => {
      const res = await get(
        `/tickets/${sessionTicket.id}/sessions/${corruptedSessionId}/transcript`,
      );
      const body = await res.text();
      expect(body).not.toContain(root);
      expect(body).not.toContain(".slop");
      expect(body).not.toContain("fixture-data-source");
    });

    it("the 500 body is NOT Bun's verbose dev error page (no stack trace/source excerpt)", async () => {
      const res = await get(
        `/tickets/${sessionTicket.id}/sessions/${corruptedSessionId}/transcript`,
      );
      const body = await res.text();
      // "__bunfallback" is Bun's own dev-mode error-overlay marker (see the
      // SLOP_WEB_DEBUG describe block below, which proves this SAME
      // marker DOES appear once development mode is deliberately opted
      // back into) — its absence here is the load-bearing assertion, a
      // much more precise signal than pattern-matching stack-trace-shaped
      // text, since the leaked path/source/stack in dev mode are actually
      // embedded as base64 inside that script tag, not as literal text.
      expect(body).not.toContain("__bunfallback");
      expect(body).not.toContain(".ts:");
    });
  });

  describe("still strictly read-only", () => {
    it("POST /tickets returns 405, never a mutation", async () => {
      const res = await get("/tickets", { method: "POST" });
      expect(res.status).toBe(405);
    });

    it("POST to a ticket detail route returns 405", async () => {
      const res = await get(`/tickets/${goodTicket.id}`, { method: "POST" });
      expect(res.status).toBe(405);
    });
  });
});

// ---------------------------------------------------------------------------
// SLOP_WEB_DEBUG: the explicit, opt-in escape hatch back to Bun's verbose
// dev error page — a SEPARATE server instance, spawned with the flag set,
// against the exact same corrupted-session fixture above. Proves the gate
// really is a live switch (not a no-op) rather than just proving the
// off-by-default case.
// ---------------------------------------------------------------------------

describe("SLOP_WEB_DEBUG opts back into the verbose dev error page", () => {
  let debugServer: RunningServer | undefined;

  beforeAll(async () => {
    debugServer = await spawnAndWaitForUrl("bun", [cliEntry, "web", "--port", "0"], root, {
      ...process.env,
      SLOP_WEB_DEBUG: "1",
    });
  }, 15_000);

  afterAll(async () => {
    await stopServer(debugServer);
  });

  it("the same forced 500 now DOES render Bun's verbose dev error page", async () => {
    if (!debugServer) throw new Error("debug server not started");
    const res = await fetch(
      new URL(
        `/tickets/${sessionTicket.id}/sessions/${corruptedSessionId}/transcript`,
        debugServer.baseUrl,
      ),
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    // Bun's dev-mode error overlay embeds the path/source/stack as base64
    // inside this script tag rather than as literal text (so asserting
    // the raw temp-dir path is a literal substring here would be a false
    // negative) — its PRESENCE is still the right, precise signal that
    // the escape hatch genuinely re-enabled verbose dev-mode error
    // rendering, the exact inverse of the production-mode assertion above.
    expect(body).toContain("__bunfallback");
  });
});
