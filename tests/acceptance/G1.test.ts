import { type ChildProcess, type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseJsonc, sessionSchema } from "../../src/core/index.js";

// G1: transcripts were removed from the product entirely — capture
// machinery, the session `transcript_ref` field, the `--transcript` flags
// on review/stop/done/drop, the `transcripts:` config key + its init
// scaffolding, and the web viewer/API route. This suite pins the removal
// AND the two deliberate backwards-tolerances that survive it:
//
//  1. a session file written before the removal may still carry a
//     `transcript_ref` key — it must still load (unknown key ignored);
//  2. a config.yaml written before the removal may still carry a
//     `transcripts:` key — it must warn on stderr but keep working.
//
// Spawned from SOURCE (`bun <cliEntry> ...`) throughout, same convention
// as web.test.ts — no dist/slop dependency.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

/** Same harness-env stripping as every other spawn-based suite, so
 * detection/actor resolution are deterministic regardless of what's
 * running this suite. */
const STRIPPED_HARNESS_ENV: NodeJS.ProcessEnv = {
  CLAUDECODE: undefined,
  CLAUDE_CODE_CHILD_SESSION: undefined,
  CLAUDE_CODE_SESSION_ID: undefined,
  OPENCODE: undefined,
  OPENCODE_PID: undefined,
  CODEX_SANDBOX: undefined,
  CODEX_SANDBOX_NETWORK_DISABLED: undefined,
  CODEX_HOME: undefined,
};

function runSlop(args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync("bun", [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...STRIPPED_HARNESS_ENV, SLOP_ACTOR: "g1-test-actor" },
  });
}

interface NewTicketJson {
  id: string;
  slug: string;
}

function newTicket(root: string, name: string): NewTicketJson {
  const result = runSlop(["new", name, "--json"], root);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as NewTicketJson;
}

// ---------------------------------------------------------------------------
// Web-server spawn/teardown — same file-local helper shape as
// web.test.ts / web-real-repo.test.ts.
// ---------------------------------------------------------------------------

interface RunningServer {
  proc: ChildProcess;
  baseUrl: string;
}

function spawnAndWaitForUrl(
  args: string[],
  cwd: string,
  timeoutMs = 15_000,
): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [cliEntry, ...args], { cwd, env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(
        new Error(
          `timed out waiting for "slop ${args.join(" ")}" to print a listen URL.\nstdout: ${stdout}\nstderr: ${stderr}`,
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
// Fixture: one real-CLI repo with one started ticket, shared by every test
// that needs a repo at all (the flag-removal tests never get past argv
// parsing, so a shared repo can't leak state between them).
// ---------------------------------------------------------------------------

let root: string;
let ticket: NewTicketJson;
let sessionId: string;
let server: RunningServer | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "slop-g1-transcripts-removed-"));
  const init = runSlop(["init", "--yes", "--project", "g1-fixture", "--user", "g1"], root);
  expect(init.status, init.stderr).toBe(0);

  ticket = newTicket(root, "G1 fixture ticket");
  const started = runSlop(["start", ticket.slug, "--json"], root);
  expect(started.status, started.stderr).toBe(0);
  sessionId = (JSON.parse(started.stdout) as { session: { id: string } }).session.id;

  server = await spawnAndWaitForUrl(["web", "--port", "0"], root);
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  if (root) await rm(root, { recursive: true, force: true });
});

describe("G1: transcripts removed", () => {
  describe("the --transcript flag no longer exists on any session-ending command", () => {
    it.each([
      ["review", ["review"]],
      ["stop", ["stop"]],
      ["done", ["done"]],
      ["drop", ["drop", "--reason", "why"]],
    ] as const)("`slop %s --transcript <path>` exits 2 (unknown option)", (_name, base) => {
      const result = runSlop([...base, "some-ref", "--transcript", "/tmp/nope.jsonl"], root);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/unknown option/i);
      expect(result.stderr).toContain("--transcript");
    });

    it.each([["review"], ["stop"], ["done"], ["drop"]] as const)(
      "`slop %s --help` no longer documents --transcript",
      (name) => {
        const result = runSlop([name, "--help"], root);
        expect(result.stdout + result.stderr).not.toContain("--transcript");
      },
    );
  });

  describe("legacy on-disk data still loads", () => {
    it("a session file carrying a legacy transcript_ref key still parses (unknown key ignored)", () => {
      const sessionPath = join(root, ".slop", "db", "sessions", `${sessionId}.jsonc`);
      const raw = JSON.parse(readFileSync(sessionPath, "utf8")) as Record<string, unknown>;
      raw.transcript_ref = `transcripts/${sessionId}.jsonl`;
      writeFileSync(sessionPath, `${JSON.stringify(raw, null, 2)}\n`);

      // Direct schema check: parses, and the legacy key is stripped rather
      // than kept or rejected.
      const { value } = parseJsonc<unknown>(readFileSync(sessionPath, "utf8"));
      const parsed = sessionSchema.safeParse(value);
      expect(parsed.success).toBe(true);
      expect(parsed.success && "transcript_ref" in parsed.data).toBe(false);

      // End to end: a real command that reads AND rewrites this exact
      // session file (stop finalizes it) still succeeds.
      const stopped = runSlop(["stop", ticket.slug, "--note", "legacy file loads fine"], root);
      expect(stopped.status, stopped.stderr).toBe(0);
      expect(stopped.stdout).toContain("stopped");
    });

    it("a config.yaml carrying a legacy transcripts: key warns on stderr but the command still works", () => {
      const configPath = join(root, ".slop", "config.yaml");
      const original = readFileSync(configPath, "utf8");
      try {
        writeFileSync(
          configPath,
          `${original}transcripts: local            # local | commit | off\n`,
        );
        const result = runSlop(["new", "Ticket created under a legacy config", "--json"], root);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toHaveProperty("id");
        expect(result.stderr).toMatch(/legacy `transcripts:` key/);
        expect(result.stderr).toMatch(/ignored/);
      } finally {
        writeFileSync(configPath, original);
      }
    });
  });

  describe("init no longer scaffolds transcripts", () => {
    it("writes no .slop/transcripts/ directory and no transcripts gitignore rule or config key", async () => {
      const slopEntries = await readdir(join(root, ".slop"));
      expect(slopEntries).not.toContain("transcripts");
      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      expect(gitignore).not.toContain("transcripts");
      const config = readFileSync(join(root, ".slop", "config.yaml"), "utf8");
      expect(config).not.toContain("transcripts");
    });
  });

  describe("the web transcript route is gone", () => {
    async function get(path: string): Promise<Response> {
      if (!server) throw new Error("server not started");
      return fetch(new URL(path, server.baseUrl));
    }

    it("GET /api/tickets/:ref/sessions/:sessionId/transcript returns 404", async () => {
      const res = await get(`/api/tickets/${ticket.id}/sessions/${sessionId}/transcript`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Not Found");
    });

    it("the ticket detail API still 200s and its session DTO carries no transcript field", async () => {
      const res = await get(`/api/tickets/${ticket.id}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("transcript");
    });
  });
});
