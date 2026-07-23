/**
 * `--budget N` for the context pack (C1 brief: "context pack under
 * budget"; design.md §4.2 `slop context <ref>`, §5.2 "one command to full
 * context").
 *
 * **Unit: characters, not tokens.** `src/tickets/context.ts` (B1)'s own
 * `--budget` (wired into `slop show --context --budget`) treats `N` as a
 * *rough* token estimate (`budgetCharsFromTokens`, ~4 chars/token, no real
 * tokeniser) — an honestly-documented approximation, not a bug, but this
 * work item's brief is explicit: "if you claim tokens, you need a real
 * tokeniser — don't fake it." `slop context --budget N` (this module)
 * therefore treats `N` as a literal character count instead — exact,
 * verifiable, no estimate to be wrong about. **This is a real,
 * user-visible inconsistency between two `--budget` flags in the same CLI
 * today** (`show --context --budget 100` means "~400 chars"; `context
 * --budget 100` means "exactly 100 chars") — flagged here and in C1's
 * report for E1 ("generalise `--budget` across commands") to reconcile,
 * not silently glossed over.
 *
 * **Elision order** (least-important content dropped first, per the C1
 * brief: "degrade by truncating the least important sections first ...
 * rather than hard-cutting mid-structure, and say what was elided"):
 *   1. Oldest prior sessions, one at a time (`ContextPackData.sessions` is
 *      already most-recent-first per `tickets/context.ts`'s documented
 *      convention) — a session from three weeks ago is the least useful
 *      thing to keep when space is tight.
 *   2. The ticket's own `spec.details_md` — typically the longest single
 *      block of freeform prose — trimmed to the longest prefix that fits
 *      (found by binary search over the exact rendered length, so the
 *      result is never off-by-a-little the way a fixed-percentage cut
 *      would be).
 *   3. Last resort: a raw slice of our OWN already-elided text (core pack
 *      fields + our own elision notes, details_md already blanked) down to
 *      exactly `budgetChars`. Deliberately NOT `tickets/context.ts`'s own
 *      post-hoc `renderContextPack(data, budgetChars)`: that function's
 *      fixed-length truncation note (~32 chars) can't itself shrink below
 *      its own length, so for a `budgetChars` smaller than that it would
 *      silently return text LONGER than requested — see the code comment
 *      at this step for the full reasoning. A plain string slice has no
 *      such floor, so {@link renderContextPackWithBudget} always genuinely
 *      respects the budget, for every `budgetChars >= 0`, even one too
 *      small to fit any coherent structure at all.
 *
 * Every step that actually elided something appends a trailing "## Elided
 * for --budget" section naming what happened, so the reader always knows
 * content was dropped rather than silently getting a truncated-looking
 * pack with no explanation.
 *
 * **Reusable beyond C1**: E1 ("generalise `--budget` across commands")
 * should import {@link renderContextPackWithBudget} directly rather than
 * re-deriving this elision order per command — the only per-command work
 * left is building a `ContextPackData` (see `context-pack.ts`, also C1)
 * and passing it here.
 */
import type { Ticket } from "../core/index.js";
import type { ContextPackData } from "../tickets/context.js";
import { renderContextPack } from "../tickets/context.js";

/** The unit `--budget N` counts in for `slop context`/`slop start` — see
 * this module's doc for why this deliberately differs from `slop show
 * --context --budget`'s rough token estimate. */
export const CONTEXT_PACK_BUDGET_UNIT = "characters";

export interface BudgetedContextPack {
  text: string;
  /** Human-readable notes on what was dropped/shortened to fit, in the
   * order applied. Empty iff nothing needed to change (already under
   * budget, or no budget was given at all). */
  elisions: string[];
  /** `true` iff `text.length <= budgetChars` — always `true` when
   * `budgetChars` is `undefined`, and (by construction — see module doc)
   * always `true` even when a real budget forced elision. */
  withinBudget: boolean;
}

function elisionBlock(notes: readonly string[]): string {
  if (notes.length === 0) return "";
  return `\n\n## Elided for --budget (${CONTEXT_PACK_BUDGET_UNIT})\n${notes.map((n) => `  - ${n}`).join("\n")}`;
}

function sessionElisionNote(dropped: number, total: number): string {
  const kept = total - dropped;
  return kept > 0
    ? `${dropped} older session(s) omitted (kept ${kept} most recent of ${total})`
    : `all ${total} prior session(s) omitted`;
}

