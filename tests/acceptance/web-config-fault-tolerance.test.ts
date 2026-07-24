import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempRepo } from "../support/temp-repo.js";

// web-corrupt-or-missing-config: `FixtureDataSource.getConfig()`
// (src/web/fixture-data-source.ts) used to throw on ENOENT, invalid YAML,
// or a schema-invalid config.yaml — every §4.4 view calls `getConfig()`, so
// one bad merge/hand-edit of config.yaml took the ENTIRE web UI down with
// an opaque 500 on every single page. This file spawns the real `slop web`
// server (from source, same convention as tests/acceptance/D5.test.ts — Bun
// globals like `Bun.serve`/`Bun.YAML` aren't available inside vitest test
// workers) against a real `slop init`-produced repo whose config.yaml has
// been deleted or corrupted after the fact, and asserts every degraded
// `/api/*` route still 200s with the fallback defaults and a non-null
// `config.warning`, instead of 500ing. (rewrite-slop-web-as-a: the warning
// used to render as an HTML banner; it's now a `warning` field on every
// JSON response's embedded `config` object — the SPA's AppShell renders it
// as the same visible banner, see src/web/frontend/components/app-shell.tsx —
// but this black-box HTTP suite asserts the API contract, not the DOM.)

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

function runSlop(args: string[], cwd: string) {
  return spawnSync("bun", [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, SLOP_ACTOR: "web-config-fault-tolerance-test" },
  });
}

interface RunningServer {
  proc: ChildProcess;
  baseUrl: string;
}

function startWebServer(cwd: string, timeoutMs = 15_000): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [cliEntry, "web", "--port", "0"], {
      cwd,
      env: { ...process.env, SLOP_ACTOR: "web-config-fault-tolerance-test" },
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

let server: RunningServer | undefined;

afterEach(async () => {
  await stopServer(server);
  server = undefined;
});

async function initRepo(): Promise<string> {
  const root = await makeTempRepo("slop-web-config-fault-");
  const init = runSlop(
    ["init", "--yes", "--project", "fault-tolerance-fixture", "--user", "ryan"],
    root,
  );
  expect(init.status, init.stderr).toBe(0);
  return root;
}

interface ConfigBearing {
  config: { warning: string | null };
}

/** `/api/config` returns the config projection flat (no wrapping `config` key); every other route nests it — see src/web/api/*.ts. */
function extractWarning(
  path: string,
  body: ConfigBearing | { warning: string | null },
): string | null {
  return path === "/api/config"
    ? (body as { warning: string | null }).warning
    : (body as ConfigBearing).config.warning;
}

describe("web: corrupt or missing config.yaml degrades instead of 500ing", () => {
  it("missing config.yaml: every §4.4 API route still 200s, uses defaults, and reports a warning", async () => {
    const root = await initRepo();
    await unlink(join(root, ".slop", "config.yaml"));

    server = await startWebServer(root);
    for (const path of ["/api/tickets", "/api/tree", "/api/review", "/api/stale", "/api/config"]) {
      const res = await fetch(new URL(path, server.baseUrl));
      expect(res.status, `${path} should not 500`).toBe(200);
      const body = (await res.json()) as ConfigBearing | { warning: string | null };
      const warning = extractWarning(path, body);
      expect(warning, `${path}'s config warning should be set`).not.toBeNull();
      expect(warning).toMatch(/config\.yaml/);
    }
    // The SPA shell itself must also still 200 (it doesn't know about config at all — the AppShell fetches /api/config client-side).
    const shell = await fetch(new URL("/tickets", server.baseUrl));
    expect(shell.status).toBe(200);
  });

  it("corrupt (invalid YAML) config.yaml: still 200s with a warning", async () => {
    const root = await initRepo();
    await writeFile(
      join(root, ".slop", "config.yaml"),
      "project: [unterminated\n  - broken: yaml\n",
      "utf8",
    );

    server = await startWebServer(root);
    const res = await fetch(new URL("/api/tickets", server.baseUrl));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigBearing;
    expect(body.config.warning).not.toBeNull();
  });

  it("schema-invalid config.yaml (project missing): still 200s with a warning", async () => {
    const root = await initRepo();
    await writeFile(join(root, ".slop", "config.yaml"), 'remotes:\n  jira: ""\n', "utf8");

    server = await startWebServer(root);
    const res = await fetch(new URL("/api/tickets", server.baseUrl));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigBearing;
    expect(body.config.warning).not.toBeNull();
  });

  it("valid config.yaml: no warning", async () => {
    const root = await initRepo();

    server = await startWebServer(root);
    const res = await fetch(new URL("/api/tickets", server.baseUrl));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigBearing;
    expect(body.config.warning).toBeNull();
  });
});
