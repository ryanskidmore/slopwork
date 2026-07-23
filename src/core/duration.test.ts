import { describe, expect, it } from "vitest";
import { durationStringSchema, parseDurationMs } from "./duration.js";

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
