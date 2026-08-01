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

// ---------------------------------------------------------------------------
// cli-input-validation-reject-truncated-numerics-fix-actor-fai:
//
// `--port` used to accept any integer `parseIntegerOption` produced with
// no bound-check at all, so `--port 99999` or `--port -1` were silently
// passed straight through to `startWebServer`. Commander parses/validates
// options (running the option's parser function) BEFORE invoking the
// command's action, so an invalid `--port` value is rejected during
// argument parsing, before `slop web` ever looks for a `.slop` directory
// or starts a server — these tests spawn the CLI in a plain scratch dir
// (no `slop init` needed) and assert on the resulting exit code alone,
// same "spawn the real CLI, never import server.ts's Bun-only globals into
// vitest" reasoning as the rest of this file (see the module doc above).
// ---------------------------------------------------------------------------

describe("slop web --port bound-check (0-65535)", () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "slop-web-port-validation-"));
  });

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("rejects a value above the valid range (--port 99999)", () => {
    const result = runSlop(["web", "--port", "99999"], scratch);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--port");
  });

  it("rejects a negative value (--port -1)", () => {
    const result = runSlop(["web", "--port", "-1"], scratch);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--port");
  });

  it("rejects non-integer garbage via the shared parseIntegerOption bound (--port 3xyz)", () => {
    const result = runSlop(["web", "--port", "3xyz"], scratch);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--port");
  });

  it("accepts 0 (its documented 'pick a free port' meaning), failing later only for lack of a .slop dir", () => {
    const result = runSlop(["web", "--port", "0"], scratch);
    // No `slop init` in `scratch`, so this still fails — but on the
    // shared `requireRepoRoot` "not a slopwork repo" check inside the
    // action, which only runs AFTER option parsing succeeded, proving
    // `--port 0` itself parsed and was accepted rather than rejected by
    // the bound-check.
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("not a slopwork repo");
    expect(result.stderr).not.toContain("--port");
  });

  it("accepts a normal port, failing later only for lack of a .slop dir", () => {
    const result = runSlop(["web", "--port", "4553"], scratch);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("not a slopwork repo");
    expect(result.stderr).not.toContain("--port");
  });
});

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
// Fixture repos — built once in beforeAll, entirely through the real CLI
// (spawned from source), with files corrupted directly on disk afterward:
//
//  - goodTicket: never touched. Proves an UNRELATED ticket's own detail
//    page still 200s even though badTicket's file is corrupt.
//  - badTicket: its own ticket .jsonc gets overwritten with invalid JSONC
//    after `new` creates it. Proves the listing views degrade to "N-1
//    tickets", never a 500.
//  - sessionTicket + its one session: the session's .jsonc gets overwritten
//    with invalid JSONC after `start` creates it. Proves the tolerant
//    sessions listing skips it without 500ing the ticket's own detail page.
//  - brokenRoot: a SECOND, separate repo whose `db/events` directory is
//    replaced by a plain file, so every view's `listEvents()` readdir throws
//    ENOTDIR — this suite's forced, genuinely-unexpected 500, proving THAT
//    500's body carries no filesystem path or stack trace, per this
//    ticket's `development: false` half of the fix.
// ---------------------------------------------------------------------------

let root: string;
let brokenRoot: string;
let server: RunningServer | undefined;
let brokenServer: RunningServer | undefined;
let goodTicket: NewTicketJson;
let badTicket: NewTicketJson;
let sessionTicket: NewTicketJson;
let corruptedSessionId: string;

async function get(path: string, init?: RequestInit): Promise<Response> {
  if (!server) throw new Error("server not started");
  return fetch(new URL(path, server.baseUrl), init);
}

async function getBroken(path: string, init?: RequestInit): Promise<Response> {
  if (!brokenServer) throw new Error("broken server not started");
  return fetch(new URL(path, brokenServer.baseUrl), init);
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

  // The second, deliberately-broken repo: `db/events` becomes a plain file,
  // so `readdir` on it throws ENOTDIR — an unexpected error class the
  // tolerant readers deliberately do NOT swallow (only ENOENT is).
  brokenRoot = await mkdtemp(join(tmpdir(), "slop-web-forced-500-"));
  const brokenInit = runSlop(
    ["init", "--yes", "--project", "web-forced-500-fixture", "--user", "tester"],
    brokenRoot,
  );
  expect(brokenInit.status, brokenInit.stderr).toBe(0);
  newTicket(brokenRoot, "Ticket in the broken repo");
  const eventsDir = join(brokenRoot, ".slop", "db", "events");
  await rm(eventsDir, { recursive: true, force: true });
  await writeFile(eventsDir, "not a directory\n", "utf8");

  brokenServer = await spawnAndWaitForUrl(
    "bun",
    [cliEntry, "web", "--port", "0"],
    brokenRoot,
    process.env,
  );
}, 30_000);

afterAll(async () => {
  await stopServer(server);
  await stopServer(brokenServer);
  if (root) await rm(root, { recursive: true, force: true });
  if (brokenRoot) await rm(brokenRoot, { recursive: true, force: true });
});

