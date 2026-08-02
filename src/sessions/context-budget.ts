/**
 * `--budget N` for the context pack (C1 brief: "context pack under
 * budget"; design.md §4.2 `slop context <ref>`, §5.2 "one command to full
 * context").
 *
 * **Unit: characters, exactly** — `core/budget.ts`'s `BUDGET_UNIT`
 * (re-exported here as {@link CONTEXT_PACK_BUDGET_UNIT} for call-site
 * continuity), the ONE unit every `--budget`-taking command in this CLI
 * documents and enforces: `ready`, `search`, `status`, `events`, `context`,
 * and `show --context`. Every command's parser also shares one
 * implementation — `src/cli/commands/shared.ts`'s `parseBudgetOption` —
 * so a negative `--budget` is rejected (`USAGE_ERROR`, exit 2) the same
 * way everywhere.
 *
 * **G5 (t-5vj9o) simplification**: this module used to hand-roll its own
 * elision ladder (drop oldest sessions one at a time, then binary-search
 * the longest `spec.details_md` prefix that fits, then a raw slice) —
 * the exact kind of bespoke, individually-documented degradation strategy
 * the "simplification sweep" audit flagged for six-plus commands. It now
 * reduces the context pack to a plain list of droppable pieces and hands
 * that straight to `core/budget.ts`'s {@link renderEntriesWithBudget} —
 * the SAME generic cap-and-report helper `ready`/`search`/`status`/
 * `events`/`list`/`questions` already use. The pieces, most-important
 * first (so the generic "drop from the tail" strategy removes the least
 * useful content first):
 *
 *   1. `spec.details_md` + ancestry + blockers — kept as one atomic
 *      "extras" tier, dropped as a whole rather than partially truncated
 *      (the old binary search bought precision the audit judged not worth
 *      the complexity — a whole-or-nothing drop is simpler and still
 *      "say what was elided").
 *   2. Prior sessions, newest first (`ContextPackData.sessions` is already
 *      most-recent-first) — dropped from the tail, i.e. oldest first, one
 *      at a time.
 *
 * Both {@link renderContextPackWithBudget} (text) and
 * {@link renderContextPackJsonWithBudget} (`--json`) share this one
 * entries list and one elision order — only the final "can't shrink any
 * further" floor differs, and only because text and JSON differ in what a
 * safe last resort even IS (module doc on `core/budget.ts`): a raw
 * character slice is always valid text, but never safely valid JSON, so
 * the JSON floor is the already-valid zero-entries envelope instead.
 *
 * **Reused across every read command**: `ready`/`search`/`status`/
 * `events`/`list`/`questions` build on `core/budget.ts`'s list-shaped
 * `renderEntriesWithBudget` directly; `context`/`show --context` do the
 * same, just with the context pack's own pieces as the "entries" — the
 * only per-command work left is building a `ContextPackData` (see
 * `context-pack.ts`, also C1) and describing what its droppable pieces are.
 */
import type { Session, Ticket } from "../core/index.js";
import {
  BUDGET_UNIT as CONTEXT_PACK_BUDGET_UNIT,
  renderEntriesWithBudget,
} from "../core/budget.js";
import type { ContextPackData } from "../tickets/context.js";
import { renderContextPack } from "../tickets/context.js";
import { jiraBrowseUrl } from "../tickets/jira.js";

/** The unit `--budget N` counts in for `slop context`/`slop start` — see
 * this module's doc. Re-exported under this historical name (rather than
 * making every existing caller switch to importing `BUDGET_UNIT` from
 * `core/budget.ts` directly) purely for call-site continuity —
 * `core/budget.ts` owns the single canonical constant. */
export { CONTEXT_PACK_BUDGET_UNIT };

