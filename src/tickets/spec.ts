/**
 * Spec parsing (D10, design.md §4.1 item 1: "Specs = structured JSON,
 * markdown inside"). `new`/`update`'s `--spec -` (or `--spec <text>`)
 * accepts either: a JSON object matching {@link specSchema}, used
 * structurally, or bare markdown prose, which lands whole in
 * `details_md` — the "bare markdown -> details_md" clause of B1's
 * acceptance criterion.
 */
import type { Spec } from "../core/index.js";
import { EXIT_CODES, specSchema } from "../core/index.js";
import { SlopError } from "../cli/errors.js";
import { formatZodIssuesForUsage } from "./validate.js";

/** `summary` defaults sensibly from the ticket name (B1 brief) — the name
 * is already schema-bounded to 300 chars, comfortably under `summary`'s
 * 500-char cap, so no truncation is ever needed here. */
export function defaultSummaryFromName(name: string): string {
  return name.trim();
}

/** The spec `new` builds when `--spec` is omitted entirely. */
export function defaultSpec(name: string): Spec {
  return specSchema.parse({ summary: defaultSummaryFromName(name) });
}

/** The complete set of top-level keys `specSchema` knows about. Every field
 * on the schema is optional/defaulted, which means `specSchema.safeParse`
 * would otherwise happily strip any *unknown* key (e.g. a typo'd `details`
 * meant as `details_md`) and still succeed — silently discarding whatever
 * prose lived under it. Keys are checked against this set *before* handing
 * the candidate to zod, so that case is caught up front instead of sliding
 * through as a false "validated" success. */
const SPEC_SCHEMA_KEYS = new Set(Object.keys(specSchema.shape));

/**
 * Decide JSON-structural vs bare-markdown, per D10:
 *
 *   1. Try `JSON.parse(raw)`. If that throws, or the result isn't a plain
 *      object (arrays and bare JSON primitives — `"hello"`, `42`, `true`
 *      — are all valid JSON but not spec-shaped), `raw` is not
 *      JSON-structural at all: fall straight to the markdown path, with
 *      `raw` landing whole in `details_md` — unchanged, still a
 *      deliberate, honest fallback: free-form prose that merely happens
 *      not to parse as JSON was never meant structurally.
 *   2. If it IS a plain object, it was clearly *meant* as a structured
 *      spec (D10: "Specs = structured JSON"), so from here on a failure
 *      to match {@link specSchema} is a hard error, not a silent
 *      degrade-to-prose: this review's own first ticket lost content this
 *      way (a typo'd key quietly became the whole `details_md`, no
 *      warning, exit 0). Two sub-cases, both a `SlopError` USAGE_ERROR
 *      (exit 2) naming the offending key/issue:
 *        a. any top-level key outside {@link SPEC_SCHEMA_KEYS} (`summary`,
 *           `details_md`, `acceptance`, `context`, `meta`, `v`) — reported
 *           by name rather than let `specSchema.safeParse` silently strip
 *           it and default the rest;
 *        b. a known-keys-only object that still fails `specSchema` (wrong
 *           field types, out-of-range values, ...) — reported via
 *           {@link formatZodIssuesForUsage} so the message names the exact
 *           field/issue instead of a raw `ZodError` dump.
 *   3. Otherwise (only known keys, and it validates), merge
 *      `{ summary: <default from name> }` underneath the parsed object (so
 *      a JSON spec that omits `summary` still gets the same "defaults from
 *      name" treatment as the no-`--spec` case) and return the validated
 *      spec — used structurally, exactly as D10 asks.
 */
export function parseSpecInput(raw: string, name: string): Spec {
  let parsedJson: unknown;
  let isJsonObject = false;
  try {
    parsedJson = JSON.parse(raw);
    isJsonObject =
      typeof parsedJson === "object" && parsedJson !== null && !Array.isArray(parsedJson);
  } catch {
    isJsonObject = false;
  }

  if (isJsonObject) {
    const parsedObject = parsedJson as Record<string, unknown>;
    const unknownKeys = Object.keys(parsedObject).filter((key) => !SPEC_SCHEMA_KEYS.has(key));
    if (unknownKeys.length > 0) {
      throw new SlopError(
        `--spec: unknown key(s) ${unknownKeys.map((k) => `"${k}"`).join(", ")} — known spec ` +
          `keys are ${Array.from(SPEC_SCHEMA_KEYS).join(", ")}. If this was meant as free-form ` +
          `prose, it can't start with "{"/parse as a JSON object.`,
        EXIT_CODES.USAGE_ERROR,
      );
    }

    const candidate = { summary: defaultSummaryFromName(name), ...parsedObject };
    const result = specSchema.safeParse(candidate);
    if (!result.success) {
      throw new SlopError(
        formatZodIssuesForUsage("--spec: invalid spec JSON", result.error),
        EXIT_CODES.USAGE_ERROR,
      );
    }
    return result.data;
  }

  return specSchema.parse({ summary: defaultSummaryFromName(name), details_md: raw });
}
