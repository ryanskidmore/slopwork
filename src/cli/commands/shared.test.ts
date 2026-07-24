import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../core/index.js";
import { SlopError } from "../errors.js";
import { parseIntegerOption, parsePriority } from "./shared.js";

// cli-input-validation-reject-truncated-numerics-fix-actor-fai:
//
// `Number.parseInt` silently truncates leading-numeric garbage —
// `parseInt("2abc", 10)` is `2`, not NaN — so `parseIntegerOption` used to
// accept `--priority 2abc` as `2` (persisting a DIFFERENT value than what
// was typed, a data-integrity gap) and `--priority 1.9` as `1`, instead of
// rejecting either. These tests prove the fix: only a value whose full
// trimmed text is a plain integer is accepted; anything else is a
// SlopError carrying EXIT_CODES.USAGE_ERROR (exit 2), the documented
// "invalid args/flags" contract.

describe("parseIntegerOption", () => {
  const parseLimit = parseIntegerOption("--limit");

  it("accepts a plain integer", () => {
    expect(parseLimit("3")).toBe(3);
  });

  it("accepts a negative integer", () => {
    expect(parseLimit("-5")).toBe(-5);
  });

  it("accepts an integer with surrounding whitespace", () => {
    expect(parseLimit(" 7 ")).toBe(7);
  });

  it("rejects trailing garbage instead of truncating it (--limit 3xyz)", () => {
    expect(() => parseLimit("3xyz")).toThrow(SlopError);
    try {
      parseLimit("3xyz");
      throw new Error("expected parseLimit to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SlopError);
      expect((err as SlopError).exitCode).toBe(EXIT_CODES.USAGE_ERROR);
      expect((err as SlopError).message).toContain("--limit");
      expect((err as SlopError).message).toContain("3xyz");
    }
  });

  it("rejects a decimal instead of truncating it (1.9 -> would have been 1)", () => {
    expect(() => parseLimit("1.9")).toThrow(SlopError);
  });

  it("rejects a value that is entirely non-numeric", () => {
    expect(() => parseLimit("notanumber")).toThrow(SlopError);
  });

  it("rejects an empty string", () => {
    expect(() => parseLimit("")).toThrow(SlopError);
  });

  it("every rejection carries USAGE_ERROR (exit 2), never the GENERIC_ERROR default", () => {
    for (const bad of ["3xyz", "1.9", "abc", ""]) {
      try {
        parseLimit(bad);
        throw new Error(`expected parseLimit(${JSON.stringify(bad)}) to throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(SlopError);
        expect((err as SlopError).exitCode).toBe(EXIT_CODES.USAGE_ERROR);
      }
    }
  });
});

describe('parsePriority (parseIntegerOption("--priority"))', () => {
  it("persists exactly what was typed for a valid integer", () => {
    expect(parsePriority("2")).toBe(2);
  });

  it("rejects '2abc' rather than silently persisting priority 2", () => {
    expect(() => parsePriority("2abc")).toThrow(SlopError);
  });

  it("rejects '1.9' rather than silently truncating to priority 1", () => {
    expect(() => parsePriority("1.9")).toThrow(SlopError);
  });
});
