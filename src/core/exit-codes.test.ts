import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "./exit-codes.js";

// Establishes the "unit tests live beside the code as *.test.ts" convention
// (see README.md) with a trivial, real assertion — not a placeholder.
describe("EXIT_CODES", () => {
  it("has SUCCESS as 0 and every other code as a distinct positive integer", () => {
    expect(EXIT_CODES.SUCCESS).toBe(0);

    const nonSuccess = Object.entries(EXIT_CODES).filter(([name]) => name !== "SUCCESS");
    const values = nonSuccess.map(([, value]) => value);

    for (const value of values) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }

    expect(new Set(values).size).toBe(values.length);
  });

  it("reserves the exact codes design.md/A1 promised agents can branch on", () => {
    expect(EXIT_CODES).toEqual({
      SUCCESS: 0,
      GENERIC_ERROR: 1,
      USAGE_ERROR: 2,
      NOT_FOUND: 4,
      AMBIGUOUS_REF: 5,
      CONFLICT: 6,
    });
  });

  it("no longer defines NOT_IMPLEMENTED (G5, t-uy8vo: removed as reserved-unreachable surface)", () => {
    expect(EXIT_CODES).not.toHaveProperty("NOT_IMPLEMENTED");
  });
});
