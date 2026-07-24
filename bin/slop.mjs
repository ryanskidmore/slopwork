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
 *
 * housekeeping-gitignore-lock-stale: this used to run `bun --version` as a
 * separate pre-check before every real invocation, purely to decide which
 * of the two messages above to print — a full extra process spawn (and,
 * under `spawnSync`, a full extra blocking wait) paid on EVERY single
 * `slop` command, including the overwhelming common case where Bun is
 * right there on PATH and the check always passes. There's no need for a
 * separate probe: `spawnSync`'s own `result.error` already tells us
 * whether the real spawn below found `bun` at all (`ENOENT` = not on
 * PATH, mapped straight to the same friendly message) — one spawn instead
 * of two, on every run.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const entry = join(pkgRoot, "src", "cli", "index.ts");

const NO_BUN_MESSAGE = "Slopwork requires Bun >= 1.3 — install from https://bun.sh\n";

function main() {
  const result = spawnSync("bun", [entry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      // The one outcome this launcher exists to give a friendly message
      // for: no `bun` executable found on PATH at all.
      process.stderr.write(NO_BUN_MESSAGE);
      process.exit(1);
    }
    // Some other failure to even spawn bun (EACCES, ...) — rare, and not
    // the "no bun" case, but still not a silent crash: report it plainly.
    process.stderr.write(`slop: failed to run bun: ${result.error.message}\n`);
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
