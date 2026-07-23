import { describe, expect, it } from "vitest";
import { escapeHtml, html, joinHtml, raw } from "./html.js";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("html tagged template", () => {
  it("auto-escapes interpolated string values", () => {
    const name = '<script>alert(1)</script>';
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
