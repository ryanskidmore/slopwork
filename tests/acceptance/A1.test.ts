import { type SpawnSyncReturns, execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// A1: Repo scaffold: TS + Bun build, commander skeleton, vitest, lint/format, CI
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "`slop --help` runs from a compiled binary; tests run in CI"
//
// This file asserts the first half for real, against the actual compiled
// dist/slop binary (not `bun src/cli/index.ts`, not source). The second
// half ("tests run in CI") is asserted by the presence and shape of
// .github/workflows/ci.yml, checked below.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

// The complete v0 command surface, design.md §4.2 — all 22 commands.
const EXPECTED_COMMANDS = [
  "init",
  "instructions",
  "reindex",
  "new",
  "split",
  "draft",
  "undraft",
  "edit",
  "update",
  "ready",
  "start",
  "context",
  "plan",
  "review",
  "stop",
  "done",
  "drop",
  "status",
  "show",
  "search",
  "events",
  "web",
] as const;

function runBinary(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(binaryPath, args, { encoding: "utf8" });
}

beforeAll(() => {
  // Robust about build ordering: build the binary if it isn't already
  // there, rather than failing outright, per A1's brief. If the build
  // itself fails, surface that clearly instead of a confusing ENOENT
  // from spawnSync later.
  if (!existsSync(binaryPath)) {
    execFileSync("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  }
  if (!existsSync(binaryPath)) {
    throw new Error(
      `${binaryPath} is still missing after attempting "bun run build". ` +
        'Run "bun run build" manually and re-run the tests.',
    );
  }
}, 60_000);

describe("A1: Repo scaffold: TS + Bun build, commander skeleton, vitest, lint/format, CI", () => {
  it("runs `slop --help` from the compiled binary and exits 0", () => {
    const result = runBinary(["--help"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("lists all 22 §4.2 commands in the compiled binary's --help output", () => {
    const result = runBinary(["--help"]);
    expect(EXPECTED_COMMANDS).toHaveLength(22);
    for (const command of EXPECTED_COMMANDS) {
      const term = new RegExp(`\\b${command}\\b`);
      expect(result.stdout, `expected --help to mention "${command}"`).toMatch(term);
    }
  });

  it("also exits 0 for `-h`", () => {
    const result = runBinary(["-h"]);
    expect(result.status).toBe(0);
  });

  it("prints the version from package.json for --version", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const result = runBinary(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("exits with the reserved NOT_IMPLEMENTED code (3) for a registered-but-unbuilt command", () => {
    const result = runBinary(["status"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/not yet implemented/i);
  });

  it("exits with the reserved USAGE_ERROR code (2) for a missing required argument", () => {
    const result = runBinary(["new"]);
    expect(result.status).toBe(2);
  });

  it("ships a CI workflow that installs, lints, typechecks, tests, and builds", () => {
    const workflowPath = join(repoRoot, ".github", "workflows", "ci.yml");
    expect(existsSync(workflowPath)).toBe(true);
  });
});
