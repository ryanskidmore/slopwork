import { describe, expect, it } from "vitest";
import { configSchema } from "../../core/index.js";
import { externalParentBadge } from "./shared.js";

function configWithJira(jira: string) {
  return configSchema.parse({ project: "demo", remotes: { jira } });
}

// Stored-XSS regression (web-jira-remote-url-not): `externalParentBadge`
// built its `href` straight from `config.remotes.jira` — schema-validated
// with zod's `z.url()`, which accepts any scheme including
// `javascript:`/`data:`/`vbscript:` — without ever routing it through
// `safeUrl` (unlike `renderMrLink`'s handling of `ticket.review.mr`).
// Since config.yaml is collaborator-editable/git-merged, a malicious
// remote there would execute JS in the web UI origin the moment someone
// clicked the badge.
describe("externalParentBadge", () => {
  it("renders a live link for a safe https jira remote", () => {
    const out = externalParentBadge("jira:PROJ-123", configWithJira("https://issues.example.com"));
    expect(out.raw).toContain("<a ");
    expect(out.raw).toContain('href="https://issues.example.com/browse/PROJ-123"');
  });

  it("falls back to inert text — no href at all — for a javascript: jira remote", () => {
    const out = externalParentBadge(
      "jira:PROJ-123",
      configWithJira("javascript:alert(document.cookie)"),
    );
    expect(out.raw).not.toMatch(/href="javascript:/i);
    expect(out.raw).not.toContain("<a ");
    expect(out.raw).toContain("↑ jira:PROJ-123"); // ref still shown, just as text
  });

  it("falls back to inert text for a data: jira remote", () => {
    const out = externalParentBadge("jira:PROJ-123", configWithJira("data:text/html;base64,QQ=="));
    expect(out.raw).not.toMatch(/href="data:/i);
    expect(out.raw).not.toContain("<a ");
  });

  it("falls back to inert text when no jira remote is configured", () => {
    const out = externalParentBadge("jira:PROJ-123", configSchema.parse({ project: "demo" }));
    expect(out.raw).not.toContain("<a ");
    expect(out.raw).toContain("↑ jira:PROJ-123");
  });
});
