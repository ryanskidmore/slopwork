import { describe, expect, it } from "vitest";
import { sanitizeMarkdownHtml } from "./markdown.js";

// Stored-XSS regression (ticket_01KY93E2FG20KF5RVW7HRK9M7X): Bun's
// `noHtmlBlocks`/`noHtmlSpans` (SAFE_OPTIONS above) stop raw HTML from
// surviving, but they do nothing about a markdown link/image
// *destination* — confirmed pre-fix by calling `Bun.markdown.html()`
// directly (no `sanitizeMarkdownHtml` in the pipeline, e.g. via `bun -e`):
// `[x](javascript:alert(1))` renders `<a href="javascript:alert(1)">x</a>`,
// and `![x](data:text/html;base64,QQ==)` renders
// `<img src="data:text/html;base64,QQ==" alt="x" />` — both live sinks a
// human opening the ticket/transcript page would trigger just by viewing
// it. `renderMarkdownToString` (this module's public entry point, and what
// ticket-detail.ts/transcript-view.ts actually call) is
// `sanitizeMarkdownHtml(Bun.markdown.html(source, SAFE_OPTIONS))` — the
// exact strings this suite feeds `sanitizeMarkdownHtml` below are real
// `Bun.markdown.html()` output for those same malicious markdown inputs
// (verified separately: `Bun.markdown` needs the Bun runtime directly and
// isn't available under this project's `vitest`/`bun run test` worker
// pool, so it's exercised end-to-end via a source-spawned `slop web`
// server instead — see this ticket's session notes — while this file
// covers the pure post-processing step vitest *can* run).
describe("sanitizeMarkdownHtml — neutralises unsafe href/src schemes", () => {
  it("strips a javascript: href (real Bun.markdown output for [x](javascript:alert(1)))", () => {
    const out = sanitizeMarkdownHtml('<p><a href="javascript:alert(1)">x</a></p>');
    expect(out).not.toMatch(/href="javascript:/i);
    expect(out).not.toContain("href=");
  });

  it("strips a data: src (real Bun.markdown output for ![x](data:text/html;base64,QQ==))", () => {
    const out = sanitizeMarkdownHtml('<p><img src="data:text/html;base64,QQ==" alt="x" /></p>');
    expect(out).not.toMatch(/src="data:/i);
    expect(out).not.toContain("src=");
  });

  it("strips a vbscript: href", () => {
    const out = sanitizeMarkdownHtml('<p><a href="vbscript:msgbox(1)">x</a></p>');
    expect(out).not.toMatch(/href="vbscript:/i);
  });

  it("is case-insensitive to the scheme", () => {
    expect(sanitizeMarkdownHtml('<a href="JavaScript:alert(1)">x</a>')).not.toMatch(
      /href="javascript:/i,
    );
    expect(sanitizeMarkdownHtml('<a href="VBScript:alert(1)">x</a>')).not.toMatch(
      /href="vbscript:/i,
    );
  });

  it("decodes the entities Bun.markdown itself emits before checking the scheme (&amp; case)", () => {
    // Real Bun.markdown output for a query string: "&" becomes "&amp;" —
    // must not be mistaken for an unsafe scheme, and must round-trip intact.
    const input = '<a href="https://example.com/a?b=1&amp;c=2">x</a>';
    expect(sanitizeMarkdownHtml(input)).toBe(input);
  });

  it("leaves the surrounding tag/text intact when stripping — inert text, not a broken document", () => {
    const out = sanitizeMarkdownHtml('<p><a href="javascript:alert(1)">click me</a></p>');
    expect(out).toContain("click me");
    expect(out).toContain("<a >click me</a>");
  });

  it("leaves an unsafe img's alt text but drops src", () => {
    const out = sanitizeMarkdownHtml('<img src="data:text/html,x" alt="a picture" />');
    expect(out).toContain('alt="a picture"');
    expect(out).not.toContain("src=");
  });

  it("leaves safe http/https/mailto/relative href/src completely untouched", () => {
    const input =
      '<p><a href="https://example.com">x</a> <a href="mailto:a@b.com">y</a> ' +
      '<a href="/tickets/123">z</a> <img src="/local.png" alt="w" /></p>';
    expect(sanitizeMarkdownHtml(input)).toBe(input);
  });

  it("is a no-op on markup with no href/src at all", () => {
    const input = "<h1>Heading</h1><ul><li>one</li><li>two</li></ul>";
    expect(sanitizeMarkdownHtml(input)).toBe(input);
  });
});