export interface BudgetedContextPack {
  text: string;
  /** Human-readable notes on what was dropped to fit, in the order
   * applied. Empty iff nothing needed to change (already under budget, or
   * no budget was given at all). */
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

/**
 * The context pack's droppable pieces, most-important first (see module
 * doc): the "extras" tier (spec prose + ancestry + blockers, dropped as
 * one whole) always comes first — it survives every session being
 * dropped — followed by each prior session, already most-recent-first, so
 * dropping from the tail removes the oldest session first.
 */
type ContextEntry = { kind: "extras" } | { kind: "session"; session: Session };

function contextEntries(data: ContextPackData): ContextEntry[] {
  return [
    { kind: "extras" },
    ...data.sessions.map((session): ContextEntry => ({ kind: "session", session })),
  ];
}

/** Rebuild `data` restricted to whichever pieces `kept` still names —
 * dropping the "extras" tier clears `spec.details_md` and empties
 * `ancestors`/`blockers` together (module doc: one atomic tier, not a
 * partial truncation). */
function dataForKeptEntries(data: ContextPackData, kept: readonly ContextEntry[]): ContextPackData {
  const keepExtras = kept.some((e) => e.kind === "extras");
  const sessions = kept
    .filter((e): e is Extract<ContextEntry, { kind: "session" }> => e.kind === "session")
    .map((e) => e.session);
  if (keepExtras) return { ...data, sessions };
  const blankTicket: Ticket = { ...data.ticket, spec: { ...data.ticket.spec, details_md: "" } };
  return { ...data, ticket: blankTicket, ancestors: [], blockers: [], sessions };
}

/**
 * Render `data`'s context pack, honoring `budgetChars` for real (see
 * module doc for the elision order and the unit decision). Never throws.
 */
export function renderContextPackWithBudget(
  data: ContextPackData,
  budgetChars?: number,
): BudgetedContextPack {
  const entries = contextEntries(data);
  const rendered = renderEntriesWithBudget(
    entries,
    (kept, elisions) => renderContextPack(dataForKeptEntries(data, kept)) + elisionBlock(elisions),
    budgetChars,
    { format: "text", noun: "context section" },
  );
  return {
    text: rendered.text,
    elisions: [...rendered.elisions],
    withinBudget: rendered.withinBudget,
  };
}

// ---------------------------------------------------------------------------
// `--json` (E1): a structured form of the same pack, budget-aware without
// ever corrupting JSON — see core/budget.ts's module doc, "The defect this
// module fixes". Used by both `slop context --json` and `slop show
// --context --json`.
// ---------------------------------------------------------------------------

interface ContextPackJsonTicketRef {
  id: string;
  slug: string;
  name: string;
  state: string;
}

interface ContextPackJsonSession {
  id: string;
  actor: string;
  harness: string;
  started_at: string;
  ended_at: string | null;
}

export interface ContextPackJsonBody {
  ticket: {
    id: string;
    slug: string;
    name: string;
    state: string;
    priority: number;
    spec: { summary: string; details_md: string; acceptance: string[]; context: string[] };
  };
  ancestry: ContextPackJsonTicketRef[];
  external_parent_ref: string | null;
  jira_url: string | null;
  blockers: ContextPackJsonTicketRef[];
  sessions: ContextPackJsonSession[];
  elided: string[];
}

function ticketRefJson(t: Ticket): ContextPackJsonTicketRef {
  return { id: t.id, slug: t.slug, name: t.name, state: t.state };
}

function sessionJson(s: Session): ContextPackJsonSession {
  return {
    id: s.id,
    actor: s.actor.name,
    harness: s.harness.kind,
    started_at: s.started_at,
    ended_at: s.ended_at,
  };
}

/** The structured (`--json`) equivalent of {@link renderContextPack} — same
 * fields, machine-shaped. `elisions` (E1's budget notes) always rides
 * along as `elided`, mirroring `ready`/`search`/`events`'s `--json`
 * convention of an always-present (possibly empty) array rather than an
 * optional field. */
export function buildContextPackJson(
  data: ContextPackData,
  elisions: readonly string[] = [],
): ContextPackJsonBody {
  const { ticket } = data;
  return {
    ticket: {
      id: ticket.id,
      slug: ticket.slug,
      name: ticket.name,
      state: ticket.state,
      priority: ticket.priority,
      spec: {
        summary: ticket.spec.summary,
        details_md: ticket.spec.details_md,
        acceptance: ticket.spec.acceptance,
        context: ticket.spec.context,
      },
    },
    ancestry: data.ancestors.map(ticketRefJson),
    external_parent_ref: data.externalParentRef ?? null,
    jira_url:
      data.externalParentRef !== undefined
        ? jiraBrowseUrl(data.config, data.externalParentRef)
        : null,
    blockers: data.blockers.map(ticketRefJson),
    sessions: data.sessions.map(sessionJson),
    elided: [...elisions],
  };
}

/**
 * The `--json` sibling of {@link renderContextPackWithBudget} — same
 * entries list, same elision order (module doc), same "never exceed a
 * real budget when a fit exists" guarantee. Delegates entirely to
 * `core/budget.ts`'s `renderEntriesWithBudget`, `format: "json"`, for the
 * "never corrupt JSON, floor at the valid zero-entries envelope" contract
 * every other budget-taking command's `--json` path shares — this is no
 * longer a bespoke JSON degradation of its own.
 *
 * `body` (needed by `slop show --json --context`, which embeds this as a
 * sub-object of its own larger response rather than re-parsing text) is
 * captured via the closure below: `renderEntriesWithBudget` calls `render`
 * exactly once more than it returns from, so the last body built is always
 * the one whose text was actually returned.
 */
export function renderContextPackJsonWithBudget(
  data: ContextPackData,
  budgetChars?: number,
): { body: ContextPackJsonBody; text: string; withinBudget: boolean } {
  const entries = contextEntries(data);
  let lastBody: ContextPackJsonBody | undefined;
  const rendered = renderEntriesWithBudget(
    entries,
    (kept, elisions) => {
      const body = buildContextPackJson(dataForKeptEntries(data, kept), elisions);
      lastBody = body;
      return `${JSON.stringify(body, null, 2)}\n`;
    },
    budgetChars,
    { format: "json", noun: "context section" },
  );
  return {
    body: lastBody as ContextPackJsonBody,
    text: rendered.text,
    withinBudget: rendered.withinBudget,
  };
}
