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
