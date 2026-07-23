/**
 * `slop search "text"` (design.md §4.2, §4.6; work item D2) — pure
 * matching / ranking / snippet logic, no file I/O. Deliberately NOT
 * SlopQL (§4.6: "naive scan over names/specs/notes (SlopQL is F6)") — no
 * field filters, no boolean operators, no query grammar. Just: split the
 * query into lowercase words, require every word to appear (case
 * -insensitive substring) SOMEWHERE across a ticket's searchable text, and
 * rank matches by a small, explainable rule (see {@link compareHits} /
 * {@link rankSearchResults}) rather than a scoring engine.
 *
 * `src/cli/commands/search.ts` (the CLI layer) is responsible for
 * gathering the searchable text per ticket — including progress-note
 * HISTORY pulled from events, not just the ticket's own `latest_note`
 * field — and calling into this module.
 */

/** Which part of a ticket a search field came from. Doubles as the
 * `--json` field label and the human snippet's `[field]` tag. */
export const SEARCH_FIELD_KINDS = [
  "name",
  "slug",
  "summary",
  "acceptance",
  "context",
  "details_md",
  "note",
] as const;
export type SearchFieldKind = (typeof SEARCH_FIELD_KINDS)[number];

/**
 * Field weight table — the ranked-ish rule's primary axis (this work
 * item's brief: "field weight (name/summary above `details_md` above
 * notes)"). A flat lookup table, not a computed score: change a number
 * here if the priority order ever needs to move, nothing to re-derive.
 * Ties within the same field are broken by matched-term count, then
 * ticket recency — see {@link compareHits} / {@link rankSearchResults}.
 */
const FIELD_WEIGHT: Record<SearchFieldKind, number> = {
  name: 60,
  slug: 55,
  summary: 50,
  acceptance: 40,
  context: 35,
  details_md: 20,
  note: 10,
};

/**
 * One piece of searchable text pulled off a ticket (or its progress-note
 * history) — the unit both matching and snippet extraction operate over.
 * `noteAt`/`noteEventId` are set only for `kind: "note"` occurrences that
 * came from a historical `ticket.updated`/`ticket.state_changed` event, so
 * a snippet's caller can say *when* an old note was written; the ticket's
 * own current `latest_note` field is passed through with both left
 * `undefined` (it has no event of its own to point at).
 */
export interface SearchField {
  kind: SearchFieldKind;
  text: string;
  noteAt?: string;
  noteEventId?: string;
}

/** One field occurrence containing at least one query term. */
export interface SearchHit {
  field: SearchField;
  /** Query terms (lowercased) found as a substring of `field.text`, in query order. */
  matchedTerms: string[];
}

export interface TicketSearchResult {
  /** Every field occurrence that matched at least one term. */
  hits: SearchHit[];
  /** The single hit driving this ticket's rank/snippet — see {@link compareHits}. */
  best: SearchHit;
}

/**
 * Split a raw query into lowercase, deduplicated, non-empty terms.
 * Whitespace-separated only — no quoting, no operators, no phrase syntax
 * (§4.6: this stays a naive scan by design).
 */
export function searchTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/\s+/)) {
    if (raw.length === 0) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
  }
  return terms;
}

function fieldMatchedTerms(text: string, terms: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term));
}

/**
 * Order two hits for the "which occurrence best represents this ticket"
 * choice, and — reused as-is — for ranking tickets against each other
 * (see {@link rankSearchResults}): higher field weight first, then more
 * matched terms in that occurrence. Negative means `a` ranks above `b`.
 */
export function compareHits(a: SearchHit, b: SearchHit): number {
  const weightDiff = FIELD_WEIGHT[b.field.kind] - FIELD_WEIGHT[a.field.kind];
  if (weightDiff !== 0) return weightDiff;
  return b.matchedTerms.length - a.matchedTerms.length;
}

/**
 * Match one ticket's searchable fields against `terms`. Returns `null` if
 * any term isn't found ANYWHERE across the ticket's fields — AND
 * semantics across terms, OR semantics across fields: "all terms must
 * appear somewhere in the ticket, rather than requiring the exact
 * phrase" (this work item's brief). A ticket with zero searchable fields,
 * or a query with zero terms, never matches. Otherwise returns every
 * field occurrence that matched at least one term, plus the single best
 * one per {@link compareHits}.
 */
