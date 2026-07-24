import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FixtureDataSource, isContainedPath } from "./fixture-data-source.js";

// web-path-traversal-transcript-ref-allows-arbitrary-local-fil:
// isContainedPath is the sole guard `openTranscript` relies on to stop a
// tampered/merged `transcript_ref` (a git-mergeable, collaborator-editable
// value — see fixture-data-source.ts's `openTranscript`) from reading a
// file outside the `.slop` root. It's exported specifically so this pure
// predicate can be exercised directly, with no filesystem or Bun-only API
// involved (this file runs under vitest, where Bun globals like `Bun.file`
// are not available — see tests/acceptance/D5.test.ts's header comment).
describe("isContainedPath", () => {
  const root = "/repo/project/.slop";

  it("allows a path strictly inside the root", () => {
    expect(isContainedPath(root, `${root}/transcripts/session_x.jsonl`)).toBe(true);
  });

  it("allows a nested path several directories deep", () => {
    expect(isContainedPath(root, `${root}/db/sessions/session_x.jsonc`)).toBe(true);
  });

  it("allows the root itself", () => {
    expect(isContainedPath(root, root)).toBe(true);
  });

  it("rejects a path that escapes one level up", () => {
    expect(isContainedPath(root, "/repo/project/escape.jsonl")).toBe(false);
  });

  it("rejects a path that escapes several levels up", () => {
    expect(isContainedPath(root, "/repo/escape.jsonl")).toBe(false);
  });

  it("rejects an unrelated absolute path entirely outside the root", () => {
    expect(isContainedPath(root, "/etc/passwd")).toBe(false);
  });

  it("rejects a sibling directory that merely shares the root as a string prefix", () => {
    // A naive `candidate.startsWith(root)` check would wrongly allow this
    // — ".slop-evil" string-starts-with ".slop" without a separator in
    // between. path.relative()-based containment must not make that
    // mistake.
    expect(isContainedPath(root, "/repo/project/.slop-evil/x")).toBe(false);
  });

  it("rejects a path that is a prefix of the root but not equal to it", () => {
    expect(isContainedPath(root, "/repo/project")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // End-to-end through the exact join()+resolve() pipeline openTranscript
  // uses, for the specific refs called out in the ticket.
  // -------------------------------------------------------------------------
  describe("through openTranscript's real join()+resolve() pipeline", () => {
    function resolvedCandidate(transcriptRef: string): string {
      return resolve(join(root, transcriptRef));
    }

    it("transcripts/session_x.jsonl (legitimate) is allowed", () => {
      expect(isContainedPath(resolve(root), resolvedCandidate("transcripts/session_x.jsonl"))).toBe(
        true,
      );
    });

    it("../../x escapes and is rejected", () => {
      expect(isContainedPath(resolve(root), resolvedCandidate("../../x"))).toBe(false);
    });

    it("transcripts/../../x escapes (via a .. segment buried mid-path) and is rejected", () => {
      expect(isContainedPath(resolve(root), resolvedCandidate("transcripts/../../x"))).toBe(false);
    });

    it("a bare .. escapes and is rejected", () => {
      expect(isContainedPath(resolve(root), resolvedCandidate(".."))).toBe(false);
    });

    // Notably NOT an escape through this pipeline: node's path.join()
    // concatenates rather than re-rooting on an absolute-looking second
    // argument (join("/root", "/etc/passwd") === "/root/etc/passwd", not
    // "/etc/passwd" — verified directly against node:path), so
    // `join(this.slopRoot, transcriptRef)` can never itself escape via a
    // leading "/". openTranscript still stays safe against a
    // leading-slash ref for that structural reason; sessionSchema
    // (src/core/entities/session.ts's transcriptRefSchema) separately
    // sanitises a leading "/" to null anyway, as defense in depth and
    // because it can never be a legitimate D5-convention ref.
    it("a leading-slash ref does not escape through join(), because join() concatenates rather than re-rooting", () => {
      expect(isContainedPath(resolve(root), resolvedCandidate("/etc/passwd"))).toBe(true);
    });
  });
});

// -------------------------------------------------------------------------
// The real `openTranscript` method itself, called with a raw ref string —
// not just the extracted predicate, and not routed through sessionSchema's
// own sanitisation (src/core/entities/session.ts's transcriptRefSchema).
// This is what proves the ticket's specific requirement that openTranscript
// "re-checks the resolved absolute path is a prefix of the resolved slop
// root before opening", independent of whatever validation ran upstream.
//
// Only the escaping-ref branch is exercised here: for an escaping ref,
// FixtureDataSource.openTranscript returns null from the containment check
// before ever calling `Bun.file(...)`, so this runs fine under vitest even
// though Bun globals aren't available there (see tests/acceptance/D5.test
// .ts's header comment) — a legitimate ref would need `Bun.file`, but this
// test deliberately never reaches that line.
describe("FixtureDataSource.openTranscript — escaping refs", () => {
  const ds = new FixtureDataSource("/repo/project/.slop");

  it.each([
    ["../../etc/passwd", "../../etc/passwd"],
    ["transcripts/../../escape.jsonl", "transcripts/../../escape.jsonl"],
    ["a bare ..", ".."],
  ])(
    "returns null for an escaping ref (%s), never touching the filesystem",
    async (_label, ref) => {
      await expect(ds.openTranscript(ref)).resolves.toBeNull();
    },
  );
});
