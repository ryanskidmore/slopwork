import { describe, expect, it } from "vitest";
import { SPEC_SCHEMA_VERSION, specSchema } from "./spec.js";

describe("specSchema (D10)", () => {
  it("accepts a minimal spec (only summary given) and fills in the rest", () => {
    const parsed = specSchema.parse({ summary: "Add auth provider" });
    expect(parsed).toEqual({
      summary: "Add auth provider",
      details_md: "",
      acceptance: [],
      context: [],
      meta: {},
      v: SPEC_SCHEMA_VERSION,
    });
  });

  it("accepts a fully populated spec", () => {
    const input = {
      summary: "Add auth provider",
      details_md: "# Details\n\nSome markdown.",
      acceptance: ["logs in", "logs out"],
      context: ["see RFC 123"],
      meta: { estimate_pts: 3, tags: ["backend"] },
      v: 1,
    };
    expect(specSchema.parse(input)).toEqual(input);
  });

  it("rejects an empty summary", () => {
    expect(specSchema.safeParse({ summary: "" }).success).toBe(false);
    expect(specSchema.safeParse({ summary: "   " }).success).toBe(false);
  });

  it("rejects a missing summary", () => {
    expect(specSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-positive spec-schema version", () => {
    expect(specSchema.safeParse({ summary: "x", v: 0 }).success).toBe(false);
  });

  it("meta accepts arbitrary open-ended JSON-shaped values", () => {
    const parsed = specSchema.parse({
      summary: "x",
      meta: { nested: { a: [1, 2, { b: true }] }, flag: false, note: null },
    });
    expect(parsed.meta).toEqual({ nested: { a: [1, 2, { b: true }] }, flag: false, note: null });
  });
});
