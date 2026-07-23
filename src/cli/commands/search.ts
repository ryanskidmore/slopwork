/**
 * `slop search "text"` — design.md §4.2 ("naive scan over names/specs/
 * notes (SlopQL is F6)"), §4.6 (SlopQL itself is an explicit v0 skip —
 * this stays a naive scan, never a query language); work item D2.
 *
 * ## Where progress notes live, and why both places are searched
 *
 * A ticket's `latest_note` field (core/entities/ticket.ts) only ever
 * holds the MOST RECENT `--progress` text (B1's `buildUpdate`,
 * src/tickets/update.ts) — every earlier note is overwritten in place on
 * the ticket file. The full note HISTORY instead lives in the event log:
 * every `update --progress` call emits a `ticket.updated` (or
 * `ticket.state_changed`, if the same call also changed state —
 * `buildUpdate` sets `payload.progress` on both verbs whenever
 * `input.progress !== undefined`) event whose `payload.progress` carries
 * that call's note text, immutably, forever (events.ts: events are never
 * updated or deleted).
 *
 * "Finds text in ... progress notes" (this work item's acceptance
 * criterion) therefore means BOTH: the ticket's current `latest_note`
 * field (in case an old event was ever pruned/lost — belt and suspenders)
 * AND every historical `payload.progress` string pulled from
 * `listEvents()` and grouped by ticket in {@link notesByTicket}. A
 * `latest_note`-only implementation would silently fail to find a term
 * that only ever appeared in a note that has since been superseded by a
 * later `--progress` call — exactly the case tests/acceptance/D2.test.ts
 * exercises directly.
 *
 * ## Matching / ranking / snippets
 *
 * The actual matching, ranking, and snippet-building logic is pure and
 * lives in src/tickets/search.ts (unit-tested there) — this module's job
 * is purely: gather each ticket's searchable text (including the note
 * history above), call into that module, and render the result as human
 * text or `--json`.
 *
 * ## Corrupt files
 *
 * Reads tickets via {@link listTicketsTolerant} (repo/tickets.ts), not
 * the strict {@link listTickets} — a single unparseable ticket file must
 * not take `slop search` down (consistent with `slop reindex`'s and
 * `loadIndex`'s fault tolerance, db-index.ts's "Fault tolerance"). Any
 * skipped files are warned about on stderr and also listed in `--json`'s
 * `problems` array; every other ticket is still searched normally.
 *
 * ## `--json` shape
 *
 * ```json
 * {
 *   "query": { "text": "<raw text>", "terms": ["term1", "term2"], "limit": number | null },
 *   "results": [
 *     {
 *       "id", "slug", "name", "state", "priority",
 *       "field": "name" | "slug" | "summary" | "acceptance" | "context" | "details_md" | "note",
 *       "matched_terms": ["term1", ...],   // terms matched within the winning field/occurrence
 *       "snippet": "…surrounding **term** text…",
 *       "last_activity_at": "<ISO timestamp>"
 *     }, ...
 *   ],
 *   "count": number,       // results.length
 *   "problems": [ { "id", "path", "message" }, ... ]   // ticket files skipped; usually []
 * }
 * ```
 */
import type { Command } from "commander";
import type { Event, Ticket, TicketId } from "../../core/index.js";
import { EXIT_CODES, isTicketId } from "../../core/index.js";
import { listEvents, listTicketsTolerant, repoPaths, requireRepoRoot } from "../../repo/index.js";
import type { TicketReadProblem } from "../../repo/index.js";
import type { RankedResult, SearchField, SearchFieldKind } from "../../tickets/search.js";
import {
  buildSnippet,
  matchTicketFields,
  rankSearchResults,
  searchTerms,
} from "../../tickets/search.js";
import { SlopError } from "../errors.js";
import { parseIntegerOption } from "./shared.js";

interface SearchCommandOptions {
  json?: boolean;
  limit?: number;
}

interface ProgressNote {
  text: string;
  at: string;
  eventId: string;
}

/** Every historical progress note, grouped by ticket — see this file's
 * module doc, "Where progress notes live". One pass over every event
 * (naive, matching this work item's "naive scan" bar — §4.6), not one
 * `queryEvents({ticket})` call per ticket. */
function notesByTicket(events: readonly Event[]): Map<TicketId, ProgressNote[]> {
  const map = new Map<TicketId, ProgressNote[]>();
  for (const event of events) {
    if (event.entity.kind !== "ticket" || !isTicketId(event.entity.id)) continue;
    const progress = event.payload.progress;
    if (typeof progress !== "string" || progress.length === 0) continue;
    const list = map.get(event.entity.id) ?? [];
    list.push({ text: progress, at: event.at, eventId: event.id });
    map.set(event.entity.id, list);
  }
  return map;
}

/** Every field D2's brief lists: "name, slug, spec.summary,
 * spec.details_md, spec.acceptance[], spec.context[], and progress
 * notes" — the last of those covering both `latest_note` and full event
 * history (see `notes`). `spec.meta` is deliberately NOT scanned — the
 * brief doesn't list it, and it's arbitrary structured data, not prose. */
