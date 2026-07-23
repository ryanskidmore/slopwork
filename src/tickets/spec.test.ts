import { describe, expect, it } from "vitest";
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

  it("a JSON object that fails spec validation falls through to markdown, verbatim", () => {
    const raw = JSON.stringify({ acceptance: "not an array" });
    const spec = parseSpecInput(raw, "Ticket name");
    expect(spec.details_md).toBe(raw);
    expect(spec.summary).toBe("Ticket name");
  });

  it("empty input yields an empty details_md and the name as summary", () => {
    const spec = parseSpecInput("", "Ticket name");
    expect(spec.details_md).toBe("");
    expect(spec.summary).toBe("Ticket name");
  });
});
