import { describe, expect, it } from "vitest";
import { computeGitignoreLines, upsertGitignoreSection } from "./gitignore.js";

describe("computeGitignoreLines", () => {
  it("always ignores index.jsonc (D14)", () => {
    expect(computeGitignoreLines("local")).toContain(".slop/db/index.jsonc");
    expect(computeGitignoreLines("commit")).toContain(".slop/db/index.jsonc");
    expect(computeGitignoreLines("off")).toContain(".slop/db/index.jsonc");
  });

  it("ignores transcripts/ unless transcripts: commit (D16)", () => {
    expect(computeGitignoreLines("local")).toContain(".slop/transcripts/");
    expect(computeGitignoreLines("off")).toContain(".slop/transcripts/");
    expect(computeGitignoreLines("commit")).not.toContain(".slop/transcripts/");
  });

  it("always ignores the lock file and atomic-write temp-file globs, regardless of transcripts mode", () => {
    for (const mode of ["local", "off", "commit"] as const) {
      const lines = computeGitignoreLines(mode);
      expect(lines).toContain(".slop/db/.lock");
      expect(lines).toContain(".slop/db/.tmp-*");
      expect(lines).toContain(".slop/db/*/.tmp-*");
    }
  });

  it("the generated glob entries actually match a stray .lock and a stray tickets/.tmp-* left by a killed process", () => {
    const lines = computeGitignoreLines("local");

    // `.slop/db/.lock` — exact match, no globbing needed.
    expect(lines).toContain(".slop/db/.lock");

    // `.slop/db/.tmp-*` should match a temp file written directly in db/
    // (e.g. index.jsonc's own atomic write).
    const dbGlob = lines.find((l) => l === ".slop/db/.tmp-*");
    expect(dbGlob).toBeDefined();
    const dbGlobRegex = new RegExp(`^${dbGlob!.replace(/\*/g, ".*")}$`);
    expect(dbGlobRegex.test(".slop/db/.tmp-abc123-index.jsonc")).toBe(true);

    // `.slop/db/*/.tmp-*` should match a temp file left in a subdirectory
    // (tickets/sessions/events) next to its target.
    const subdirGlob = lines.find((l) => l === ".slop/db/*/.tmp-*");
    expect(subdirGlob).toBeDefined();
    const subdirGlobRegex = new RegExp(`^${subdirGlob!.replace(/\*/g, "[^/]*")}$`);
    expect(subdirGlobRegex.test(".slop/db/tickets/.tmp-abc-x.jsonc")).toBe(true);
    expect(subdirGlobRegex.test(".slop/db/sessions/.tmp-def-y.jsonc")).toBe(true);
  });
});

describe("upsertGitignoreSection", () => {
  it("inserts a fresh managed section into an empty file", () => {
    const { text, changed } = upsertGitignoreSection("", [".slop/db/index.jsonc"]);
    expect(changed).toBe(true);
    expect(text).toBe(
      "# --- slopworks (managed by `slop init`) ---\n.slop/db/index.jsonc\n# --- end slopworks ---\n",
    );
  });

  it("preserves pre-existing unrelated content, appending the managed section after it", () => {
    const existing = "node_modules/\n*.log\n";
    const { text } = upsertGitignoreSection(existing, [".slop/db/index.jsonc"]);
    expect(text).toBe(
      "node_modules/\n*.log\n\n# --- slopworks (managed by `slop init`) ---\n.slop/db/index.jsonc\n# --- end slopworks ---\n",
    );
  });

  it("is idempotent: applying the same lines twice produces the exact same text, no duplication", () => {
    const first = upsertGitignoreSection("node_modules/\n", [".slop/db/index.jsonc"]);
    const second = upsertGitignoreSection(first.text, [".slop/db/index.jsonc"]);
    expect(second.text).toBe(first.text);
    expect(second.changed).toBe(false);
    expect(second.text.match(/index\.jsonc/g)).toHaveLength(1);
  });

  it("regenerates the managed section when the lines change (e.g. transcripts: commit)", () => {
    const withTranscripts = upsertGitignoreSection("node_modules/\n", [
      ".slop/db/index.jsonc",
      ".slop/transcripts/",
    ]);
    const withoutTranscripts = upsertGitignoreSection(withTranscripts.text, [
      ".slop/db/index.jsonc",
    ]);
    expect(withoutTranscripts.text).not.toContain(".slop/transcripts/");
    expect(withoutTranscripts.text).toContain(".slop/db/index.jsonc");
    expect(withoutTranscripts.text.match(/index\.jsonc/g)).toHaveLength(1);
    expect(withoutTranscripts.changed).toBe(true);
  });

  it("preserves content on both sides of an existing managed section (it re-appends at the end, content is never dropped)", () => {
    const existing =
      "before/\n\n# --- slopworks (managed by `slop init`) ---\n.slop/db/index.jsonc\n# --- end slopworks ---\nafter/\n";
    const { text } = upsertGitignoreSection(existing, [".slop/db/index.jsonc"]);
    expect(text).toContain("before/");
    expect(text).toContain("after/");
    expect(text.match(/index\.jsonc/g)).toHaveLength(1);
    // Idempotent: applying the exact same lines a second time is a no-op.
    const second = upsertGitignoreSection(text, [".slop/db/index.jsonc"]);
    expect(second.text).toBe(text);
    expect(second.changed).toBe(false);
  });
});
