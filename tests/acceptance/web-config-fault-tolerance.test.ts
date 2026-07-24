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
// server (from source, same convention as tests/acceptance/D5.test.ts /
// src/web/views/ticket-detail.test.ts's "real spawned server" block — Bun
// globals like `Bun.serve`/`Bun.YAML` aren't available inside vitest test
// workers) against a real `slop init`-produced repo whose config.yaml has
// been deleted or corrupted after the fact, and asserts every degraded page
// still 200s with the fallback defaults and a visible warning banner,
// instead of 500ing.

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

describe("web: corrupt or missing config.yaml degrades instead of 500ing", () => {
  it("missing config.yaml: every §4.4 view still 200s, uses defaults, and shows a warning banner", async () => {
    const root = await initRepo();
    await unlink(join(root, ".slop", "config.yaml"));

    server = await startWebServer(root);
    for (const path of ["/tickets", "/tree", "/review", "/stale"]) {
      const res = await fetch(new URL(path, server.baseUrl));
      expect(res.status, `${path} should not 500`).toBe(200);
      const body = await res.text();
      expect(body).toContain("banner-warning");
      expect(body).toMatch(/config\.yaml/);
    }
  });

  it("corrupt (invalid YAML) config.yaml: still 200s with a warning banner", async () => {
    const root = await initRepo();
    await writeFile(
      join(root, ".slop", "config.yaml"),
      "project: [unterminated\n  - broken: yaml\n",
      "utf8",
    );

    server = await startWebServer(root);
    const res = await fetch(new URL("/tickets", server.baseUrl));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("banner-warning");
  });

  it("schema-invalid config.yaml (project missing): still 200s with a warning banner", async () => {
    const root = await initRepo();
    await writeFile(join(root, ".slop", "config.yaml"), 'remotes:\n  jira: ""\n', "utf8");

    server = await startWebServer(root);
    const res = await fetch(new URL("/tickets", server.baseUrl));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("banner-warning");
  });

  it("valid config.yaml: no warning banner appears", async () => {
    const root = await initRepo();

    server = await startWebServer(root);
    const res = await fetch(new URL("/tickets", server.baseUrl));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("banner-warning");
  });
});
