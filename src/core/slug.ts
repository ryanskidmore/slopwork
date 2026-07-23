/**
 * Slugs (D12: "Slugs are first-class handles everywhere ids work").
 */
import { z } from "zod";

export const SLUG_MAX_LENGTH = 60;
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * A little longer than {@link SLUG_MAX_LENGTH} so a base slug plus a
 * `nextAvailableSlug` collision suffix (`-2`, `-3`, ...) still validates.
 * Kept permissive on purpose: renamed/legacy slugs (design.md §8.2 item 2,
 * "leaning yes" to keep old slugs resolving) are still produced by this
 * same generator, so the format constraint never needs to change shape
 * over a ticket's lifetime, only which slug is "current".
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(SLUG_MAX_LENGTH + 8)
  .regex(SLUG_PATTERN, "expected a lowercase, hyphenated slug");
export type Slug = z.infer<typeof slugSchema>;

const COMBINING_DIACRITICS = /[\u0300-\u036f]/g;
// Every UTF-16 code unit from U+0080 up (covers both halves of an astral
// surrogate pair too), written as a positive range rather than the more
// obvious `[^\x00-\x7F]`: that negated form references the \x00-\x1F
// control-character range, which biome's noControlCharactersInRegex flags.
const NON_ASCII = /[\u0080-\uffff]/g;

/**
 * Derive a slug from a ticket name: Unicode-normalize and strip
 * diacritics, drop anything left outside ASCII, lowercase, collapse every
 * run of non `[a-z0-9]` characters into a single hyphen, trim leading and
 * trailing hyphens, and cap the length. Falls back to a fixed placeholder
 * if nothing survives (e.g. a name that is entirely emoji, CJK, or
 * punctuation) — a slug field must never be empty.
 */
export function slugify(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(COMBINING_DIACRITICS, "") // combining diacritical marks left after NFKD
    .replace(NON_ASCII, ""); // anything else non-ASCII (emoji, CJK, ...)

  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, ""); // slicing mid-word can leave a trailing hyphen

  return slug.length > 0 ? slug : "ticket";
}

/**
 * B1's collision rule: if `base` is free, use it; otherwise append `-2`,
 * `-3`, ... until an unused slug is found. A2 supplies this pure rule;
 * A3/B1 supply the real "taken" set (every slug already on disk).
 */
export function nextAvailableSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix++;
  }
  return `${base}-${suffix}`;
}
