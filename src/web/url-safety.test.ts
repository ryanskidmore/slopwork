import { describe, expect, it } from "vitest";
import { safeUrl } from "./url-safety.js";

// Stored-XSS regression (ticket_01KY93E2FG20KF5RVW7HRK9M7X, carried forward
// by rewrite-slop-web-as-a): a URL rendered without going through safeUrl
// first can smuggle a `javascript:`/`data:`/`vbscript:` scheme straight
// into a live href/src. This module is the one place left that knows what
// a "safe" URL looks like, now that the server-rendered HTML templating
// (src/web/html.ts) is gone — see src/web/api/*.ts and
// src/web/markdown.ts for its two callers.
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
