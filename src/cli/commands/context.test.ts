import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../core/index.js";
import { SlopError } from "../errors.js";
import { parseBudgetFlag } from "./context.js";

// cli-input-validation-reject-truncated-numerics-fix-actor-fai:
//
// `Number.parseInt` silently truncates leading-numeric garbage — this used
// to make `--budget 100abc` parse as `100` instead of being rejected.
// These tests prove `parseBudgetFlag` now requires the full trimmed value
// to be a plain non-negative integer, rejecting anything else with a
// SlopError carrying EXIT_CODES.USAGE_ERROR (exit 2).

describe("parseBudgetFlag", () => {
  it("accepts a plain non-negative integer", () => {
    expect(parseBudgetFlag("100")).toBe(100);
  });

  it("accepts zero", () => {
    expect(parseBudgetFlag("0")).toBe(0);
  });

  it("accepts an integer with surrounding whitespace", () => {
    expect(parseBudgetFlag(" 250 ")).toBe(250);
  });

  it("rejects trailing garbage instead of truncating it (--budget 100abc)", () => {
    expect(() => parseBudgetFlag("100abc")).toThrow(SlopError);
    try {
      parseBudgetFlag("100abc");
      throw new Error("expected parseBudgetFlag to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SlopError);
      expect((err as SlopError).exitCode).toBe(EXIT_CODES.USAGE_ERROR);
      expect((err as SlopError).message).toContain("--budget");
      expect((err as SlopError).message).toContain("100abc");
    }
  });

  it("rejects a decimal instead of truncating it", () => {
    expect(() => parseBudgetFlag("1.9")).toThrow(SlopError);
  });

  it("still rejects a negative integer (existing non-negative bound preserved)", () => {
    expect(() => parseBudgetFlag("-5")).toThrow(SlopError);
  });

  it("rejects a value that is entirely non-numeric", () => {
    expect(() => parseBudgetFlag("notanumber")).toThrow(SlopError);
  });
});
