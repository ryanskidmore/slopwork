#!/usr/bin/env node
/**
 * Node-runnable launcher for the `slop` CLI.
 *
 * v0 genuinely requires Bun at runtime (Bun.serve / Bun.file / Bun.YAML /
 * text-imports throughout src/) — this file does NOT reimplement or
 * type-strip anything. Its only job is to be the thing plain Node can
 * execute after `npm i -g slopwork` / `npx slopwork` (Node can't run the
 * real entrypoint's shebang or strip its TypeScript under node_modules), so
 * that:
 *   - when Bun is on PATH, it re-execs the real CLI
 *     (`<pkgRoot>/src/cli/index.ts`) under Bun, forwarding argv/stdio/exit
 *     code faithfully — the user never notices the indirection.
 *   - when Bun is NOT on PATH, it fails loudly with one clear line on
 *     stderr instead of the cryptic `env: bun: No such file or directory`
 *     / `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` a raw shebang or
 *     bare `node src/cli/index.ts` produces.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const entry = join(pkgRoot, "src", "cli", "index.ts");

const NO_BUN_MESSAGE = "Slopwork requires Bun >= 1.3 — install from https://bun.sh\n";

function bunIsAvailable() {
  const check = spawnSync("bun", ["--version"], { stdio: "ignore" });
  return !check.error && check.status === 0;
}

function main() {
  if (!bunIsAvailable()) {
    process.stderr.write(NO_BUN_MESSAGE);
    process.exit(1);
  }

  const result = spawnSync("bun", [entry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });

  if (result.error) {
    // bun disappeared between the version check and now (race, PATH
    // mutation mid-run, ...) — still a "no usable bun" outcome from the
    // caller's point of view, not a silent crash.
    process.stderr.write(NO_BUN_MESSAGE);
    process.exit(1);
  }

  if (result.signal) {
    // Child died from a signal rather than exiting normally; there is no
    // faithful exit code to forward, so fail rather than report success.
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

main();
