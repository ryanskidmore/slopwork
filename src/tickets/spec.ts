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

/**
 * Build a spec whose `summary` is derived from `name`, validating the
 * result via `specSchema.safeParse` rather than a bare (throwing) `.parse`
 * — `raw-zoderrors-escape-as-exit`: `slop new ""` used to derive an EMPTY
 * `summary` from the blank name and let a raw `specSchema.parse` throw an
 * uncaught `ZodError` (a JSON issues array naming the internal `summary`
 * field, not the `name` the user actually typed) straight out of
 * `defaultSpec`, before `buildNewTicket`'s own `ticketSchema.safeParse`
 * ever got a chance to reject the blank `name` with a clean message.
 * Checked explicitly UP FRONT for the common case (a blank name — the
 * only way `summary`'s `min(1)` can fail here, since a `name` long enough
 * to blow `summary`'s 500-char cap is vanishingly unlikely but still
 * handled by the `safeParse` fallback below, never a raw throw either
 * way) — same "explicit check for the expected failure, safe fallback for
 * everything else" layering `tickets/split.ts`'s own blank-name guard
 * uses.
 */
function specFromNameDerivedSummary(name: string, extra: Record<string, unknown> = {}): Spec {
  const summary = defaultSummaryFromName(name);
  if (summary.length === 0) {
    throw new SlopError("ticket name must be non-blank", EXIT_CODES.USAGE_ERROR);
  }
  const result = specSchema.safeParse({ summary, ...extra });
  if (!result.success) {
    throw new SlopError(
      formatZodIssuesForUsage("invalid ticket name", result.error),
      EXIT_CODES.USAGE_ERROR,
    );
  }
  return result.data;
}

/** The spec `new` builds when `--spec` is omitted entirely. */
export function defaultSpec(name: string): Spec {
  return specFromNameDerivedSummary(name);
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

  return specFromNameDerivedSummary(name, { details_md: raw });
}

/**
 * First-class `--summary`/`--details`/`--acceptance`/`--context` flags
 * (as opposed to hand-assembled `--spec <json>`) — the structured
 * alternative onboarding's house rules already ask for ("put acceptance
 * criteria in `acceptance[]` and file/URL pointers in `context[]`, not
 * buried in prose") without making every agent hand-serialize JSON in a
 * shell arg (quoting hazards) or risk the unknown-key trap `--spec` now
 * hard-errors on. `acceptance`/`context` default to `[]` (Commander's
 * `collect` default for a repeatable flag), never `undefined` — same
 * convention `--label`/`--blocks` already use.
 */
export interface SpecFieldOverrides {
  summary?: string;
  details?: string;
  acceptance: string[];
  context: string[];
}

/** `true` iff at least one structured field flag was actually given. */
export function hasSpecFieldOverrides(overrides: SpecFieldOverrides): boolean {
  return (
    overrides.summary !== undefined ||
    overrides.details !== undefined ||
    overrides.acceptance.length > 0 ||
    overrides.context.length > 0
  );
}

/**
 * Overlay whichever structured field flags were given on top of `base` —
 * `defaultSpec(name)` for `new` (nothing existing to preserve, so an
 * omitted flag falls back to the schema's own default, e.g. `summary`
 * from the name), or `current.spec` for `update` (an omitted flag keeps
 * today's value, the same "say what changes, the rest stays" convention
 * `update`'s other field flags — `--priority`/`--name`/`--label` — already
 * use, deliberately NOT `--spec`'s whole-blob-replace semantics). Only
 * `summary`/`details_md` are overlaid scalar-wise; `acceptance`/`context`
 * are overlaid as a whole array (given at all -> replaces; omitted ->
 * `base`'s array, unchanged) — there is no per-entry add/remove sigil here,
 * unlike `--label`.
 */
export function applySpecFieldOverrides(base: Spec, overrides: SpecFieldOverrides): Spec {
  const candidate = {
    ...base,
    summary: overrides.summary ?? base.summary,
    details_md: overrides.details ?? base.details_md,
    acceptance: overrides.acceptance.length > 0 ? overrides.acceptance : base.acceptance,
    context: overrides.context.length > 0 ? overrides.context : base.context,
  };
  const result = specSchema.safeParse(candidate);
  if (!result.success) {
    throw new SlopError(
      formatZodIssuesForUsage("invalid spec field(s)", result.error),
      EXIT_CODES.USAGE_ERROR,
    );
  }
  return result.data;
}
