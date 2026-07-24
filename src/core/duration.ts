/**
 * Duration strings, as used by `config.yaml`'s `defaults.stale_after` /
 * `defaults.review_stale_after` (design.md §3: `stale_after: 60m`,
 * `review_stale_after: 24h`). D1/C5 both need to turn these into
 * milliseconds to compare against activity timestamps.
 */
import { z } from "zod";

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export const durationStringSchema = z
  .string()
  .regex(DURATION_PATTERN, 'expected a duration like "60m", "24h", or "500ms"');
export type DurationString = z.infer<typeof durationStringSchema>;

/** Parse a duration string (e.g. `"60m"`, `"24h"`) into milliseconds. Throws on malformed input. */
export function parseDurationMs(input: string): number {
  const match = DURATION_PATTERN.exec(input.trim());
  const amountStr = match?.[1];
  const unit = match?.[2];
  if (amountStr === undefined || unit === undefined) {
    throw new Error(`invalid duration: "${input}" (expected e.g. "60m", "24h", "500ms")`);
  }
  const unitMs = UNIT_MS[unit];
  if (unitMs === undefined) {
    throw new Error(`invalid duration unit: "${unit}"`);
  }
  return Number(amountStr) * unitMs;
}

/**
 * ECMA-262 §21.4.1.1: a `Date` can only represent times within
 * ±100,000,000 days of the epoch — ±8.64e15 ms. `durationStringSchema`'s
 * pattern has no magnitude bound (`\d+` accepts any number of digits), so
 * `parseDurationMs` can hand back an `ms` value nowhere near representable
 * — e.g. `"99999999999d"` parses fine but is ~1000x this bound. Adding
 * such a value to any real timestamp produces an Invalid Date, and
 * `Date#toISOString` throws `RangeError: Invalid time value` on one.
 *
 * `stale_after`/`review_stale_after` are exactly this shape of user input
 * (config.yaml, no schema-level magnitude cap), and a huge value is a
 * plausible thing for someone to write specifically *meaning* "never" /
 * "disable staleness". Callers that turn a parsed duration into a
 * deadline (`tickets/staleness.ts`'s `addMs`) use this guard to treat an
 * unrepresentable magnitude as exactly that — no deadline — instead of
 * crashing.
 */
export function isRepresentableDurationMs(ms: number): boolean {
  return Number.isFinite(ms) && Math.abs(ms) < 8_640_000_000_000_000;
}
