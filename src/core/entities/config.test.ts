import { describe, expect, it } from "vitest";
import { configSchema, normalizeBackendSelection } from "./config.js";

describe("configSchema", () => {
  it("parses the exact example from design.md §3, defaults included", () => {
    const parsed = configSchema.parse({
      project: "slopwork",
      user: "ryan",
      remotes: {
        repo: "https://github.com/ryan/slopwork",
        jira: "https://yourorg.atlassian.net",
      },
      defaults: {
        stale_after: "60m",
        review_stale_after: "24h",
      },
    });
    expect(parsed).toEqual({
      project: "slopwork",
      user: "ryan",
      remotes: {
        repo: "https://github.com/ryan/slopwork",
        jira: "https://yourorg.atlassian.net",
      },
      defaults: {
        stale_after: "60m",
        review_stale_after: "24h",
        lock_timeout: "5s",
      },
      backend: "flatfile",
    });
  });

  it("fully defaults from just a project name (fresh `slop init`)", () => {
    const parsed = configSchema.parse({ project: "slopwork" });
    expect(parsed).toEqual({
      project: "slopwork",
      remotes: {},
      defaults: {
        stale_after: "60m",
        review_stale_after: "24h",
        lock_timeout: "5s",
      },
      backend: "flatfile",
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

  // G1 (transcripts removed): a config.yaml written before the removal may
  // still carry a `transcripts:` key — parsing must not fail; the unknown
  // key is simply stripped by the (non-strict) object schema.
  it("still parses a legacy config carrying a transcripts key (ignored, not fatal)", () => {
    const result = configSchema.safeParse({ project: "x", transcripts: "local" });
    expect(result.success).toBe(true);
    expect(result.success && "transcripts" in result.data).toBe(false);
  });

  it("rejects a missing project name", () => {
    expect(configSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a malformed defaults.stale_after duration", () => {
    expect(
      configSchema.safeParse({ project: "x", defaults: { stale_after: "soon" } }).success,
    ).toBe(false);
  });

  it("coerces a null remotes (real-YAML shape of a bare `remotes:` line with no children, as written by `slop init` without --jira) to an empty object", () => {
    const parsed = configSchema.parse({ project: "x", remotes: null });
    expect(parsed.remotes).toEqual({});
  });

  it("coerces remotes.jira: null to absent, keeping a sibling repo intact", () => {
    const parsed = configSchema.parse({
      project: "x",
      remotes: { repo: "https://github.com/ryan/slopwork", jira: null },
    });
    expect(parsed.remotes.jira).toBeUndefined();
    expect(parsed.remotes.repo).toBe("https://github.com/ryan/slopwork");
  });

  it("coerces remotes.repo: null to absent", () => {
    const parsed = configSchema.parse({ project: "x", remotes: { repo: null } });
    expect(parsed.remotes.repo).toBeUndefined();
  });

  it("still fully parses a fully-specified remotes (repo + jira), preserving both — the jira badge URL path", () => {
    const parsed = configSchema.parse({
      project: "x",
      remotes: {
        repo: "https://github.com/ryan/slopwork",
        jira: "https://yourorg.atlassian.net",
      },
    });
    expect(parsed.remotes).toEqual({
      repo: "https://github.com/ryan/slopwork",
      jira: "https://yourorg.atlassian.net",
    });
  });

  it("still rejects a non-URL, non-null, non-blank remotes.jira (null tolerance doesn't weaken real validation)", () => {
    expect(configSchema.safeParse({ project: "x", remotes: { jira: "not a url" } }).success).toBe(
      false,
    );
  });

  // G2: `backend:` selects the storage backend — see configBackendSchema's
  // own doc comment for the accepted forms.
  describe("backend:", () => {
    it("defaults to flatfile when the key is absent", () => {
      const parsed = configSchema.parse({ project: "x" });
      expect(parsed.backend).toBe("flatfile");
    });

    it("coerces a bare `backend:` line (real-YAML null) to flatfile", () => {
      const parsed = configSchema.parse({ project: "x", backend: null });
      expect(parsed.backend).toBe("flatfile");
    });

    it("accepts the bare string shorthand 'flatfile'", () => {
      const parsed = configSchema.parse({ project: "x", backend: "flatfile" });
      expect(parsed.backend).toBe("flatfile");
    });

    it("accepts the bare string shorthand 'remote'", () => {
      const parsed = configSchema.parse({ project: "x", backend: "remote" });
      expect(parsed.backend).toBe("remote");
    });

    it("accepts the structured form { kind: remote, url }", () => {
      const parsed = configSchema.parse({
        project: "x",
        backend: { kind: "remote", url: "https://slop.example.workers.dev" },
      });
      expect(parsed.backend).toEqual({
        kind: "remote",
        url: "https://slop.example.workers.dev",
      });
    });

    it("accepts the structured form { kind: remote } with no url", () => {
      const parsed = configSchema.parse({ project: "x", backend: { kind: "remote" } });
      expect(parsed.backend).toEqual({ kind: "remote" });
    });

    it("rejects an unknown backend kind", () => {
      expect(configSchema.safeParse({ project: "x", backend: { kind: "sqlite" } }).success).toBe(
        false,
      );
    });

    it("rejects a non-URL remote url", () => {
      expect(
        configSchema.safeParse({ project: "x", backend: { kind: "remote", url: "not a url" } })
          .success,
      ).toBe(false);
    });
  });

  describe("normalizeBackendSelection", () => {
    it("normalizes every accepted shape to {kind: 'flatfile'} or {kind: 'remote', url?}", () => {
      expect(normalizeBackendSelection("flatfile")).toEqual({ kind: "flatfile" });
      expect(normalizeBackendSelection("remote")).toEqual({ kind: "remote" });
      expect(normalizeBackendSelection({ kind: "flatfile" })).toEqual({ kind: "flatfile" });
      expect(normalizeBackendSelection({ kind: "remote" })).toEqual({ kind: "remote" });
      expect(normalizeBackendSelection({ kind: "remote", url: "https://x.example" })).toEqual({
        kind: "remote",
        url: "https://x.example",
      });
    });
  });
});
