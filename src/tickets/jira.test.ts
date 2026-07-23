import { describe, expect, it } from "vitest";
import { configSchema } from "../core/index.js";
import { jiraBrowseUrl, parseExternalRef } from "./jira.js";

function configWithJira(jira?: string) {
  return configSchema.parse({ project: "p", remotes: jira !== undefined ? { jira } : {} });
}

describe("parseExternalRef", () => {
  it("splits system:key", () => {
    expect(parseExternalRef("jira:PROJ-123")).toEqual({ system: "jira", key: "PROJ-123" });
  });

  it("returns null for a non-external ref", () => {
    expect(parseExternalRef("not-a-ref")).toBeNull();
  });
});

describe("jiraBrowseUrl", () => {
  it("builds <base>/browse/<key> when remotes.jira is configured", () => {
    const config = configWithJira("https://example.atlassian.net");
    expect(jiraBrowseUrl(config, "jira:PROJ-123")).toBe(
      "https://example.atlassian.net/browse/PROJ-123",
    );
  });

  it("strips a trailing slash on the configured base", () => {
    const config = configWithJira("https://example.atlassian.net/");
    expect(jiraBrowseUrl(config, "jira:PROJ-123")).toBe(
      "https://example.atlassian.net/browse/PROJ-123",
    );
  });

  it("returns null when remotes.jira is unset", () => {
    const config = configWithJira(undefined);
    expect(jiraBrowseUrl(config, "jira:PROJ-123")).toBeNull();
  });

  it("returns null when remotes.jira is explicitly blank", () => {
    const config = configWithJira("");
    expect(jiraBrowseUrl(config, "jira:PROJ-123")).toBeNull();
  });

  it("returns null for a non-jira external system, even with remotes.jira set", () => {
    const config = configWithJira("https://example.atlassian.net");
    expect(jiraBrowseUrl(config, "gh:123")).toBeNull();
  });

  it("URL-encodes the key", () => {
    const config = configWithJira("https://example.atlassian.net");
    expect(jiraBrowseUrl(config, "jira:PROJ 123")).toBe(
      "https://example.atlassian.net/browse/PROJ%20123",
    );
  });
});
