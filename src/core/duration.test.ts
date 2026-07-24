import { describe, expect, it } from "vitest";
import { durationStringSchema, isRepresentableDurationMs, parseDurationMs } from "./duration.js";

describe("parseDurationMs", () => {
  it("parses the two config.yaml defaults exactly (design.md §3)", () => {
    expect(parseDurationMs("60m")).toBe(60 * 60_000);
    expect(parseDurationMs("24h")).toBe(24 * 3_600_000);
  });

  it.each([
    ["500ms", 500],
    ["1s", 1_000],
    ["90s", 90_000],
    ["1m", 60_000],
    ["1h", 3_600_000],
    ["1d", 86_400_000],
    ["0m", 0],
  ] as const)("parses %s -> %ims", (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseDurationMs("  60m  ")).toBe(60 * 60_000);
  });

  it.each(["", "60", "m", "60mm", "-5m", "5.5m", "60 m", "60min", "1w"])(
    "throws on malformed input %j",
    (input) => {
      expect(() => parseDurationMs(input)).toThrow();
    },
  );
});

describe("durationStringSchema", () => {
  it("accepts every unit", () => {
    for (const s of ["1ms", "1s", "1m", "1h", "1d"]) {
      expect(durationStringSchema.safeParse(s).success).toBe(true);
    }
  });

  it("rejects malformed durations", () => {
    for (const s of ["", "60", "m", "60mm", "-5m", "1w"]) {
      expect(durationStringSchema.safeParse(s).success).toBe(false);
    }
  });

  it("agrees with parseDurationMs about validity", () => {
    for (const s of ["60m", "24h", "bogus", "5x"]) {
      const schemaOk = durationStringSchema.safeParse(s).success;
      let parseOk = true;
      try {
        parseDurationMs(s);
      } catch {
        parseOk = false;
      }
      expect(schemaOk).toBe(parseOk);
    }
  });
});

describe("isRepresentableDurationMs", () => {
  it("accepts every ordinary duration, incl. the config.yaml defaults", () => {
    expect(isRepresentableDurationMs(parseDurationMs("60m"))).toBe(true);
    expect(isRepresentableDurationMs(parseDurationMs("24h"))).toBe(true);
    expect(isRepresentableDurationMs(0)).toBe(true);
  });

  it("rejects a duration string schema-valid but too huge for a Date to represent (regression: ticket duration-huge-stale-after-overflows)", () => {
    // "99999999999d" passes durationStringSchema (no magnitude cap) but is
    // ~1000x ECMA-262's ±100,000,000-day Date range.
    expect(isRepresentableDurationMs(parseDurationMs("99999999999d"))).toBe(false);
  });

  it("rejects non-finite input defensively", () => {
    expect(isRepresentableDurationMs(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isRepresentableDurationMs(Number.NaN)).toBe(false);
  });

  it("rejects magnitude symmetrically (negative overflow too)", () => {
    expect(isRepresentableDurationMs(-8_640_000_000_000_000)).toBe(false);
    expect(isRepresentableDurationMs(-1)).toBe(true);
  });
});
