import { describe, expect, it } from "vitest";
import { computeGitattributesLines, upsertGitattributesSection } from "./gitattributes.js";

describe("computeGitattributesLines", () => {
  it("marks the tracker db as generated for both GitHub and GitLab (t-mgx82)", () => {
    const lines = computeGitattributesLines();
    expect(lines).toContain(".slop/db/** linguist-generated gitlab-generated");
  });

  it("scopes LF enforcement to .jsonc files under the db, not repo-wide", () => {
    const lines = computeGitattributesLines();
    expect(lines).toContain(".slop/db/**/*.jsonc text eol=lf");
    // Deliberately scoped, not the repo-wide rule this repo's own
    // hand-written .gitattributes happens to carry — a fresh init must not
    // assume anything about how the rest of the repo wants .jsonc handled.
    expect(lines).not.toContain("*.jsonc text eol=lf");
  });

  it("returns exactly the two documented lines, in a stable order", () => {
    expect(computeGitattributesLines()).toEqual([
      ".slop/db/** linguist-generated gitlab-generated",
      ".slop/db/**/*.jsonc text eol=lf",
    ]);
  });
});

describe("upsertGitattributesSection", () => {
  it("inserts a fresh managed section into an empty file", () => {
    const { text, changed } = upsertGitattributesSection("", [
      ".slop/db/** linguist-generated gitlab-generated",
    ]);
    expect(changed).toBe(true);
    expect(text).toBe(
      "# --- slopwork (managed by `slop init`) ---\n" +
        ".slop/db/** linguist-generated gitlab-generated\n" +
        "# --- end slopwork ---\n",
    );
  });

  it("preserves pre-existing unrelated content, appending the managed section after it", () => {
    const existing = "*.png binary\n*.bin binary\n";
    const { text } = upsertGitattributesSection(existing, [".slop/db/** linguist-generated"]);
    expect(text).toBe(
      "*.png binary\n*.bin binary\n\n" +
        "# --- slopwork (managed by `slop init`) ---\n" +
        ".slop/db/** linguist-generated\n" +
        "# --- end slopwork ---\n",
    );
  });

  it("is idempotent: applying the same lines twice produces the exact same text, no duplication", () => {
    const lines = computeGitattributesLines();
    const first = upsertGitattributesSection("*.png binary\n", lines);
    const second = upsertGitattributesSection(first.text, lines);
    expect(second.text).toBe(first.text);
    expect(second.changed).toBe(false);
    expect(second.text.match(/linguist-generated/g)).toHaveLength(1);
    expect(second.text.match(/eol=lf/g)).toHaveLength(1);
  });

  it("regenerates the managed section when the lines change", () => {
    const withBoth = upsertGitattributesSection("", computeGitattributesLines());
    const withOnlyGenerated = upsertGitattributesSection(withBoth.text, [
      ".slop/db/** linguist-generated gitlab-generated",
    ]);
    expect(withOnlyGenerated.text).not.toContain("eol=lf");
    expect(withOnlyGenerated.text).toContain("linguist-generated");
    expect(withOnlyGenerated.changed).toBe(true);
  });

  it("preserves content on both sides of an existing managed section (re-appends at the end, content never dropped)", () => {
    const existing =
      "before/* text\n\n" +
      "# --- slopwork (managed by `slop init`) ---\n" +
      ".slop/db/** linguist-generated\n" +
      "# --- end slopwork ---\n" +
      "after/* text\n";
    const { text } = upsertGitattributesSection(existing, [".slop/db/** linguist-generated"]);
    expect(text).toContain("before/* text");
    expect(text).toContain("after/* text");
    expect(text.match(/linguist-generated/g)).toHaveLength(1);

    const second = upsertGitattributesSection(text, [".slop/db/** linguist-generated"]);
    expect(second.text).toBe(text);
    expect(second.changed).toBe(false);
  });

  // t-mgx82: this repo's own root .gitattributes has a HAND-WRITTEN version
  // of the generated-markers rule, predating this feature. init must never
  // rewrite/dedupe that — it only ever touches its own marked section, and
  // appends its own section alongside the hand-written lines (harmless
  // duplication of the attribute is fine in git semantics).
  describe("tolerates a repo with pre-existing hand-written generated-markers lines (no prior managed section)", () => {
    it("appends its own section without touching the hand-written lines", () => {
      const handWritten =
        "# .slop/db/*.jsonc files are written with LF line endings\n" +
        "*.jsonc text eol=lf\n\n" +
        "# Tracker database — mark as generated\n" +
        ".slop/db/** linguist-generated gitlab-generated\n";

      const { text, changed } = upsertGitattributesSection(
        handWritten,
        computeGitattributesLines(),
      );

      expect(changed).toBe(true);
      // Every hand-written line survives byte-for-byte, in place.
      expect(text).toContain("# .slop/db/*.jsonc files are written with LF line endings\n");
      expect(text).toContain("*.jsonc text eol=lf\n");
      expect(text).toContain("# Tracker database — mark as generated\n");
      expect(text).toContain(".slop/db/** linguist-generated gitlab-generated\n");
      // ...and the managed section is appended after it, harmless duplication.
      expect(text).toContain("# --- slopwork (managed by `slop init`) ---");
      const startsWithHandWritten = text.startsWith(handWritten.replace(/\n+$/, ""));
      expect(startsWithHandWritten).toBe(true);

      // Re-running is idempotent even with the hand-written lines still present.
      const second = upsertGitattributesSection(text, computeGitattributesLines());
      expect(second.changed).toBe(false);
      expect(second.text).toBe(text);
    });
  });

  // Windows portability: same CRLF tolerance as gitignore.ts (shared via
  // managed-section.ts) — verify .gitattributes gets it too.
  describe("tolerates a CRLF-line-ended .gitattributes (Windows / core.autocrlf)", () => {
    it("recognizes an existing CRLF managed section and replaces it in place — no duplication", () => {
      const existingCrlf =
        "before/* text\r\n\r\n# --- slopwork (managed by `slop init`) ---\r\n" +
        ".slop/db/** linguist-generated\r\n# --- end slopwork ---\r\nafter/* text\r\n";

      const { text, changed } = upsertGitattributesSection(existingCrlf, [
        ".slop/db/** linguist-generated",
      ]);

      expect(changed).toBe(true);
      expect(text).toContain("before/* text");
      expect(text).toContain("after/* text");
      expect(text.match(/linguist-generated/g)).toHaveLength(1);
      expect(text.match(/# --- slopwork/g)).toHaveLength(1);
    });

    it("re-running init against its own CRLF output is idempotent (no duplicate section)", () => {
      const first = upsertGitattributesSection("*.png binary\r\n", [
        ".slop/db/** linguist-generated",
      ]);
      expect(first.text.match(/linguist-generated/g)).toHaveLength(1);

      const second = upsertGitattributesSection(first.text, [".slop/db/** linguist-generated"]);
      expect(second.changed).toBe(false);
      expect(second.text).toBe(first.text);
    });
  });
});
