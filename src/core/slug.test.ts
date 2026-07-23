import { describe, expect, it } from "vitest";
import { SLUG_PATTERN, nextAvailableSlug, slugSchema, slugify } from "./slug.js";

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