export function matchTicketFields(
  fields: readonly SearchField[],
  terms: readonly string[],
): TicketSearchResult | null {
  if (terms.length === 0) return null;

  const hits: SearchHit[] = [];
  const foundOverall = new Set<string>();
  for (const field of fields) {
    if (field.text.trim().length === 0) continue;
    const matchedTerms = fieldMatchedTerms(field.text, terms);
    if (matchedTerms.length === 0) continue;
    hits.push({ field, matchedTerms });
    for (const term of matchedTerms) foundOverall.add(term);
  }

  if (foundOverall.size < terms.length) return null; // at least one term matched nowhere at all

  let best: SearchHit | undefined;
  for (const hit of hits) {
    if (best === undefined || compareHits(hit, best) < 0) best = hit;
  }
  if (best === undefined) return null; // unreachable: foundOverall.size check above guarantees >=1 hit

  return { hits, best };
}

const SNIPPET_CONTEXT_CHARS = 40;
const SNIPPET_FALLBACK_MAX_CHARS = 160;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wrap every case-insensitive occurrence of any of `terms` inside `text`
 * with `**marker**` (markdown-bold-style — readable as plain terminal
 * text and by any consumer that happens to render markdown). Naive,
 * non-overlapping, longest-term-first so a short term that's itself a
 * substring of a longer matched term (e.g. "au" inside "auth") never eats
 * part of the longer one's marker — good enough for the naive-scan bar
 * this work item sets (§4.6: no real highlighting engine).
 */
function markTerms(text: string, terms: readonly string[]): string {
  if (terms.length === 0) return text;
  const pattern = terms
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const re = new RegExp(`(${pattern})`, "gi");
  return text.replace(re, "**$1**");
}

/**
 * Build a bounded, single-line, human-scannable snippet around the first
 * matched term in `hit`, with every matched term inside the snippet
 * window marked (see {@link markTerms}). This — not a bare list of ids —
 * is what makes `slop search` useful instead of `grep -l` (this work
 * item's brief). Bounded to roughly
 * `2 * SNIPPET_CONTEXT_CHARS + longest-matched-term` characters so one
 * `details_md` hit can never dominate the output.
 */
export function buildSnippet(hit: SearchHit): string {
  const { text } = hit.field;
  const lower = text.toLowerCase();

  let firstIndex = -1;
  let firstLen = 0;
  for (const term of hit.matchedTerms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (firstIndex === -1 || idx < firstIndex)) {
      firstIndex = idx;
      firstLen = term.length;
    }
  }
  if (firstIndex === -1) {
    // Unreachable given matchTicketFields's contract (every hit has >=1
    // matched term actually present in field.text), but a defensive
    // plain-truncated fallback beats throwing on a display path.
    const collapsed = text.replace(/\s+/g, " ").trim();
    return collapsed.length > SNIPPET_FALLBACK_MAX_CHARS
      ? `${collapsed.slice(0, SNIPPET_FALLBACK_MAX_CHARS)}…`
      : collapsed;
  }

  const start = Math.max(0, firstIndex - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(text.length, firstIndex + firstLen + SNIPPET_CONTEXT_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const window = text.slice(start, end).replace(/\s+/g, " ").trim();

  return `${prefix}${markTerms(window, hit.matchedTerms)}${suffix}`;
}

/** The subset of a ticket {@link rankSearchResults} needs — kept minimal
 * (rather than requiring a full `Ticket`) so this module stays decoupled
 * from `core/entities`. */
export interface RankableTicket {
  id: string;
  last_activity_at: string;
}

export interface RankedResult<T extends RankableTicket> {
  ticket: T;
  result: TicketSearchResult;
}

/**
 * Order matched tickets for display — the "ranked-ish output" this work
 * item asks for, deliberately not a scoring engine (§4.6). A plain,
 * three-key sort, most-significant first:
 *
 *   1. field weight of the ticket's best hit, descending — a name/slug/
 *      summary match always outranks a details_md-only match, which
 *      always outranks a notes-only match, regardless of anything else.
 *   2. matched-term count of that best hit, descending — for a multi-word
 *      query, a hit that landed more of the query's terms in one field
 *      beats one that landed fewer, at the same field weight.
 *   3. `last_activity_at`, descending (recency) — the most-recently
 *      -touched ticket wins a full tie.
 *
 * `id` is a final, purely-for-determinism tiebreaker (irrelevant in
 * practice: two tickets sharing every key above is vanishingly unlikely,
 * but a stable sort needs *some* total order to be deterministic across
 * runs and platforms).
 */
export function rankSearchResults<T extends RankableTicket>(
  results: readonly RankedResult<T>[],
): RankedResult<T>[] {
  return results.slice().sort((a, b) => {
    const hitCompare = compareHits(a.result.best, b.result.best);
    if (hitCompare !== 0) return hitCompare;
    const recencyCompare = b.ticket.last_activity_at.localeCompare(a.ticket.last_activity_at);
    if (recencyCompare !== 0) return recencyCompare;
    return a.ticket.id.localeCompare(b.ticket.id);
  });
}
