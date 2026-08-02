import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_YAML_CONFORMANCE_CASES } from "../fixtures/config-yaml-conformance.js";
import { makeTempRepo } from "../support/temp-repo.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

function runSlop(args: string[], cwd: string) {
  return spawnSync("bun", [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, SLOP_ACTOR: "config-yaml-conformance-test" },
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
      env: { ...process.env, SLOP_ACTOR: "config-yaml-conformance-test" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error(`timed out waiting for slop web to listen\nstderr: ${stderr}`));
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
      reject(new Error(`slop web exited early (code ${code})\n${stderr}`));
    });
  });
}

async function stopServer(running: RunningServer | undefined): Promise<void> {
  if (!running || running.proc.exitCode !== null || running.proc.signalCode !== null) return;
  running.proc.kill();
  await Promise.race([
    once(running.proc, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

let server: RunningServer | undefined;

afterEach(async () => {
  await stopServer(server);
  server = undefined;
});

interface ConfigResponse {
  project: string;
  warning: string | null;
  remotes: { repo: string | null; jira: string | null };
  defaults: { stale_after: string; review_stale_after: string };
}

describe("config YAML semantics agree across CLI, storage, and web", () => {
  it.each(CONFIG_YAML_CONFORMANCE_CASES)("$name", async (testCase) => {
    const root = await makeTempRepo("slop-config-yaml-");
    const init = runSlop(["init", "--yes", "--project", "seed", "--user", "tester"], root);
    expect(init.status, init.stderr).toBe(0);
    await writeFile(join(root, ".slop", "config.yaml"), testCase.yaml, "utf8");

    // `instructions` is a strict config consumer: valid YAML+schema must
    // succeed, while invalid input must fail instead of being coerced.
    const instructions = runSlop(["instructions"], root);
    expect(instructions.status, instructions.stderr).toBe(testCase.valid ? 0 : 1);

    // `status` goes through openStorage's tolerant config read. Valid remote
    // selection reaches the deliberate stub; every flatfile/fallback case
    // reads the initialized local db successfully.
    const status = runSlop(["status", "--json"], root);
    if (testCase.backendKind === "remote") {
      expect(status.status).toBe(1);
      expect(status.stderr).toMatch(/remote backend not implemented/i);
    } else {
      expect(status.status, status.stderr).toBe(0);
    }

    // The live web process must parse the same bytes to the same values.
    server = await startWebServer(root);
    const response = await fetch(new URL("/api/config", server.baseUrl));
    expect(response.status).toBe(200);
    const config = (await response.json()) as ConfigResponse;
    if (testCase.valid) {
      expect(config.warning).toBeNull();
      expect(config.project).toBe(testCase.project);
      expect(config.remotes.jira).toBe(testCase.jira);
      expect(config.defaults.stale_after).toBe(testCase.staleAfter);
    } else {
      expect(config.warning).not.toBeNull();
      expect(config.project).toMatch(/^\(unknown/);
    }
  });
});
