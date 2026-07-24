#!/usr/bin/env bun
/**
 * `slop` CLI entrypoint.
 *
 * This file is both:
 *  - the `bin` target run from source (`bun src/cli/index.ts ...` / the
 *    npm-installed `slop` shebang script), and
 *  - the module `bun build --compile` turns into the standalone
 *    `dist/slop` binary (see package.json's `build` script).
 *
 * Command registration lives in ./commands/ (one module per command);
 * this file only wires up the root program, version/help behaviour, and
 * the top-level exit-code mapping described in src/core/exit-codes.ts.
 */
import { Command, CommanderError } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { EXIT_CODES } from "../core/exit-codes.js";
import { rewriteLabelArgv } from "./argv.js";
import { registerCommands } from "./commands/index.js";
import { reportError } from "./errors.js";

function buildProgram(): Command {
  const program = new Command();

  program
    .name("slop")
    .description(
      "Slopwork: a free OSS work tracker built for agents. Engineers break work " +
        "into a dependency graph; agents pick up tickets, plan, work, and leave an " +
        "auditable trail ending in an MR and a transcript.",
    )
    .version(pkg.version, "-V, --version", "print the slopwork version and exit")
    .addHelpCommand(false)
    .showHelpAfterError(true)
    .exitOverride();

  registerCommands(program);

  return program;
}

/**
 * Treat a downstream reader closing early (`slop ready | head -1`, `slop
 * show <ref> | less` then quitting, ...) as a normal "reader went away"
 * signal, not a crash. Without this, a write to a closed stdout/stderr
 * pipe surfaces as EPIPE and — verified empirically against the compiled
 * `dist/slop` binary — Bun's fast stdout/stderr write path (`writeFast`)
 * raises it as an unhandled rejection that dumps a raw stack trace plus a
 * "Bun vX.Y.Z" banner and exits 1, bypassing the try/catch in {@link main}
 * entirely (it's not a normal thrown error the command's promise chain
 * propagates — Node/Bun's stream `error` event is the only place this is
 * observable). Installing an `error` listener on the stream is what
 * suppresses that: it turns the same event into a listener call instead of
 * an unhandled rejection, so it must be installed on both streams before
 * `parseAsync` runs any command's action, not added to the catch block
 * below.
 *
 * On EPIPE specifically, exit 0 (SUCCESS): the command's actual work had
 * already succeeded, and it's the reader (e.g. `head`) that chose to stop,
 * not `slop` that failed — this is the conventional treatment (e.g. npm's
 * own long-standing `stdout.on('error', ...)` guard). Any other stream
 * error code is a genuine I/O failure and is deliberately rethrown so it
 * still surfaces (as an unhandled exception) rather than being swallowed.
 *
 * This only ever fires on an EPIPE that actually happens; a `SlopError`
 * thrown for an unrelated reason still flows through `main`'s catch ->
 * {@link reportError} -> its own `process.exit` untouched, since no EPIPE
 * event occurs on that path.
 */
function installEpipeGuards(): void {
  const onStreamError = (err: NodeJS.ErrnoException): void => {
    if (err.code === "EPIPE") {
      process.exit(EXIT_CODES.SUCCESS);
    }
    throw err;
  };
  process.stdout.on("error", onStreamError);
  process.stderr.on("error", onStreamError);
}

async function main(): Promise<void> {
  installEpipeGuards();
  const program = buildProgram();

  try {
    // See argv.ts's module doc: fixes the `--label +x -y` form design.md
    // §4.2 documents, which Commander alone can't parse. Scoped to the
    // literal `--label` token only — every other command's argv is
    // returned byte-for-byte unchanged.
    await program.parseAsync(rewriteLabelArgv(process.argv));
  } catch (err) {
    if (err instanceof CommanderError) {
      // help / --version are success paths; every other Commander-raised
      // error (bad flags, missing args, unknown command, ...) is a usage
      // error per the exit-code table regardless of commander's own
      // internal exit code.
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
        process.exit(EXIT_CODES.SUCCESS);
      }
      process.exit(EXIT_CODES.USAGE_ERROR);
    }
    process.exit(reportError(err));
  }
}

await main();
