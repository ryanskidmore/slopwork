import { z } from "zod";
import type { Clock } from "./clock.js";

/**
 * ISO-8601 UTC timestamp string (design.md §8.1 item 5: "Timestamps:
 * ISO-8601 UTC everywhere"). zod v4's `z.iso.datetime({ offset: false,
 * local: false })` requires the trailing `Z` and rejects both
 * timezone-offset (`+01:00`) and timezone-less "local" timestamps — i.e.
 * exactly "UTC, and say so explicitly", which is the design decision.
 * Fractional seconds are accepted at any precision (or none): both
 * `Date#toISOString()` (always millisecond precision) and a hand-typed
 * second-precision timestamp are legitimate inputs.
 */
export const isoTimestampSchema = z.iso.datetime({ offset: false, local: false });
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;

/** The current time as an {@link IsoTimestamp}, via an injected {@link Clock} — see clock.ts. */
export function nowIso(clock: Clock): IsoTimestamp {
  return clock.now().toISOString() as IsoTimestamp;
}
