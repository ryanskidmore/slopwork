import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../core/index.js";
import { SlopError } from "../cli/errors.js";
import { assertLabelHasNoLeadingSigil } from "./labels.js";

describe("assertLabelHasNoLeadingSigil", () => {
  it("does not throw for an ordinary label", () => {
    expect(() => assertLabelHasNoLeadingSigil("bug", "--label")).not.toThrow();
  });

  it("does not throw for a key:value label", () => {
    expect(() => assertLabelHasNoLeadingSigil("type:feature", "--label")).not.toThrow();
  });

  it("throws USAGE_ERROR for a label starting with +", () => {
    let caught: unknown;
    try {
      assertLabelHasNoLeadingSigil("+bug", "--label");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SlopError);
    expect((caught as SlopError).exitCode).toBe(EXIT_CODES.USAGE_ERROR);
    expect((caught as SlopError).message).toContain("+bug");
  });

  it("throws USAGE_ERROR for a label starting with -", () => {
    let caught: unknown;
    try {
      assertLabelHasNoLeadingSigil("-weird", "--label");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SlopError);
    expect((caught as SlopError).exitCode).toBe(EXIT_CODES.USAGE_ERROR);
    expect((caught as SlopError).message).toContain("-weird");
  });

  it("the error message names the given flag", () => {
    let caught: unknown;
    try {
      assertLabelHasNoLeadingSigil("+bug", "--some-flag");
    } catch (err) {
      caught = err;
    }
    expect((caught as SlopError).message).toContain("--some-flag");
  });
});
