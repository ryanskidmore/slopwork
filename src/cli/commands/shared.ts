/**
 * Small helpers shared by the command registration modules in this
 * directory. Kept deliberately tiny — A1 only registers commands, it
 * does not implement them.
 */
import { EXIT_CODES } from "../../core/exit-codes.js";
import { SlopError } from "../errors.js";

/** Commander "collect" reducer for options that may be repeated, e.g.
 * `--blocks x --blocks y` → `["x", "y"]`. */
export function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

/**
 * Parse a CLI option value into an integer, raising a {@link SlopError}
 * carrying `USAGE_ERROR` (exit 2) that names the offending flag.
 *
 * **E1 exit-code audit fix:** this used to `throw new Error(...)` on a
 * commented (but false) assumption that Commander's own top-level error
 * handling would catch and re-shape it into a usage error. Verified
 * directly against the compiled binary that it does not — Commander's
 * `_callParseArg` only intercepts errors carrying its own
 * `commander.invalidArgument` code (see `node_modules/commander/lib/
 * command.js`), so a plain `Error` from a custom option parser propagates
 * all the way to `src/cli/index.ts`'s top-level catch, which is not a
 * `CommanderError` either, so it falls into `reportError`'s generic
 * `Error` branch — `GENERIC_ERROR` (1), not the documented `USAGE_ERROR`
 * (2) for "missing/invalid arguments or flags." E.g. `slop new x
 * --priority notanumber` exited 1 before this fix. Every option parser
 * built from this helper (`--priority`, `--limit`, `--check`/`--uncheck`,
 * `--port`, `ready`'s `--budget`, ...) is fixed by throwing a
 * {@link SlopError} instead, which `reportError` always honors regardless
 * of which layer catches it.
 */
export function parseIntegerOption(flag: string): (value: string) => number {
  return (value: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      throw new SlopError(`${flag} must be an integer, got "${value}"`, EXIT_CODES.USAGE_ERROR);
    }
    return parsed;
  };
}

/** Parse a `--priority` value into an integer, per design.md §8.1 (4):
 * 0 (urgent) – 3 (low), default 2. Validation of the range is a later
 * work item's concern (B1); this only turns CLI text into a number. */
export const parsePriority = parseIntegerOption("--priority");

/** Print a non-fatal `warning: <message>` line to stderr — e.g. B1's
 * malformed-`jira:`-ref format check (§8.2 item 5: "warn on format
 * mismatch, don't block"), which must never prevent the command from
 * succeeding. */
export function printWarning(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

/** Read all of stdin as UTF-8 text — `--spec -`'s "read from stdin" (B1,
 * `new`/`update`). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