describe("web-one-malformed-db-file-500s-every-page-and-leaks-filesyst", () => {
  describe("a corrupt ticket file no longer breaks the listing views", () => {
    // /api/tickets and /api/tree render every ticket regardless of state, so
    // the two good tickets (freshly created, neither in "review" nor stale)
    // are asserted present there. /api/review and /api/stale are
    // STATE-filtered — none of this fixture's tickets are in "review" state
    // or old enough to be stale, so both legitimately return an empty list;
    // the real assertion for them is simply "200, not 500" (proven
    // separately below), not that they list tickets which were never going
    // to be in an empty-by-construction filtered view in the first place.
    it("/api/tickets still 200s and lists the good tickets, excluding only the corrupt one", async () => {
      const res = await get("/api/tickets");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tickets: Array<{ name: string }> };
      const names = body.tickets.map((t) => t.name);
      expect(names).toContain(goodTicket.name);
      expect(names).toContain(sessionTicket.name);
      // The corrupt ticket itself is simply absent, not rendered garbled.
      expect(names).not.toContain(badTicket.name);
    });

    it("/api/tree still 200s and lists the good tickets, excluding only the corrupt one", async () => {
      const res = await get("/api/tree");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { roots: Array<{ ticket: { name: string } }> };
      const names = body.roots.map((r) => r.ticket.name);
      expect(names).toContain(goodTicket.name);
      expect(names).toContain(sessionTicket.name);
      expect(names).not.toContain(badTicket.name);
    });

    it.each(["/api/review", "/api/stale"] as const)("%s still 200s (never a 500)", async (path) => {
      const res = await get(path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        tickets?: Array<{ name: string }>;
        rows?: Array<{ ticket: { name: string } }>;
      };
      const names = (body.tickets ?? body.rows?.map((r) => r.ticket) ?? []).map((t) => t.name);
      // Never the corrupt ticket, whatever the view's own state filter did.
      expect(names).not.toContain(badTicket.name);
    });
  });

  describe("an unrelated ticket's own detail page is unaffected", () => {
    it("200s and renders the real, unrelated, well-formed ticket", async () => {
      const res = await get(`/api/tickets/${goodTicket.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ticket: { name: string } };
      expect(body.ticket.name).toBe(goodTicket.name);
    });
  });

  describe("the corrupted ticket's own detail page degrades to 404, not 500", () => {
    it("404s rather than crashing (it's excluded from the tolerant listing findTicketByRef scans)", async () => {
      const res = await get(`/api/tickets/${badTicket.id}`);
      expect(res.status).toBe(404);
    });
  });

  describe("a corrupt session file no longer breaks the ticket's own detail page", () => {
    it("200s — the tolerant sessions listing skips the corrupt session", async () => {
      const res = await get(`/api/tickets/${sessionTicket.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ id: string }> };
      expect(body.sessions.map((s) => s.id)).not.toContain(corruptedSessionId);
    });
  });

  describe("a genuinely unexpected 500 (db/events replaced by a plain file) leaks nothing", () => {
    it("still 500s — this fix does not paper over real errors", async () => {
      const res = await getBroken("/api/tickets");
      expect(res.status).toBe(500);
    });

    it("the 500 body contains no server filesystem path", async () => {
      const res = await getBroken("/api/tickets");
      const body = await res.text();
      expect(body).not.toContain(brokenRoot);
      expect(body).not.toContain(".slop");
      expect(body).not.toContain("fixture-data-source");
    });

    it("the 500 body is NOT Bun's verbose dev error page (no stack trace/source excerpt)", async () => {
      const res = await getBroken("/api/tickets");
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
    it("POST /api/tickets returns 405, never a mutation", async () => {
      const res = await get("/api/tickets", { method: "POST" });
      expect(res.status).toBe(405);
    });

    it("POST to a ticket detail API route returns 405", async () => {
      const res = await get(`/api/tickets/${goodTicket.id}`, { method: "POST" });
      expect(res.status).toBe(405);
    });
  });
});

// ---------------------------------------------------------------------------
// SLOP_WEB_DEBUG: the explicit, opt-in escape hatch back to Bun's verbose
// dev error page — a SEPARATE server instance, spawned with the flag set,
// against the exact same broken-events fixture above. Proves the gate
// really is a live switch (not a no-op) rather than just proving the
// off-by-default case.
// ---------------------------------------------------------------------------

describe("SLOP_WEB_DEBUG opts back into the verbose dev error page", () => {
  let debugServer: RunningServer | undefined;

  beforeAll(async () => {
    debugServer = await spawnAndWaitForUrl("bun", [cliEntry, "web", "--port", "0"], brokenRoot, {
      ...process.env,
      SLOP_WEB_DEBUG: "1",
    });
  }, 15_000);

  afterAll(async () => {
    await stopServer(debugServer);
  });

  it("the same forced 500 now DOES render Bun's verbose dev error page", async () => {
    if (!debugServer) throw new Error("debug server not started");
    const res = await fetch(new URL("/api/tickets", debugServer.baseUrl));
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
