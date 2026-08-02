import { describe, expect, it } from "vitest";
import { CONFIG_YAML_CONFORMANCE_CASES } from "../../tests/fixtures/config-yaml-conformance.js";
import { configSchema, normalizeBackendSelection } from "./entities/config.js";
import { type ConfigYamlInput, parseConfigYamlText, stringifyConfigYaml } from "./config-yaml.js";

describe("parseConfigYamlText", () => {
  it("parses design.md section 3's config example", () => {
    const parsed = configSchema.parse(
      parseConfigYamlText(`project: slopwork
user: ryan                    # actor fallback (D17)
remotes:
  repo: https://github.com/ryan/slopwork   # autodetected
  jira: https://yourorg.atlassian.net       # prompted or blank
defaults:
  stale_after: 60m
  review_stale_after: 24h
`),
    );

    expect(parsed).toEqual({
      project: "slopwork",
      user: "ryan",
      remotes: {
        repo: "https://github.com/ryan/slopwork",
        jira: "https://yourorg.atlassian.net",
      },
      defaults: { stale_after: "60m", review_stale_after: "24h", lock_timeout: "5s" },
      backend: "flatfile",
    });
  });

  it.each(CONFIG_YAML_CONFORMANCE_CASES)("uses YAML 1.2 semantics: $name", (testCase) => {
    const raw = parseConfigYamlText(testCase.yaml);
    const parsed = configSchema.safeParse(raw);
    expect(parsed.success).toBe(testCase.valid);
    if (!parsed.success) return;

    expect(parsed.data.project).toBe(testCase.project);
    expect(normalizeBackendSelection(parsed.data.backend).kind).toBe(testCase.backendKind);
    expect(parsed.data.remotes.jira ?? null).toBe(testCase.jira);
    expect(parsed.data.defaults.stale_after).toBe(testCase.staleAfter);
  });

  it("preserves absent and explicitly blank Jira as distinct values", () => {
    const absent = configSchema.parse(parseConfigYamlText("project: widgets\nremotes:\n"));
    const blank = configSchema.parse(
      parseConfigYamlText('project: widgets\nremotes: { jira: "" }\n'),
    );
    expect(absent.remotes.jira).toBeUndefined();
    expect(blank.remotes.jira).toBe("");
  });

  it("throws with line context for invalid YAML", () => {
    expect(() => parseConfigYamlText("project: [unterminated")).toThrow(/line 1, column/i);
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

  it("round-trips a fully populated init config", () => {
    const parsed = configSchema.parse(parseConfigYamlText(stringifyConfigYaml(full)));
    expect(parsed).toEqual({
      project: "slopwork",
      user: "ryan",
      remotes: {
        repo: "https://github.com/ryan/slopwork",
        jira: "https://yourorg.atlassian.net",
      },
      defaults: { stale_after: "60m", review_stale_after: "24h", lock_timeout: "5s" },
      backend: "flatfile",
    });
  });

  it("omits undetected optional values and round-trips an empty remotes map", () => {
    const text = stringifyConfigYaml({
      project: "widgets",
      staleAfter: "60m",
      reviewStaleAfter: "24h",
    });
    expect(text).not.toMatch(/^user:/m);
    expect(text).not.toMatch(/^\s+repo:/m);
    expect(text).not.toMatch(/^\s+jira:/m);
    const parsed = configSchema.parse(parseConfigYamlText(text));
    expect(parsed.remotes).toEqual({});
  });

  it("lets the codec own empty and ambiguous scalar quoting", () => {
    const text = stringifyConfigYaml({ ...full, project: "true", jira: "" });
    expect(text).toMatch(/project: ["']true["']/);
    expect(text).toMatch(/jira: ["']["']/);
    const parsed = configSchema.parse(parseConfigYamlText(text));
    expect(parsed.project).toBe("true");
    expect(parsed.remotes.jira).toBe("");
  });

  it("keeps the documented top-level field order", () => {
    const text = stringifyConfigYaml(full);
    const keys = text
      .split("\n")
      .filter((line) => /^[a-z]/.test(line))
      .map((line) => line.split(":")[0]);
    expect(keys).toEqual(["project", "user", "remotes", "defaults"]);
  });
});
