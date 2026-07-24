/**
 * Generic `--budget N` (characters — see `CONTEXT_PACK_BUDGET_UNIT`,
 * re-exported from `src/sessions/context-budget.ts`) helpers shared by
 * every read command that can emit unbounded output (work item E1's
 * "every read respects budget" acceptance clause).
 *
 * ## The defect this module fixes
 *
 * B4's adversarial review found `slop ready --json --budget <tiny>` could
 * emit invalid (truncated mid-structure) JSON on a SUCCESS exit (0) — the
 * character-budget helper `src/sessions/context-budget.ts` built for prose
 * falls back to a raw string slice as its last resort, which is exactly
 * right for text (a truncated sentence is still valid text) but corrupts
 * JSON (a truncated `{"ready":[` is not parseable). That bug was deferred
 * to this work item; this module is the fix, generalised so every command
 * pairing `--json` with `--budget` shares ONE implementation of "never
 * corrupt JSON on a success exit" rather than each command growing its own
 * copy (and its own chance to get the edge case wrong).
 *
 * Two shapes of command need this:
 *
 *  - **List-shaped** output (`ready`'s combined ready+resumable rows,
 *    `search`'s ranked results, `events`' event page, `status`'s row
 *    sections): {@link renderEntriesWithBudget} elides whole entries from
 *    the tail (caller-ordered least-important-last) until the rendering
 *    fits; for `format: "json"`, the final fallback is the ALREADY-VALID
 *    zero-entries envelope (e.g. `{"ready":[],...}`) returned as-is —
 *    never a raw slice of it — even when that minimal envelope itself
 *    still exceeds `budgetChars` (an unavoidable floor: JSON syntax has a
 *    non-zero minimum size, so a budget of 0 or 1 characters can never
 *    truly be met by valid JSON; this is reported via `withinBudget:
 *    false`, not by breaking the JSON).
 *  - **Single-object-shaped** output (`context`'s pack, `show`'s ticket +
 *    tree + context): {@link renderJsonBodyWithBudget} takes an ordered
 *    ladder of candidate builders, most-complete first, each one a
 *    strictly-smaller-or-equal degradation of the last (e.g. "full pack" →
 *    "pack minus oldest session" → ... → "ticket core fields only"); the
 *    first candidate whose JSON serialization fits wins, and if none do,
 *    the LAST (guaranteed-minimal) candidate's valid JSON is returned as
 *    -is rather than sliced.
 *
 * Both share the same philosophy `sessions/context-budget.ts`'s prose
 * eliding already established (drop least-important content first, say
 * what was dropped, never silently exceed the budget when a valid
 * `budgetChars`-or-under result is achievable) — generalised here so it
 * also holds for `--json`, where "just slice the string" is not a safe
 * fallback the way it is for prose/text.
 */

/** The unit every `--budget N` flag in this CLI counts in. Originally
 * introduced (and named `CONTEXT_PACK_BUDGET_UNIT`) in
 * `sessions/context-budget.ts` for `slop context`/`slop start`'s pack;
 * moved here as E1 generalises `--budget` across every read command, with
 * that module re-exporting this constant under its original name so no
 * existing import site needed to change. */
export const BUDGET_UNIT = "characters";

export type RenderFormat = "text" | "json";

export interface BudgetedRender {
  text: string;
  /** Human-readable notes on what was dropped, in the order applied. Empty
   * iff nothing needed to change (already under budget, or no budget was
   * given at all). */
  elisions: string[];
  /** `true` iff `text.length <= budgetChars` — always `true` when
   * `budgetChars` is `undefined`. For `format: "json"`, can be `false` even
   * on a genuinely-minimal, always-VALID result: a budget too small for
   * even the empty envelope to fit is an unmeetable request, not a license
   * to emit corrupt JSON (see module doc). For `format: "text"`, a raw
   * slice always makes this `true` (a plain string can always be cut down
   * to exactly `budgetChars`, unlike JSON). */
  withinBudget: boolean;
}

