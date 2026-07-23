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
