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
import { registerCommands } from "./commands/index.js";
import { reportError } from "./errors.js";

function buildProgram(): Command {
  const program = new Command();

  program
    .name("slop")
    .description(
      "Slopworks: a free OSS work tracker built for agents. Engineers break work " +
        "into a dependency graph; agents pick up tickets, plan, work, and leave an " +
        "auditable trail ending in an MR and a transcript.",
    )
    .version(pkg.version, "-V, --version", "print the slopworks version and exit")
    .addHelpCommand(false)
    .showHelpAfterError(true)
    .exitOverride();

  registerCommands(program);

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();

  try {
    await program.parseAsync(process.argv);
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
