import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../core/index.js";
import { SlopError } from "../cli/errors.js";
import { defaultSpec, defaultSummaryFromName, parseSpecInput } from "./spec.js";

describe("defaultSpec", () => {
  it("defaults summary from the name and leaves everything else at spec defaults", () => {
    const spec = defaultSpec("Add auth provider");
    expect(spec).toEqual({
      summary: "Add auth provider",
      details_md: "",
      acceptance: [],
      context: [],
      meta: {},
      v: 1,
    });
  });
});

describe("defaultSummaryFromName", () => {
  it("trims the name", () => {
    expect(defaultSummaryFromName("  Add auth provider  ")).toBe("Add auth provider");
  });
});

describe("parseSpecInput (D10: bare markdown -> details_md)", () => {
  it("treats a JSON object matching specSchema structurally", () => {
    const spec = parseSpecInput(
      JSON.stringify({ summary: "Custom summary", acceptance: ["a", "b"], context: ["ctx"] }),
      "Ticket name",
    );
    expect(spec.summary).toBe("Custom summary");
    expect(spec.acceptance).toEqual(["a", "b"]);
    expect(spec.context).toEqual(["ctx"]);
    expect(spec.details_md).toBe("");
  });

  it("defaults summary from the name when the JSON object omits it", () => {
    const spec = parseSpecInput(JSON.stringify({ details_md: "some detail" }), "Ticket name");
    expect(spec.summary).toBe("Ticket name");
    expect(spec.details_md).toBe("some detail");
  });

  it("an explicit summary in the JSON wins over the name default", () => {
    const spec = parseSpecInput(JSON.stringify({ summary: "Explicit" }), "Ticket name");
    expect(spec.summary).toBe("Explicit");
  });

  it("bare markdown (not JSON at all) lands whole in details_md", () => {
    const raw = "# Heading\n\nSome *markdown* prose.\n- bullet";
    const spec = parseSpecInput(raw, "Ticket name");
    expect(spec.details_md).toBe(raw);
    expect(spec.summary).toBe("Ticket name");
  });

  it("a JSON array is not spec-structural — falls through to markdown", () => {
    const raw = '["a", "b"]';
    const spec = parseSpecInput(raw, "Ticket name");
    expect(spec.details_md).toBe(raw);
    expect(spec.summary).toBe("Ticket name");
  });

  it("a bare JSON primitive (valid JSON, not an object) falls through to markdown", () => {
    const raw = '"just a string"';
    const spec = parseSpecInput(raw, "Ticket name");
    expect(spec.details_md).toBe(raw);
  });

  it("a JSON object with only known keys that fails spec validation errors as USAGE_ERROR, naming the field", () => {
    const raw = JSON.stringify({ acceptance: "not an array" });
    let caught: unknown;
    try {
      parseSpecInput(raw, "Ticket name");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SlopError);
    const err = caught as SlopError;
    expect(err.exitCode).toBe(EXIT_CODES.USAGE_ERROR);
    expect(err.message).toContain("acceptance");
  });

  it("empty input yields an empty details_md and the name as summary", () => {
    const spec = parseSpecInput("", "Ticket name");
    expect(spec.details_md).toBe("");
    expect(spec.summary).toBe("Ticket name");
  });

  it("a JSON object with an unknown top-level key errors as USAGE_ERROR naming the key, rather than silently discarding it", () => {
    const raw = JSON.stringify({ details: "my writeup" });
    let caught: unknown;
    try {
      parseSpecInput(raw, "Ticket name");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SlopError);
    const err = caught as SlopError;
    expect(err.exitCode).toBe(EXIT_CODES.USAGE_ERROR);
    expect(err.message).toContain("details");
  });

  it("a JSON object mixing known and unknown top-level keys also errors as USAGE_ERROR naming the unknown key", () => {
    const raw = JSON.stringify({ summary: "Custom summary", details: "my writeup" });
    let caught: unknown;
    try {
      parseSpecInput(raw, "Ticket name");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SlopError);
    const err = caught as SlopError;
    expect(err.exitCode).toBe(EXIT_CODES.USAGE_ERROR);
    expect(err.message).toContain("details");
  });

  it("a truncated/malformed JSON-looking spec (starts with { but isn't valid JSON) falls through to markdown, unchanged", () => {
    const raw = '{"summary": "oops, truncated';
    const spec = parseSpecInput(raw, "Ticket name");
    expect(spec.details_md).toBe(raw);
    expect(spec.summary).toBe("Ticket name");
  });

  it("a JSON object with only known top-level keys still parses structurally, unchanged", () => {
    const spec = parseSpecInput(
      JSON.stringify({
        summary: "Custom summary",
        details_md: "prose",
        acceptance: ["a"],
        context: ["c"],
        meta: { k: "v" },
        v: 1,
      }),
      "Ticket name",
    );
    expect(spec.summary).toBe("Custom summary");
    expect(spec.details_md).toBe("prose");
    expect(spec.acceptance).toEqual(["a"]);
    expect(spec.context).toEqual(["c"]);
    expect(spec.meta).toEqual({ k: "v" });
    expect(spec.v).toBe(1);
  });
});