const DETAILS_ELIDED_NOTE = "ticket spec.details_md truncated";
const HARD_TRUNCATED_NOTE =
  "remaining content hard-truncated (budget too small for any full section)";

function withTruncatedDetails(ticket: Ticket, keepChars: number): Ticket {
  const details = ticket.spec.details_md;
  if (keepChars >= details.length) return ticket;
  const truncated = keepChars <= 0 ? "" : `${details.slice(0, keepChars)}…`;
  return { ...ticket, spec: { ...ticket.spec, details_md: truncated } };
}

/**
 * Render `data`'s context pack, honoring `budgetChars` for real (see
 * module doc for the elision order and the unit decision). Never throws.
 */
export function renderContextPackWithBudget(
  data: ContextPackData,
  budgetChars?: number,
): BudgetedContextPack {
  const full = renderContextPack(data);
  if (budgetChars === undefined || full.length <= budgetChars) {
    return { text: full, elisions: [], withinBudget: true };
  }

  const totalSessions = data.sessions.length;

  // Step 1: drop the oldest prior sessions, one at a time, until it fits
  // or none are left.
  for (let keep = totalSessions - 1; keep >= 0; keep--) {
    const dropped = totalSessions - keep;
    const notes = [sessionElisionNote(dropped, totalSessions)];
    const candidate =
      renderContextPack({ ...data, sessions: data.sessions.slice(0, keep) }) + elisionBlock(notes);
    if (candidate.length <= budgetChars) {
      return { text: candidate, elisions: notes, withinBudget: true };
    }
  }
  const carriedNotes = totalSessions > 0 ? [sessionElisionNote(totalSessions, totalSessions)] : [];
  const noSessions: ContextPackData = { ...data, sessions: [] };

  // Step 2: binary-search the longest `spec.details_md` prefix (with every
  // session already dropped) that still fits.
  const fullDetailsLen = data.ticket.spec.details_md.length;
  if (fullDetailsLen > 0) {
    let lo = 0;
    let hi = fullDetailsLen;
    let best: { text: string; elisions: string[] } | null = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const truncatedTicket = withTruncatedDetails(noSessions.ticket, mid);
      const notes = mid < fullDetailsLen ? [...carriedNotes, DETAILS_ELIDED_NOTE] : carriedNotes;
      const candidate =
        renderContextPack({ ...noSessions, ticket: truncatedTicket }) + elisionBlock(notes);
      if (candidate.length <= budgetChars) {
        best = { text: candidate, elisions: notes };
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best !== null) {
      return { text: best.text, elisions: best.elisions, withinBudget: true };
    }
  }

  // Step 3: last resort — drop details_md entirely, keep the (now short)
  // core pack plus our own elision notes.
  const finalNotes = [...carriedNotes, DETAILS_ELIDED_NOTE, HARD_TRUNCATED_NOTE];
  const blankDetails = withTruncatedDetails(noSessions.ticket, 0);
  const withoutHardTruncation =
    renderContextPack({ ...noSessions, ticket: blankDetails }) + elisionBlock(finalNotes);
  if (withoutHardTruncation.length <= budgetChars) {
    return { text: withoutHardTruncation, elisions: finalNotes, withinBudget: true };
  }

  // Still too big (a genuinely tiny budget). Deliberately NOT delegating to
  // tickets/context.ts's own `renderContextPack(data, budgetChars)` here:
  // that function's post-hoc truncation appends a FIXED-length note
  // ("… [truncated to fit --budget]", ~32 chars) and can't shrink below
  // that note's own length — for a `budgetChars` smaller than ~32 it would
  // silently return text LONGER than the requested budget, breaking the
  // "genuinely respects N, for every N >= 0" contract this function
  // promises. A raw slice of our own already-elided text never has that
  // problem: `s.slice(0, n).length` is always `<= n`, unconditionally,
  // even for `n === 0`. This is also strictly better content-wise: it's a
  // prefix of the SMART-elided pack (core fields + our own elision notes),
  // not an arbitrary cut through the original, un-elided pack.
  const rawSlice = budgetChars <= 0 ? "" : withoutHardTruncation.slice(0, budgetChars);
  return { text: rawSlice, elisions: finalNotes, withinBudget: rawSlice.length <= budgetChars };
}
