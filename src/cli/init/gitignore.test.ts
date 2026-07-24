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

  it("always ignores the .lock.stale-<token> sentinel glob, regardless of transcripts mode (regression: ticket housekeeping-gitignore-lock-stale)", () => {
    for (const mode of ["local", "off", "commit"] as const) {
      const lines = computeGitignoreLines(mode);
      expect(lines).toContain(".slop/db/.lock.stale-*");
    }
  });

  it("the .lock.stale-* glob actually matches lock.ts's own sentinel naming (tryBreakStaleLock: `${lockPath}.stale-${token}`)", () => {
    const glob = computeGitignoreLines("local").find((l) => l === ".slop/db/.lock.stale-*");
    if (glob === undefined) {
      throw new Error(
        "expected '.slop/db/.lock.stale-*' to be present in the generated gitignore lines",
      );
    }
    const regex = new RegExp(`^${glob.replace(/\*/g, ".*")}$`);
    expect(regex.test(".slop/db/.lock.stale-01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    // Must not accidentally also swallow the plain lock file under a
    // different rule's coverage assumption — both entries coexist.
    expect(regex.test(".slop/db/.lock")).toBe(false);
  });

  it("the generated glob entries actually match a stray .lock and a stray tickets/.tmp-* left by a killed process", () => {
    const lines = computeGitignoreLines("local");

    // `.slop/db/.lock` — exact match, no globbing needed.
    expect(lines).toContain(".slop/db/.lock");

    // `.slop/db/.tmp-*` should match a temp file written directly in db/
    // (e.g. index.jsonc's own atomic write).
    const dbGlob = lines.find((l) => l === ".slop/db/.tmp-*");
    if (dbGlob === undefined) {
      throw new Error("expected '.slop/db/.tmp-*' to be present in the generated gitignore lines");
    }
    const dbGlobRegex = new RegExp(`^${dbGlob.replace(/\*/g, ".*")}$`);
    expect(dbGlobRegex.test(".slop/db/.tmp-abc123-index.jsonc")).toBe(true);

    // `.slop/db/*/.tmp-*` should match a temp file left in a subdirectory
    // (tickets/sessions/events) next to its target.
    const subdirGlob = lines.find((l) => l === ".slop/db/*/.tmp-*");
    if (subdirGlob === undefined) {
      throw new Error(
        "expected '.slop/db/*/.tmp-*' to be present in the generated gitignore lines",
      );
    }
    const subdirGlobRegex = new RegExp(`^${subdirGlob.replace(/\*/g, "[^/]*")}$`);
    expect(subdirGlobRegex.test(".slop/db/tickets/.tmp-abc-x.jsonc")).toBe(true);
    expect(subdirGlobRegex.test(".slop/db/sessions/.tmp-def-y.jsonc")).toBe(true);
  });
});

describe("upsertGitignoreSection", () => {
  it("inserts a fresh managed section into an empty file", () => {
    const { text, changed } = upsertGitignoreSection("", [".slop/db/index.jsonc"]);
    expect(changed).toBe(true);
    expect(text).toBe(
      "# --- slopwork (managed by `slop init`) ---\n.slop/db/index.jsonc\n# --- end slopwork ---\n",
    );
  });

  it("preserves pre-existing unrelated content, appending the managed section after it", () => {
    const existing = "node_modules/\n*.log\n";
    const { text } = upsertGitignoreSection(existing, [".slop/db/index.jsonc"]);
    expect(text).toBe(
      "node_modules/\n*.log\n\n# --- slopwork (managed by `slop init`) ---\n.slop/db/index.jsonc\n# --- end slopwork ---\n",
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
      "before/\n\n# --- slopwork (managed by `slop init`) ---\n.slop/db/index.jsonc\n# --- end slopwork ---\nafter/\n";
    const { text } = upsertGitignoreSection(existing, [".slop/db/index.jsonc"]);
    expect(text).toContain("before/");
    expect(text).toContain("after/");
    expect(text.match(/index\.jsonc/g)).toHaveLength(1);
    // Idempotent: applying the exact same lines a second time is a no-op.
    const second = upsertGitignoreSection(text, [".slop/db/index.jsonc"]);
    expect(second.text).toBe(text);
    expect(second.changed).toBe(false);
  });

  // Windows portability: a CRLF `.gitignore` (native on Windows, or any
  // platform with `core.autocrlf=true`) split on a bare "\n" leaves a
  // trailing "\r" on every line, so SECTION_START/SECTION_END never match
  // and a re-run duplicates the managed section instead of replacing it.
  describe("tolerates a CRLF-line-ended .gitignore (Windows / core.autocrlf)", () => {
    it("recognizes an existing CRLF managed section and replaces it in place — no duplication", () => {
      const existingCrlf =
        "before/\r\n\r\n# --- slopwork (managed by `slop init`) ---\r\n" +
        ".slop/db/index.jsonc\r\n# --- end slopwork ---\r\nafter/\r\n";

      const { text, changed } = upsertGitignoreSection(existingCrlf, [".slop/db/index.jsonc"]);

      expect(changed).toBe(true);
      expect(text).toContain("before/");
      expect(text).toContain("after/");
      // Exactly one managed section — the CRLF one was found and replaced,
      // not left behind alongside a freshly-appended second copy.
      expect(text.match(/index\.jsonc/g)).toHaveLength(1);
      expect(text.match(/# --- slopwork/g)).toHaveLength(1);
    });

    it("re-running init against its own CRLF output is idempotent (no duplicate section)", () => {
      // First run against a CRLF file with NO prior managed section.
      const first = upsertGitignoreSection("node_modules/\r\n*.log\r\n", [".slop/db/index.jsonc"]);
      expect(first.text.match(/index\.jsonc/g)).toHaveLength(1);

      // Second run against the first run's own output (LF, per the
      // documented output normalization) must not duplicate anything.
      const second = upsertGitignoreSection(first.text, [".slop/db/index.jsonc"]);
      expect(second.changed).toBe(false);
      expect(second.text).toBe(first.text);
      expect(second.text.match(/index\.jsonc/g)).toHaveLength(1);
    });

    it("LF-only input behavior is completely unchanged (byte-for-byte) by the CRLF-tolerant split", () => {
      const existing = "node_modules/\n*.log\n";
      const { text, changed } = upsertGitignoreSection(existing, [".slop/db/index.jsonc"]);
      expect(changed).toBe(true);
      expect(text).toBe(
        "node_modules/\n*.log\n\n# --- slopwork (managed by `slop init`) ---\n.slop/db/index.jsonc\n# --- end slopwork ---\n",
      );
    });
  });
});