/**
 * Bound a rendering of `entries` (already in elision-priority order —
 * least important LAST, the same convention `tickets/ready.ts`'s
 * `buildReadyEntries` documents) to `budgetChars` characters. `render(kept,
 * elisionNotes)` re-renders the FULL output (any format — this function is
 * format-agnostic about what `render` actually produces) for a candidate
 * prefix of `entries`; called repeatedly, dropping one more trailing entry
 * each time, until the result fits.
 *
 * `format` only changes what happens if EVEN ZERO entries doesn't fit
 * (module doc): `"text"` raw-slices the zero-entries rendering down to
 * exactly `budgetChars` (always possible, always still "valid" — there's
 * no text-syntax to protect); `"json"` returns the zero-entries rendering
 * AS-IS, never sliced, so the result is always parseable even though it
 * may exceed `budgetChars` for a pathologically tiny budget.
 */
export function renderEntriesWithBudget<T>(
  entries: readonly T[],
  render: (kept: readonly T[], elisionNotes: readonly string[]) => string,
  budgetChars: number | undefined,
  options: { format?: RenderFormat; noun?: string } = {},
): BudgetedRender {
  const format = options.format ?? "text";
  const noun = options.noun ?? "item";

  const full = render(entries, []);
  if (budgetChars === undefined || full.length <= budgetChars) {
    return { text: full, elisions: [], withinBudget: true };
  }

  for (let keep = entries.length - 1; keep >= 0; keep--) {
    const dropped = entries.length - keep;
    const notes = [
      `${dropped} lower-priority/less-relevant ${noun}(s) omitted to fit --budget (kept ${keep} of ${entries.length})`,
    ];
    const candidate = render(entries.slice(0, keep), notes);
    if (candidate.length <= budgetChars) {
      return { text: candidate, elisions: notes, withinBudget: true };
    }
  }

  const finalNotes =
    entries.length > 0 ? [`all ${entries.length} ${noun}(s) omitted to fit --budget`] : [];
  const zero = render([], finalNotes);
  if (zero.length <= budgetChars) {
    return { text: zero, elisions: finalNotes, withinBudget: true };
  }

  if (format === "json") {
    // Never corrupt JSON on what's otherwise a success path (module doc,
    // "the defect this module fixes"): the empty-entries envelope IS the
    // floor. A budget too small even for `{}`-shaped output to fit is an
    // unmeetable request, reported via `withinBudget: false` rather than
    // by truncating the structure.
    return { text: zero, elisions: finalNotes, withinBudget: false };
  }

  const rawSlice = budgetChars <= 0 ? "" : zero.slice(0, budgetChars);
  return { text: rawSlice, elisions: finalNotes, withinBudget: rawSlice.length <= budgetChars };
}

/**
 * Bound a SINGLE JSON-serializable object to `budgetChars` characters via
 * an explicit degradation ladder: `candidates`, most-complete first, each
 * one a valid, strictly-smaller-or-equal-in-spirit degradation of the
 * previous. The first candidate whose `JSON.stringify` fits `budgetChars`
 * wins; if none do, the LAST candidate (the caller's contract: this MUST
 * be the guaranteed-minimal, always-acceptable floor, e.g. `{id, slug}`
 * for a ticket) is returned as-is — valid JSON, possibly over budget,
 * never a corrupt slice. Mirrors {@link renderEntriesWithBudget}'s
 * JSON-format fallback for the "one object, not a list" shape `context`/
 * `show --json` need (module doc).
 */
export function renderJsonBodyWithBudget<T>(
  candidates: readonly (() => T)[],
  budgetChars: number | undefined,
): { body: T; text: string; withinBudget: boolean } {
  let lastBody: T | undefined;
  let lastText = "";
  for (const build of candidates) {
    const body = build();
    const text = `${JSON.stringify(body, null, 2)}\n`;
    if (budgetChars === undefined || text.length <= budgetChars) {
      return { body, text, withinBudget: true };
    }
    lastBody = body;
    lastText = text;
  }
  // Every candidate exceeded budgetChars (or `candidates` was somehow
  // empty, which every caller in this codebase avoids) — the last
  // (most-minimal) candidate's valid JSON, unsliced, is the floor.
  return { body: lastBody as T, text: lastText, withinBudget: false };
}
