import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };

// Packaging: `npm i -g slopwork` / `npx slopwork` must produce a `slop`
// that plain Node can run.
//
// Acceptance criteria, from ticket_01KY93E2NTZ7WK156HEQRVKCN1:
//   - A user can install and run slop via the documented channel on
//     macOS/Linux without separately installing Bun, OR the distribution
//     is explicitly and truthfully scoped and npm metadata stops implying
//     Node compatibility.
//   - No dead-weight wrong-platform binary ships.
//
// v0 genuinely requires Bun at runtime (Bun.serve / Bun.file /
// text-imports), so the chosen fix is the second branch: `bin/slop.mjs` is
// a tiny Node-runnable launcher that delegates to `bun` when present and
// fails with one clear, actionable line on stderr when it isn't — instead
// of the cryptic `env: bun: No such file or directory` / TS-stripping
// error a raw `#!/usr/bin/env bun` shebang produces under plain Node.
//
// This file spawns `node bin/slop.mjs` directly (not `dist/slop`) and does
// NOT trigger `bun run build` — it exercises exactly the path a
// Node-only, no-Bun-preinstalled machine hits after `npm i -g`.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const launcherPath = join(repoRoot, "bin", "slop.mjs");

function runLauncher(args: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [launcherPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: env ?? process.env,
  });
}

describe("packaging: bin/slop.mjs (Node-runnable launcher)", () => {
  describe("bun present on PATH", () => {
    it("delegates to bun and prints the version, exit 0", () => {
      const result = runLauncher(["--version"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(pkg.version);
    });

    it("forwards argv and exit code faithfully for a failing invocation", () => {
      // An unknown command is a usage error (exit 2) from the real CLI
      // (src/cli/index.ts's CommanderError handling) — the launcher must
      // not swallow or remap that.
      const result = runLauncher(["totally-not-a-real-command"]);
      expect(result.status).toBe(2);
    });
  });

  describe("spawns bun exactly once per invocation (regression: ticket housekeeping-gitignore-lock-stale — no separate `bun --version` pre-check)", () => {
    it("a single command invocation results in exactly one `bun` process spawn", () => {
      // A fake `bun` on PATH ahead of the real one, which just logs its
      // own invocation (one line per call) and exits 0 immediately —
      // fast, and lets this test count spawns without depending on the
      // real Bun runtime actually executing anything.
      const fakeBinDir = mkdtempSync(join(tmpdir(), "slop-fake-bun-"));
      const logFile = join(fakeBinDir, "invocations.log");
      const fakeBunPath = join(fakeBinDir, "bun");
      writeFileSync(fakeBunPath, `#!/bin/sh\necho "$@" >> "${logFile}"\nexit 0\n`, {
        mode: 0o755,
      });
      chmodSync(fakeBunPath, 0o755);

      try {
        const realBunDir = dirname(process.execPath); // irrelevant here, just keeps PATH resolvable for node itself
        const result = runLauncher(["--version"], {
          ...process.env,
          PATH: `${fakeBinDir}:${realBunDir}`,
        });
        expect(result.status, result.stderr).toBe(0);

        const invocations = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
        // Exactly one spawn of `bun` — the real command, not a separate
        // `bun --version` probe beforehand.
        expect(invocations).toHaveLength(1);
        expect(invocations[0]).toContain("--version");
      } finally {
        rmSync(fakeBinDir, { recursive: true, force: true });
      }
    });
  });

  describe("bun absent from PATH", () => {
    it('prints a clear "requires Bun" message on stderr and exits non-zero, not a cryptic env error', () => {
      // Find node's own directory and restrict PATH to *only* that, so
      // `node` still resolves (spawnSync(process.execPath, ...) also
      // works fine since we pass an absolute interpreter path) but `bun`
      // does not — simulating a genuinely Bun-free machine without
      // depending on any absolute path to a specific "no-bun" directory.
      const nodeDir = dirname(process.execPath);
      const result = runLauncher(["--version"], {
        ...process.env,
        PATH: nodeDir,
      });

      expect(result.status).not.toBe(0);
      expect(result.status).toBeGreaterThan(0);
      expect(result.stderr).toContain("requires Bun");
      expect(result.stderr).toContain("https://bun.sh");
      // Guard against the fix regressing to the raw pre-fix failure modes:
      // the cryptic shebang/env error and Node's TS-stripping error must
      // NOT be what the user sees.
      expect(result.stderr).not.toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
      expect(result.stderr).not.toMatch(/env: bun: No such file/);
    });
  });
});

describe("packaging: package.json metadata", () => {
  it('"files" does not ship the single-platform dist/ binary', () => {
    expect(pkg.files).not.toContain("dist");
  });

  it('"files" includes "bin" and "src" (what the launcher + Bun runtime actually need)', () => {
    expect(pkg.files).toContain("bin");
    expect(pkg.files).toContain("src");
  });

  it('"bin.slop" points at the Node-runnable launcher, not the raw bun-shebang source', () => {
    expect(pkg.bin.slop).toBe("./bin/slop.mjs");
  });

  it('"engines" still requires bun (v0 genuinely needs it at runtime)', () => {
    expect(pkg.engines.bun).toBeTruthy();
  });
});
