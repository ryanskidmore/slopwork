import { describe, expect, it } from "vitest";
import {
  AUTO_SLUG_MAX_CHARS,
  AUTO_SLUG_MAX_WORDS,
  SLUG_PATTERN,
  nextAvailableSlug,
  parseExplicitSlug,
  slugSchema,
  slugify,
} from "./slug.js";

describe("slugify", () => {
  it("lowercases and hyphenates a plain name", () => {
    expect(slugify("Adding new auth provider")).toBe("adding-new-auth-provider");
  });

  it("folds diacritics to their base ASCII letter", () => {
    expect(slugify("Café résumé")).toBe("cafe-resume");
  });

  it("collapses punctuation and repeated separators into single hyphens", () => {
    expect(slugify("Fix bug:  null   pointer!!  (again)")).toBe("fix-bug-null-pointer-again");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  --weird name--  ")).toBe("weird-name");
  });

  it("drops non-ASCII scripts and emoji entirely", () => {
    expect(slugify("日本語 emoji 🎉 title")).toBe("emoji-title");
  });

  it("falls back to a placeholder when nothing survives", () => {
    expect(slugify("🎉🎉🎉")).toBe("ticket");
    expect(slugify("日本語")).toBe("ticket");
    expect(slugify("!!!")).toBe("ticket");
  });

  it("caps length and never leaves a dangling trailing hyphen from the cut", () => {
    const long = "word ".repeat(40).trim();
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("always produces something matching slugSchema", () => {
    for (const name of ["", "   ", "A", "already-a-slug", "MiXeD Case 123"]) {
      const slug = slugify(name);
      expect(
        slugSchema.safeParse(slug).success,
        `slugify(${JSON.stringify(name)}) -> ${slug}`,
      ).toBe(true);
      expect(SLUG_PATTERN.test(slug)).toBe(true);
    }
  });
});

// D12: auto-slug shortened to a word-boundary-truncated, ~5-word/~40-char
// cap (AUTO_SLUG_MAX_WORDS/AUTO_SLUG_MAX_CHARS) instead of the old
// mid-word ~60-char cut. KEY CONSTRAINT the whole revision hinges on:
// a name that already fits under the new cap must slugify to EXACTLY what
// it did before this change — only a name long enough to need shortening
// is allowed to come out different.
describe("slugify — D12 short, branch-style auto-slug", () => {
  it("already-short names are byte-identical to the pre-D12 generator (a handful of known cases)", () => {
    // Every one of these was already <= AUTO_SLUG_MAX_CHARS (and none of
    // them needed the old 60-char cut either), so nothing about this
    // revision may touch their output.
    expect(slugify("Adding new auth provider")).toBe("adding-new-auth-provider");
    expect(slugify("Add auth provider")).toBe("add-auth-provider");
    expect(slugify("Fix bug:  null   pointer!!  (again)")).toBe("fix-bug-null-pointer-again");
    expect(slugify("Same name")).toBe("same-name");
    expect(slugify("Ticket")).toBe("ticket");
    expect(slugify("x")).toBe("x");
  });

  it("a many-word name whose full form still fits AUTO_SLUG_MAX_CHARS is untouched, even past AUTO_SLUG_MAX_WORDS", () => {
    // 8 short words, 15 chars — well under the 40-char cap, so the char
    // cap (not an independent word-count cap) is what gates truncation;
    // this must NOT come out shortened to 5 words.
    const slug = slugify("a b c d e f g h");
    expect(slug).toBe("a-b-c-d-e-f-g-h");
    expect(slug.split("-").length).toBe(8);
  });

  it("a long, many-word name is truncated at a word boundary — never mid-word", () => {
    const long = "Refactor the entire authentication and authorization subsystem for v2 rollout";
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(AUTO_SLUG_MAX_CHARS);
    expect(slug.split("-").length).toBeLessThanOrEqual(AUTO_SLUG_MAX_WORDS);
    expect(slug.endsWith("-")).toBe(false);
    // Every word boundary in the output is a genuine prefix of the full
    // (untruncated) word sequence — i.e. the cut landed exactly on a "-",
    // never inside a word.
    const fullWords =
      "refactor-the-entire-authentication-and-authorization-subsystem-for-v2-rollout".split("-");
    expect(slug).toBe(fullWords.slice(0, slug.split("-").length).join("-"));
  });

  it("caps a long name to at most AUTO_SLUG_MAX_WORDS words, well short of the old 60-char cut", () => {
    const long = "word ".repeat(40).trim();
    const slug = slugify(long);
    expect(slug).toBe("word-word-word-word-word");
    expect(slug.split("-").length).toBe(AUTO_SLUG_MAX_WORDS);
    expect(slug.length).toBeLessThan(60);
  });

  it("a single unbroken over-cap word (no boundary to cut at) still gets a hard, bounded cut", () => {
    const slug = slugify("x".repeat(80));
    expect(slug.length).toBe(AUTO_SLUG_MAX_CHARS);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("parseExplicitSlug — D12 explicit `slop new --slug`", () => {
  it("accepts a bare hyphenated handle unchanged", () => {
    expect(parseExplicitSlug("ui-not-showing")).toBe("ui-not-showing");
  });

  it("accepts and lowercases a single type/ prefix", () => {
    expect(parseExplicitSlug("fix/ui-not-showing")).toBe("fix/ui-not-showing");
    expect(parseExplicitSlug("FEAT/Add-Auth")).toBe("feat/add-auth");
  });

  it("trims surrounding whitespace", () => {
    expect(parseExplicitSlug("  fix/ui-not-showing  ")).toBe("fix/ui-not-showing");
  });

  it("rejects an empty or whitespace-only slug", () => {
    expect(() => parseExplicitSlug("")).toThrow();
    expect(() => parseExplicitSlug("   ")).toThrow();
  });

  it("rejects a slug with more than one type/ prefix", () => {
    expect(() => parseExplicitSlug("a/b/c")).toThrow();
  });

  it("rejects leading/trailing separators", () => {
    expect(() => parseExplicitSlug("/leading")).toThrow();
    expect(() => parseExplicitSlug("trailing/")).toThrow();
    expect(() => parseExplicitSlug("-leading")).toThrow();
    expect(() => parseExplicitSlug("trailing-")).toThrow();
  });

  it("rejects disallowed characters (spaces, underscores, punctuation)", () => {
    expect(() => parseExplicitSlug("bad slug")).toThrow();
    expect(() => parseExplicitSlug("bad_slug")).toThrow();
    expect(() => parseExplicitSlug("bad!slug")).toThrow();
  });

  it("rejects a slug over SLUG_MAX_LENGTH", () => {
    expect(() => parseExplicitSlug("a".repeat(70))).toThrow();
  });

  it("every accepted result matches slugSchema (so it round-trips through ticketSchema unchanged)", () => {
    for (const raw of ["ui-not-showing", "fix/ui-not-showing", "FEAT/Add-Auth"]) {
      const slug = parseExplicitSlug(raw);
      expect(slugSchema.safeParse(slug).success, `parseExplicitSlug(${raw}) -> ${slug}`).toBe(true);
    }
  });
});

describe("nextAvailableSlug", () => {
  it("returns the base slug unchanged when it's free", () => {
    expect(nextAvailableSlug("auth-provider", new Set())).toBe("auth-provider");
  });

  it("appends -2 when the base is taken", () => {
    expect(nextAvailableSlug("auth-provider", new Set(["auth-provider"]))).toBe("auth-provider-2");
  });

  it("keeps incrementing past multiple collisions", () => {
    const taken = new Set(["x", "x-2", "x-3", "x-4"]);
    expect(nextAvailableSlug("x", taken)).toBe("x-5");
  });

  it("doesn't get confused by an available slug that merely looks like a suffix of another", () => {
    const taken = new Set(["x", "x-2"]);
    // "x-2b" isn't in the taken set so a base of "x-2b" should pass through untouched.
    expect(nextAvailableSlug("x-2b", taken)).toBe("x-2b");
  });
});
