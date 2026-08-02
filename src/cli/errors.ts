/**
 * Shared error-reporting conventions for every `slop` command.
 *
 * Every command action should either:
 *   - succeed and let the process exit 0 naturally, or
 *   - throw a {@link SlopError} (or let one of the helpers below exit for
 *     it) so the failure carries one of the {@link EXIT_CODES}.
 *
 * `src/cli/index.ts` installs a single top-level catch that calls
 * {@link reportError} on anything thrown out of a command action, so
 * individual command modules can just `throw new SlopError(...)`.
 */
import { SlopError } from "../core/errors.js";
import { EXIT_CODES, type ExitCode } from "../core/exit-codes.js";

// Compatibility surface for existing command and third-party imports. The
// error itself belongs to core so repo/domain code never depends on the CLI.
export { SlopError } from "../core/errors.js";

/** Print `error: <message>` to stderr, formatted consistently. */
export function printError(message: string): void {
  process.stderr.write(`error: ${message}\n`);
}

/**
 * Report an error thrown from a command action and return the exit code
 * the process should terminate with. Does not itself call
 * `process.exit()` so it stays testable.
 */
export function reportError(err: unknown): ExitCode {
  if (err instanceof SlopError) {
    printError(err.message);
    return err.exitCode;
  }
  if (err instanceof Error) {
    printError(err.message);
    return EXIT_CODES.GENERIC_ERROR;
  }
  printError(String(err));
  return EXIT_CODES.GENERIC_ERROR;
}
