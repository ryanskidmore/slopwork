/**
 * Slugs (D12: "Slugs are first-class handles everywhere ids work" — short,
 * branch-style handles).
 */
import { z } from "zod";

export const SLUG_MAX_LENGTH = 60;

/** One hyphenated word-run: lowercase alnum, internal hyphens, no
 * leading/trailing/doubled hyphen. The shared building block for both
 * halves of {@link SLUG_PATTERN}. */
const SLUG_SEGMENT = "[a-z0-9]+(?:-[a-z0-9]+)*";

/**
 * A bare hyphenated slug (`add-auth-provider`, still what every
 * auto-generated slug looks like — `slugify` below never emits a `/`), OR
 * that same shape with a single leading `<type>/` prefix segment
 * (`fix/ui-not-showing`, `feat/add-auth` — branch-style, D12) for an
 * explicit `slop new --slug` handle. Exactly one `/` is ever allowed, and
 * it may not lead, trail, or sit next to another `/` or `-` — both sides
 * of it are full {@link SLUG_SEGMENT}s. Strictly additive to the old
 * bare-slug-only pattern: anything that matched before still matches.
 */
export const SLUG_PATTERN = new RegExp(`^${SLUG_SEGMENT}(?:/${SLUG_SEGMENT})?$`);

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
  .regex(
    SLUG_PATTERN,
    "expected a lowercase, hyphenated slug, optionally with a single type/ prefix",
  );
export type Slug = z.infer<typeof slugSchema>;

const COMBINING_DIACRITICS = /[\u0300-\u036f]/g;
// Every UTF-16 code unit from U+0080 up (covers both halves of an astral
// surrogate pair too), written as a positive range rather than the more
// obvious `[^\x00-\x7F]`: that negated form references the \x00-\x1F
// control-character range, which biome's noControlCharactersInRegex flags.
const NON_ASCII = /[\u0080-\uffff]/g;

/**
 * Auto-slug word-boundary cap (D12: short, branch-style handles). An
 * over-cap name is truncated to at most this many words — never mid-word
 * — as long as that also fits within {@link AUTO_SLUG_MAX_CHARS}.
 */
export const AUTO_SLUG_MAX_WORDS = 5;

/**
 * Auto-slug character cap — deliberately well under {@link SLUG_MAX_LENGTH}
 * (that ceiling still governs the *schema*, including an explicit `--slug`
 * or a `nextAvailableSlug` collision suffix; this one governs what
 * `slugify` itself produces for a name that needs shortening).
 *
 * KEY CONSTRAINT: a name whose full slugified form already fits within
 * this cap is returned untouched — byte-identical to the pre-D12
 * generator, which only ever cut at {@link SLUG_MAX_LENGTH} (60). Only a
 * name whose full form is LONGER than this cap is affected at all, so
 * every already-short name's slug is unchanged by this revision.
 */
export const AUTO_SLUG_MAX_CHARS = 40;

/**
 * Cut `full` (an already hyphenated, already-over-cap slug) down to at
 * most {@link AUTO_SLUG_MAX_WORDS} words without ever splitting a word —
 * take whole `-`-separated words until the next one would either exceed
 * {@link AUTO_SLUG_MAX_CHARS} or the word-count cap, then stop. The one
 * exception is a single leading word that alone exceeds the char cap
 * (pathological: one giant unbroken "word"), which still needs a hard
 * character cut to stay bounded — the old mid-word-cut behavior, but only
 * ever reached in that one no-word-boundary-available case.
 */
function truncateAtWordBoundary(full: string): string {
  const words = full.split("-");
  let result = "";
  let wordCount = 0;
  for (const word of words) {
    if (wordCount >= AUTO_SLUG_MAX_WORDS) break;
    const candidate = result.length === 0 ? word : `${result}-${word}`;
    if (candidate.length > AUTO_SLUG_MAX_CHARS) {
      if (result.length === 0) {
        return word.slice(0, AUTO_SLUG_MAX_CHARS).replace(/-+$/, "");
      }
      break;
    }
    result = candidate;
    wordCount++;
  }
  return result;
}

/**
 * Derive a slug from a ticket name: Unicode-normalize and strip
 * diacritics, drop anything left outside ASCII, lowercase, collapse every
 * run of non `[a-z0-9]` characters into a single hyphen, and trim leading
 * and trailing hyphens. A name that's still over {@link AUTO_SLUG_MAX_CHARS}
 * after that is then truncated at a word boundary (never mid-word) to at
 * most {@link AUTO_SLUG_MAX_WORDS} words / {@link AUTO_SLUG_MAX_CHARS}
 * characters — see {@link truncateAtWordBoundary}. Falls back to a fixed
 * placeholder if nothing survives (e.g. a name that is entirely emoji,
 * CJK, or punctuation) — a slug field must never be empty.
 */
export function slugify(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(COMBINING_DIACRITICS, "") // combining diacritical marks left after NFKD
    .replace(NON_ASCII, ""); // anything else non-ASCII (emoji, CJK, ...)

  const full = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const slug = full.length <= AUTO_SLUG_MAX_CHARS ? full : truncateAtWordBoundary(full);

  return slug.length > 0 ? slug : "ticket";
}

/**
 * Validate and normalize a user-supplied `--slug` value (`slop new --slug
 * fix/ui-not-showing`) into the form that gets stored: lowercased, then
 * checked against {@link SLUG_PATTERN}/{@link SLUG_MAX_LENGTH} — a bare
 * hyphenated handle, optionally with a single leading `<type>/` prefix
 * segment, no leading/trailing/repeated separators. Unlike `slugify`, this
 * never mangles its input into something valid: an explicit slug is
 * expected to already look like one, so anything that doesn't match is
 * rejected outright rather than silently reshaped.
 *
 * Throws a plain `Error` naming exactly what's wrong (core/'s convention
 * for user-input parsing — see duration.ts's `parseDurationMs`); callers
 * translate this into a `SlopError` USAGE_ERROR (exit 2), same as any
 * other bad flag.
 */
export function parseExplicitSlug(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new Error("--slug must not be empty");
  }
  if (trimmed.length > SLUG_MAX_LENGTH) {
    throw new Error(`--slug "${raw}" is too long (max ${SLUG_MAX_LENGTH} characters)`);
  }
  if (!SLUG_PATTERN.test(trimmed)) {
    throw new Error(
      `--slug "${raw}" is invalid: expected a lowercase, hyphenated handle ` +
        '(e.g. "ui-not-showing"), optionally with a single "<type>/" prefix ' +
        '(e.g. "fix/ui-not-showing"); no leading/trailing/repeated separators',
    );
  }
  return trimmed;
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
