import { describe, expect, it } from "vitest";
import { escapeHtml, html, joinHtml, raw, safeUrl } from "./html.js";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("html tagged template", () => {
  it("auto-escapes interpolated string values", () => {
    const name = "<script>alert(1)</script>";
    const out = html`<div>${name}</div>`;
    expect(out.raw).toBe("<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>");
  });

  it("passes RawHtml values through unescaped exactly once", () => {
    const inner = html`<b>bold</b>`;
    const out = html`<div>${inner}</div>`;
    expect(out.raw).toBe("<div><b>bold</b></div>");
  });

  it("passes raw() values through unescaped", () => {
    const out = html`<div>${raw("<i>i</i>")}</div>`;
    expect(out.raw).toBe("<div><i>i</i></div>");
  });

  it("renders arrays of fragments by concatenation", () => {
    const items = ["a", "b", "c"].map((x) => html`<li>${x}</li>`);
    const out = html`<ul>${items}</ul>`;
    expect(out.raw).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
  });

  it("renders null/undefined/false/true as nothing", () => {
    const out = html`<span>${null}${undefined}${false}${true}</span>`;
    expect(out.raw).toBe("<span></span>");
  });

  it("renders numbers as text", () => {
    const out = html`<span>${42}</span>`;
    expect(out.raw).toBe("<span>42</span>");
  });
});

describe("joinHtml", () => {
  it("concatenates a list of HtmlValues into one RawHtml", () => {
    const out = joinHtml(["a", html`<b>b</b>`, raw("<i>c</i>")]);
    expect(out.raw).toBe("a<b>b</b><i>c</i>");
  });
});

// Stored-XSS regression (ticket_01KY93E2FG20KF5RVW7HRK9M7X): escapeHtml only
// neutralises HTML metacharacters — it never looks at a URL's *scheme*, so
// `html\`<a href="${url}">\`` happily emits a live `javascript:`/`data:`
// href. Confirmed pre-fix: `escapeHtml("javascript:alert(1)")` round-trips
// unchanged (no `&`, `<`, `>`, `"`, or `'` to escape), so the raw
// interpolation this app used for `review.mr` and would use for any other
// URL rendered without `safeUrl` produces exactly
// `<a href="javascript:alert(1)">` — a live script sink.
describe("safeUrl", () => {
  it("rejects javascript:, data:, and vbscript: (case-insensitively, with surrounding whitespace)", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeUrl("  javascript:alert(1)  ")).toBeNull();
    expect(safeUrl("data:text/html;base64,QQ==")).toBeNull();
    expect(safeUrl("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
    expect(safeUrl("vbscript:msgbox(1)")).toBeNull();
  });

  it("rejects a protocol-relative reference (resolves through the page's own scheme)", () => {
    expect(safeUrl("//evil.example/x")).toBeNull();
  });

  it("rejects an empty or whitespace-only string", () => {
    expect(safeUrl("")).toBeNull();
    expect(safeUrl("   ")).toBeNull();
  });

  it("accepts http/https/mailto absolute URLs unchanged", () => {
    expect(safeUrl("https://example.com/pr/1")).toBe("https://example.com/pr/1");
    expect(safeUrl("http://example.com")).toBe("http://example.com");
    expect(safeUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
  });

  it("accepts relative, absolute-path, query, and fragment references (no executable scheme)", () => {
    expect(safeUrl("/tickets/123")).toBe("/tickets/123");
    expect(safeUrl("#section")).toBe("#section");
    expect(safeUrl("?offset=10")).toBe("?offset=10");
    expect(safeUrl("./relative/path")).toBe("./relative/path");
    expect(safeUrl("relative/path")).toBe("relative/path");
  });
});