function searchFieldsFor(ticket: Ticket, notes: readonly ProgressNote[]): SearchField[] {
  const fields: SearchField[] = [
    { kind: "name", text: ticket.name },
    { kind: "slug", text: ticket.slug },
    { kind: "summary", text: ticket.spec.summary },
    { kind: "details_md", text: ticket.spec.details_md },
  ];
  for (const item of ticket.spec.acceptance) fields.push({ kind: "acceptance", text: item });
  for (const item of ticket.spec.context) fields.push({ kind: "context", text: item });
  if (ticket.latest_note !== null) fields.push({ kind: "note", text: ticket.latest_note });
  for (const note of notes) {
    fields.push({ kind: "note", text: note.text, noteAt: note.at, noteEventId: note.eventId });
  }
  return fields;
}

/** Same per-problem rendering `db-index.ts`'s `formatIndexProblems` uses
 * (path + indented, actionable error message) but with a header accurate
 * to THIS call site — search never builds an index, so reusing that
 * function's "...while building the index" header would be misleading
 * here. */
function formatSearchProblems(problems: readonly TicketReadProblem[]): string {
  const header = `${problems.length} ticket file(s) could not be read and were skipped by this search:`;
  const body = problems.map((p) => {
    const indented = p.message
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    return `  - ${p.path}\n${indented}`;
  });
  return [header, ...body].join("\n");
}

function parseLimit(raw: number): number {
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new SlopError(`--limit must be a positive integer, got "${raw}"`, EXIT_CODES.USAGE_ERROR);
  }
  return raw;
}

function formatHumanLine(entry: RankedResult<Ticket>): string {
  const { ticket, result } = entry;
  const header = [ticket.id, ticket.slug, ticket.state, `p${ticket.priority}`, ticket.name].join(
    "  ",
  );
  return `${header}  —  [${result.best.field.kind}] ${buildSnippet(result.best)}`;
}

function printHuman(text: string, results: readonly RankedResult<Ticket>[]): void {
  if (results.length === 0) {
    process.stdout.write(`no matches for "${text}"\n`);
    return;
  }
  for (const entry of results) {
    process.stdout.write(`${formatHumanLine(entry)}\n`);
  }
}

interface SearchJsonResult {
  id: string;
  slug: string;
  name: string;
  state: string;
  priority: number;
  field: SearchFieldKind;
  matched_terms: string[];
  snippet: string;
  last_activity_at: string;
}

function toJsonResult(entry: RankedResult<Ticket>): SearchJsonResult {
  const { ticket, result } = entry;
  return {
    id: ticket.id,
    slug: ticket.slug,
    name: ticket.name,
    state: ticket.state,
    priority: ticket.priority,
    field: result.best.field.kind,
    matched_terms: result.best.matchedTerms,
    snippet: buildSnippet(result.best),
    last_activity_at: ticket.last_activity_at,
  };
}

function printJson(
  text: string,
  terms: readonly string[],
  limit: number | undefined,
  results: readonly RankedResult<Ticket>[],
  problems: readonly TicketReadProblem[],
): void {
  const body = {
    query: { text, terms, limit: limit ?? null },
    results: results.map(toJsonResult),
    count: results.length,
    problems,
  };
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}

async function runSearch(text: string, opts: SearchCommandOptions): Promise<void> {
  const terms = searchTerms(text);
  if (terms.length === 0) {
    throw new SlopError(
      "search text must contain at least one non-whitespace word",
      EXIT_CODES.USAGE_ERROR,
    );
  }
  const limit = opts.limit !== undefined ? parseLimit(opts.limit) : undefined;

  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);

  // Fault-tolerant read (module doc's "Corrupt files") + one full events
  // scan for note history, in parallel — independent reads.
  const [{ tickets, problems }, events] = await Promise.all([
    listTicketsTolerant(paths),
    listEvents(paths),
  ]);

  if (problems.length > 0) {
    process.stderr.write(`warning: ${formatSearchProblems(problems)}\n`);
  }

  const notes = notesByTicket(events);

  const matched: RankedResult<Ticket>[] = [];
  for (const ticket of tickets) {
    const fields = searchFieldsFor(ticket, notes.get(ticket.id) ?? []);
    const result = matchTicketFields(fields, terms);
    if (result) matched.push({ ticket, result });
  }

  const ranked = rankSearchResults(matched);
  const limited = limit !== undefined ? ranked.slice(0, limit) : ranked;

  if (opts.json) {
    printJson(text, terms, limit, limited, problems);
  } else {
    printHuman(text, limited);
  }
}

/** `slop search` — design.md §4.2; work item D2 (SlopQL proper is F6). */
export function registerSearchCommand(program: Command): void {
  program
    .command("search")
    .description(
      "Naive, case-insensitive text scan over ticket names, specs, and progress " +
        "note history (not SlopQL — no field filters or query syntax; see F6).",
    )
    .argument(
      "<text>",
      "text to search for — space-separated words; every word must match somewhere",
    )
    .option("--json", "machine-readable output")
    .option("--limit <n>", "cap the number of results returned", parseIntegerOption("--limit"))
    .action(runSearch);
}
