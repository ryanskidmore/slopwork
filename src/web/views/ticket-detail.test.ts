import { describe, expect, it } from "vitest";
import { renderMrLink } from "./ticket-detail.js";

// Stored-XSS regression (ticket_01KY93E2FG20KF5RVW7HRK9M7X): before this
// fix, ticket-detail.ts interpolated `ticket.review.mr` straight into a
// live `href` (`html\`<a href="${ticket.review.mr}">...\``) — `escapeHtml`
// neutralises HTML metacharacters but never inspects the URL scheme, so a
// `javascript:`/`data:`/`vbscript:` MR link executed the moment a human
// opened the ticket page. `mrUrlSchema` now blocks those schemes at write
// time, but `renderMrLink` is the render-time backstop for anything
// already on disk from before that guard existed.
describe("renderMrLink", () => {
  it("renders a safe https MR URL as a live, escaped href", () => {
    const out = renderMrLink("https://github.com/org/repo/pull/1");
    expect(out.raw).toContain('href="https://github.com/org/repo/pull/1"');
    expect(out.raw).toContain("<a ");
  });

  it("falls back to inert text — no href at all — for a javascript: MR URL", () => {
    const out = renderMrLink("javascript:alert(document.cookie)");
    expect(out.raw).not.toMatch(/href="javascript:/i);
    expect(out.raw).not.toContain("<a ");
    expect(out.raw).toContain("javascript:alert(document.cookie)"); // still shown, just as text
  });

  it("falls back to inert text for a data: MR URL", () => {
    const out = renderMrLink("data:text/html;base64,QQ==");
    expect(out.raw).not.toMatch(/src="data:|href="data:/i);
    expect(out.raw).not.toContain("<a ");
  });

  it("shows the no-MR-link placeholder when mr is undefined", () => {
    const out = renderMrLink(undefined);
    expect(out.raw).toContain("No MR link yet");
    expect(out.raw).not.toContain("<a ");
  });
});
