import { describe, expect, it } from "vitest";
import { configSchema } from "./config.js";

describe("configSchema", () => {
  it("parses the exact example from design.md §3, defaults included", () => {
    const parsed = configSchema.parse({
      project: "slopworks",
      user: "ryan",
      remotes: {
        repo: "https://github.com/ryan/slopworks",
        jira: "https://yourorg.atlassian.net",
      },
      defaults: {
        stale_after: "60m",
        review_stale_after: "24h",
      },
      transcripts: "local",
    });
    expect(parsed).toEqual({
      project: "slopworks",
      user: "ryan",
      remotes: {
        repo: "https://github.com/ryan/slopworks",
        jira: "https://yourorg.atlassian.net",
      },
      defaults: {
        stale_after: "60m",
        review_stale_after: "24h",
      },
      transcripts: "local",
    });
  });

  it("fully defaults from just a project name (fresh `slop init`)", () => {
    const parsed = configSchema.parse({ project: "slopworks" });
    expect(parsed).toEqual({
      project: "slopworks",
      remotes: {},
      defaults: {
        stale_after: "60m",
        review_stale_after: "24h",
      },
      transcripts: "local",
    });
  });

  it("nested defaults.stale_after/review_stale_after apply even when `defaults` is entirely absent", () => {
    // Regression guard for the `.default(literal)` vs
    // `.default(() => schema.parse({}))` trap documented in config.ts.
    const parsed = configSchema.parse({ project: "x" });
    expect(parsed.defaults.stale_after).toBe("60m");
    expect(parsed.defaults.review_stale_after).toBe("24h");
  });

  it("allows remotes.jira to be an explicit blank string (prompted or blank)", () => {
    const parsed = configSchema.parse({ project: "x", remotes: { jira: "" } });
    expect(parsed.remotes.jira).toBe("");
  });

  it("allows remotes.jira to be absent entirely", () => {
    const parsed = configSchema.parse({ project: "x" });
    expect(parsed.remotes.jira).toBeUndefined();
  });

  it("rejects a non-URL, non-blank remotes.jira", () => {
    expect(configSchema.safeParse({ project: "x", remotes: { jira: "not a url" } }).success).toBe(
      false,
    );
  });

  it("rejects an unknown transcripts mode", () => {
    expect(configSchema.safeParse({ project: "x", transcripts: "s3" }).success).toBe(false);
  });

  it("accepts every transcripts mode", () => {
    for (const mode of ["local", "commit", "off"]) {
      expect(configSchema.safeParse({ project: "x", transcripts: mode }).success).toBe(true);
    }
  });

  it("rejects a missing project name", () => {
    expect(configSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a malformed defaults.stale_after duration", () => {
    expect(
      configSchema.safeParse({ project: "x", defaults: { stale_after: "soon" } }).success,
    ).toBe(false);
  });
});
