import { describe, expect, it, vi } from "vitest";
import { EXIT_CODES } from "../core/exit-codes.js";
import { printError, reportError, SlopError } from "./errors.js";

describe("SlopError", () => {
  it("defaults to GENERIC_ERROR when no exit code is given", () => {
    const err = new SlopError("boom");
    expect(err.message).toBe("boom");
    expect(err.exitCode).toBe(EXIT_CODES.GENERIC_ERROR);
    expect(err.name).toBe("SlopError");
    expect(err).toBeInstanceOf(Error);
  });

  it("carries whichever exit code it's constructed with", () => {
    const err = new SlopError("not found", EXIT_CODES.NOT_FOUND);
    expect(err.exitCode).toBe(EXIT_CODES.NOT_FOUND);
  });
});

describe("printError", () => {
  it("writes 'error: <message>' to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      printError("something went wrong");
      expect(spy).toHaveBeenCalledWith("error: something went wrong\n");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("reportError", () => {
  it("a SlopError: prints its message and returns its own exit code", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = reportError(new SlopError("usage mistake", EXIT_CODES.USAGE_ERROR));
      expect(code).toBe(EXIT_CODES.USAGE_ERROR);
      expect(spy).toHaveBeenCalledWith("error: usage mistake\n");
    } finally {
      spy.mockRestore();
    }
  });

  it("a plain Error: prints its message and returns GENERIC_ERROR", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = reportError(new Error("unexpected"));
      expect(code).toBe(EXIT_CODES.GENERIC_ERROR);
      expect(spy).toHaveBeenCalledWith("error: unexpected\n");
    } finally {
      spy.mockRestore();
    }
  });

  it("a non-Error thrown value: stringifies it and returns GENERIC_ERROR", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = reportError("just a string");
      expect(code).toBe(EXIT_CODES.GENERIC_ERROR);
      expect(spy).toHaveBeenCalledWith("error: just a string\n");
    } finally {
      spy.mockRestore();
    }
  });
});
