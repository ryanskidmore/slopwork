import { describe, expect, it } from "vitest";
import { renderMrLink } from "./review.js";

// Stored-XSS regression (ticket_01KY93E2FG20KF5RVW7HRK9M7X): the review
// panel's MR column had the same unguarded `href="${review.mr}"`
// interpolation as ticket-detail.ts (see that file's test for the shared
// pre-fix repro). Same render-time backstop here.
describe("renderMrLink (review panel)", () => {
  it("renders a safe https MR URL as a live href", () => {
    const out = renderMrLink("https://gitlab.example/org/repo/-/merge_requests/1");
    expect(out.raw).toContain('href="https://gitlab.example/org/repo/-/merge_requests/1"');
  });

  it("falls back to inert text for a javascript: MR URL", () => {
    const out = renderMrLink("javascript:alert(1)");
    expect(out.raw).not.toMatch(/href="javascript:/i);
    expect(out.raw).not.toContain("<a ");
  });

  it("falls back to inert text for a vbscript: MR URL", () => {
    const out = renderMrLink("vbscript:msgbox(1)");
    expect(out.raw).not.toMatch(/href="vbscript:/i);
  });

  it("shows the no-MR-link placeholder when mr is undefined", () => {
    const out = renderMrLink(undefined);
    expect(out.raw).toContain("no MR link");
    expect(out.raw).not.toContain("<a ");
  });
});
