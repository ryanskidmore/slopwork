import { describe, expect, it } from "vitest";
import { configSchema } from "../core/index.js";
import { type ConfigYamlInput, parseConfigYamlText, stringifyConfigYaml } from "./config-yaml.js";

describe("parseConfigYamlText", () => {
  it("parses design.md §3's exact config.yaml example", () => {
    const text = `project: slopwork
user: ryan                    # actor fallback (D17)
remotes:
  repo: https://github.com/ryan/slopwork   # autodetected
  jira: https://yourorg.atlassian.net       # prompted or blank
defaults:
  stale_after: 60m
  review_stale_after: 24h
`;
    const parsed = configSchema.parse(parseConfigYamlText(text));
    expect(parsed).toEqual({
      project: "slopwork",
      user: "ryan",
      remotes: {
        repo: "https://github.com/ryan/slopwork",
        jira: "https://yourorg.atlassian.net",
      },
      defaults: { stale_after: "60m", review_stale_after: "24h" },
    });
  });

  it("parses a minimal fresh-init config with no user/repo/jira", () => {
    const text =
      "project: widgets\nremotes:\ndefaults:\n  stale_after: 60m\n  review_stale_after: 24h\n";
    const parsed = configSchema.parse(parseConfigYamlText(text));
    expect(parsed.project).toBe("widgets");
    expect(parsed.user).toBeUndefined();
    expect(parsed.remotes.repo).toBeUndefined();
    expect(parsed.remotes.jira).toBeUndefined();
  });

  it("parses an explicit blank jira as an empty string, distinct from absent", () => {
    const text =
      'project: widgets\nremotes:\n  jira: ""\ndefaults:\n  stale_after: 60m\n  review_stale_after: 24h\n';
    const parsed = configSchema.parse(parseConfigYamlText(text));
    expect(parsed.remotes.jira).toBe("");
  });

  it("ignores blank lines and full-line comments", () => {
    const text =
      "# a header comment\n\nproject: widgets\n\n# another comment\nremotes:\ndefaults:\n  stale_after: 60m\n  review_stale_after: 24h\n";
    const parsed = configSchema.parse(parseConfigYamlText(text));
    expect(parsed.project).toBe("widgets");
  });

  it("throws a clear error on an unparseable line", () => {
    expect(() => parseConfigYamlText("not a valid line at all")).toThrow(/cannot parse line/);
  });
});

describe("stringifyConfigYaml", () => {
  const full: ConfigYamlInput = {
    project: "slopwork",
    user: "ryan",
    repo: "https://github.com/ryan/slopwork",
    jira: "https://yourorg.atlassian.net",
    staleAfter: "60m",
    reviewStaleAfter: "24h",
  };

  it("round-trips through parseConfigYamlText + configSchema for a fully-populated config", () => {
    const text = stringifyConfigYaml(full);
    const parsed = configSchema.parse(parseConfigYamlText(text));
    expect(parsed).toEqual({
      project: "slopwork",
      user: "ryan",
      remotes: {
        repo: "https://github.com/ryan/slopwork",
        jira: "https://yourorg.atlassian.net",
      },
      defaults: { stale_after: "60m", review_stale_after: "24h" },
    });
  });

  it("omits user/repo/jira keys entirely when undefined (never-detected / never-prompted), and round-trips that too", () => {
    const minimal: ConfigYamlInput = {
      project: "widgets",
      staleAfter: "60m",
      reviewStaleAfter: "24h",
    };
    const text = stringifyConfigYaml(minimal);
    expect(text).not.toMatch(/^user:/m);
    expect(text).not.toMatch(/repo:/);
    expect(text).not.toMatch(/jira:/);
    const parsed = configSchema.parse(parseConfigYamlText(text));
    expect(parsed.user).toBeUndefined();
    expect(parsed.remotes.repo).toBeUndefined();
    expect(parsed.remotes.jira).toBeUndefined();
  });

  it("writes an explicit blank jira as a quoted empty string, and round-trips it as ''", () => {
    const text = stringifyConfigYaml({ ...full, jira: "" });
    expect(text).toMatch(/jira: ""/);
    const parsed = configSchema.parse(parseConfigYamlText(text));
    expect(parsed.remotes.jira).toBe("");
  });

  it("quotes a project name that would otherwise be ambiguous YAML", () => {
    const text = stringifyConfigYaml({ ...full, project: "true" });
    const parsed = configSchema.parse(parseConfigYamlText(text));
    expect(parsed.project).toBe("true");
  });

  it("matches design.md §3's field order and shape", () => {
    const text = stringifyConfigYaml(full);
    const keys = text
      .split("\n")
      .filter((l) => /^[a-z]/.test(l))
      .map((l) => l.split(":")[0]);
    expect(keys).toEqual(["project", "user", "remotes", "defaults"]);
  });
});
