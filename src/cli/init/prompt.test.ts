import { describe, expect, it } from "vitest";
import { isInteractive } from "./prompt.js";

describe("isInteractive", () => {
  it("false when neither stream is a TTY", () => {
    expect(isInteractive({ isTTY: false }, { isTTY: false })).toBe(false);
    expect(isInteractive({}, {})).toBe(false);
  });

  it("false when only one of the two streams is a TTY", () => {
    expect(isInteractive({ isTTY: true }, { isTTY: false })).toBe(false);
    expect(isInteractive({ isTTY: false }, { isTTY: true })).toBe(false);
  });

  it("true only when both stdin and stdout are TTYs", () => {
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(true);
  });

  it("reflects the real process streams by default — false under the vitest test runner (never a TTY)", () => {
    expect(isInteractive()).toBe(false);
  });
});
