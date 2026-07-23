/**
 * Small helpers shared by the command registration modules in this
 * directory. Kept deliberately tiny — A1 only registers commands, it
 * does not implement them.
 */

/** Commander "collect" reducer for options that may be repeated, e.g.
 * `--blocks x --blocks y` → `["x", "y"]`. */
export function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

/** Parse a CLI option value into an integer, raising a usage-shaped error
 * (caught and reported by the top-level Commander error handling, see
 * src/cli/index.ts) that names the offending flag. */
export function parseIntegerOption(flag: string): (value: string) => number {
  return (value: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`${flag} must be an integer, got "${value}"`);
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
