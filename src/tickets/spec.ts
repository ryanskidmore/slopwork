/**
 * Spec parsing (D10, design.md §4.1 item 1: "Specs = structured JSON,
 * markdown inside"). `new`/`update`'s `--spec -` (or `--spec <text>`)
 * accepts either: a JSON object matching {@link specSchema}, used
 * structurally, or bare markdown prose, which lands whole in
 * `details_md` — the "bare markdown -> details_md" clause of B1's
 * acceptance criterion.
 */
import type { Spec } from "../core/index.js";
import { specSchema } from "../core/index.js";

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

/**
 * Decide JSON-structural vs bare-markdown, per D10:
 *
 *   1. Try `JSON.parse(raw)`. If that throws, or the result isn't a plain
 *      object (arrays and bare JSON primitives — `"hello"`, `42`, `true`
 *      — are all valid JSON but not spec-shaped), `raw` is not
 *      JSON-structural at all: fall straight to the markdown path.
 *   2. Otherwise, merge `{ summary: <default from name> }` underneath the
 *      parsed object (so a JSON spec that omits `summary` still gets the
 *      same "defaults from name" treatment as the no-`--spec` case) and
 *      validate the result against {@link specSchema}. If it validates,
 *      that's the spec — used structurally, exactly as D10 asks.
 *   3. If it's a JSON object but DOESN'T validate against `specSchema`
 *      (wrong field types, unexpected shape, ...) — still not "matching
 *      the spec schema" — fall through to the markdown path too, with the
 *      original raw text (JSON and all) landing verbatim in `details_md`.
 *      This is a deliberate, honest fallback rather than a rejection: a
 *      human/agent typing free-form text that happens to start with `{`
 *      should never get a confusing schema-validation error for what was
 *      always meant as prose.
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
    const candidate = {
      summary: defaultSummaryFromName(name),
      ...(parsedJson as Record<string, unknown>),
    };
    const result = specSchema.safeParse(candidate);
    if (result.success) return result.data;
  }

  return specSchema.parse({ summary: defaultSummaryFromName(name), details_md: raw });
}
