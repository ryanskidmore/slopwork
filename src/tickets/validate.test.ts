/**
 * No prior dedicated test file — `zodIssueLines`/`formatZodIssuesForUsage`
 * were only exercised indirectly through commands that call them on a
 * real ticketSchema failure, leaving the root-path branch (an issue with
 * an EMPTY `path`, i.e. the top-level value itself is invalid) untested.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatZodIssuesForUsage, zodIssueLines } from "./validate.js";

describe("zodIssueLines", () => {
  it("renders a `path.to.field: message` line per issue for issues with a non-empty path", () => {
    const schema = z.object({ name: z.string(), count: z.number() });
    const result = schema.safeParse({ name: 42, count: "nope" });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");

    const lines = zodIssueLines(result.error);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ {2}name: /);
    expect(lines[1]).toMatch(/^ {2}count: /);
  });

  it("renders a nested path joined with dots", () => {
    const schema = z.object({ spec: z.object({ summary: z.string() }) });
    const result = schema.safeParse({ spec: { summary: 5 } });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");

    expect(zodIssueLines(result.error)[0]).toMatch(/^ {2}spec\.summary: /);
  });

  it("renders '(root)' for an issue with an empty path (the top-level value itself is invalid)", () => {
    const schema = z.string();
    const result = schema.safeParse(42);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");

    const lines = zodIssueLines(result.error);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ {2}\(root\): /);
  });
});

describe("formatZodIssuesForUsage", () => {
  it("joins a prefix line with one line per issue", () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");

    const text = formatZodIssuesForUsage("invalid ticket:", result.error);
    const lines = text.split("\n");
    expect(lines[0]).toBe("invalid ticket:");
    expect(lines).toHaveLength(1 + result.error.issues.length);
  });
});
