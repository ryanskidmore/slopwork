/**
 * `slop events` — design.md §3, §4.2; work item D3.
 *
 * The hard part (ULID-cursor pagination, immune to `index.jsonc` rebuilds)
 * already exists in `repo/events.ts`'s `queryEvents` (A4). This module is
 * the CLI-facing wrapper: flag parsing, `--since`/`--ticket` error shaping,
 * `--limit`-based paging with a `next_cursor` a caller can page on, and two
 * output renderings (human, `--json`).
 *
 * ## The `--ticket` widening decision (D3's call, per A4's own doc comment
 * on `EventQuery.ticket`)
 *
 * `repo/events.ts`'s `queryEvents({ ticket })` only matches events whose
 * `entity.kind === "ticket"` — it deliberately does NOT pull in
 * session-lifecycle/plan events for sessions that belong to the ticket,
 * and flags that as D3's decision to widen or not.
 *
 * This module widens it: `--ticket <ref>` here also matches any event
 * whose `entity.kind === "session"` when that session's own `ticket` field
 * equals the resolved ticket id (see `ticketEventPredicate` below). So
 * `slop events --ticket X` surfaces `session.started`/`session.stopped`/
 * `session.ended`/`session.takeover`/`plan.set`/`plan.revised`/
 * `plan.step_checked` for every session ever run against X, not just the
 * `ticket.*` events.
 *
 * Rationale: design.md's own framing of what an events feed is FOR is
 * explicit about this — §4.7 item 3 ("every completed ticket has: a
 * session, a plan with checked steps, ... and a transcript"), §5 item 5
 * ("the human audits via status/web: every state change, plan revision,
 * progress note, MR, and transcript — attributed to actor + session +
 * harness"). A per-ticket audit trail that silently drops every plan
 * revision and every session start/stop because those events happen to be
 * filed under the session as their `entity` rather than the ticket would
 * fail that brief — an agent or human running `slop events --ticket X` to
 * reconstruct "what happened on this ticket" is the exact use case §4.7/§5
 * describe, and the narrow reading would make them reach for a second,
 * separate query (or grep the session file) to get the rest of the story.
 *
 * This costs one extra `listSessions` scan per `--ticket` query (to build
 * the set of session ids under the ticket) — cheap at v0's target scale,
 * and it changes nothing about cursor semantics: the predicate is just
 * another filter layered on top of the same ULID-ordered stream, applied
 * in this module rather than pushed into `queryEvents`, so ordering and
 * pagination stability are untouched. It also does not touch
 * `index.jsonc` — `listSessions` reads `sessions/*.jsonc` directly, same
 * as `queryEvents` reads `events/*.jsonc` directly.
 *
 * ## `--json` shape
 *
 * ```json
 * {
 *   "query": { "since": "event_… | null", "ticket": "ticket_… | null", "limit": number | null },
 *   "events": [ { "id", "at", "verb", "actor", "session", "entity", "payload" }, … ],
 *   "count": number,           // events.length
 *   "next_cursor": "event_… | null",
 *   "has_more": boolean,
 *   "elided": ["<note>", ...]  // E1's --budget; only non-empty when a budget forced elision
 * }
 * ```
 *
 * `events[]` entries are the real `Event` records (event.ts's schema),
 * unmodified. `next_cursor` is always the id of the last event in `events`
 * when `events` is non-empty; when it's empty (nothing new since the input
 * cursor), `next_cursor` echoes the input `--since` cursor back (or `null`
 * if none was given) so a polling caller can keep reusing it — re-issuing
 * the same query later, once new events land, picks them up without the
 * caller having to special-case "empty page" vs "no cursor yet". A caller
 * pages by looping `--since <next_cursor>` until `has_more` is `false`.
 * `has_more` is only meaningful relative to `--limit` OR `--budget`:
 * without either, every matching event is already returned, so `has_more`
 * is always `false`. When `--budget` (E1) forces eliding trailing events
 * from what would otherwise be the page, `next_cursor`/`has_more` are
 * recomputed against what's ACTUALLY returned (not the pre-budget page) —
 * a caller paging with `--since <next_cursor>` must never silently skip an
 * event that got elided rather than actually sent. This shape is E1's
 * starting point for standardising `--json` across commands, not a final
 * cross-command contract on its own.
 */
import type { Command } from "commander";
import {
  EXIT_CODES,
  type Event,
  type EventId,
  type TicketId,
  isEventId,
  renderEntriesWithBudget,
} from "../../core/index.js";
import {
  listSessions,
  queryEvents,
  readEvent,
  repoPaths,
  type RepoPaths,
  requireRepoRoot,
  resolveTicketRef,
} from "../../repo/index.js";
import { CONTEXT_PACK_BUDGET_UNIT } from "../../sessions/context-budget.js";
import { SlopError } from "../errors.js";
import { parseIntegerOption } from "./shared.js";

interface EventsOptions {
  since?: string;
  ticket?: string;
  json?: boolean;
  limit?: number;
  budget?: number;
}

/** Validate `--since`'s shape (USAGE_ERROR, exit 2) without touching disk. */
function parseSinceCursor(raw: string): EventId {
  if (!isEventId(raw)) {
    throw new SlopError(
      `--since expects a cursor of the form event_<ULID>, got "${raw}"`,
      EXIT_CODES.USAGE_ERROR,
    );
  }
  return raw;
}

/**
 * Confirm a well-formed `--since` cursor actually names an event on disk
 * (NOT_FOUND, exit 4) — `queryEvents({ since })` alone would silently
 * accept a never-issued (but well-formed) cursor and just filter against
 * it, returning whatever happens to sort after it; that's the wrong
 * failure mode for a cursor a caller is expected to page from.
 */
async function verifyCursorExists(paths: RepoPaths, since: EventId): Promise<void> {
  try {
    await readEvent(paths, since);
  } catch (err) {
    if (err instanceof SlopError && err.exitCode === EXIT_CODES.NOT_FOUND) {
      throw new SlopError(
        `no event found for cursor "${since}" (unknown, or from a different .slop/db)`,
        EXIT_CODES.NOT_FOUND,
      );
    }
    throw err;
  }
}

function parseLimit(raw: number): number {
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new SlopError(`--limit must be a positive integer, got "${raw}"`, EXIT_CODES.USAGE_ERROR);
  }
  return raw;
}

/** See this file's module doc, "The `--ticket` widening decision". */
async function ticketEventPredicate(
  paths: RepoPaths,
  ticketId: TicketId,
): Promise<(event: Event) => boolean> {
  const sessions = await listSessions(paths);
  // `Set<string>`, not `Set<SessionId>`: `event.entity.id` is deliberately
  // an unbranded `string` (event.ts's doc on `eventEntitySchema`), so the
  // membership check below needs a plain-string set to compare against.
  const sessionIds: Set<string> = new Set(
    sessions.filter((s) => s.ticket === ticketId).map((s) => s.id),
  );
  return (event: Event): boolean => {
    if (event.entity.kind === "ticket") return event.entity.id === ticketId;
    if (event.entity.kind === "session") return sessionIds.has(event.entity.id);
    return false;
  };
}

interface EventsPage {
  events: Event[];
  nextCursor: EventId | null;
  hasMore: boolean;
}

/**
 * Fetch, filter, and page in one pass. Deliberately never passes `limit`
 * down to `queryEvents` — with a `--ticket` filter active, limiting before
 * filtering would under-fill (or wrongly empty) a page, since the ticket
 * predicate runs in this module, after the fetch. Paging past `--limit`
 * costs nothing extra `queryEvents` wasn't already going to do: A4's
 * `queryEvents` reads every event file since the cursor into memory
 * regardless (see events.ts), so slicing here instead of in the repo layer
 * changes where the array is truncated, not how much is read.
 */
async function fetchPage(
  paths: RepoPaths,
  since: EventId | undefined,
  predicate: ((event: Event) => boolean) | undefined,
  limit: number | undefined,
): Promise<EventsPage> {
  const fetched = await queryEvents(paths, { since });
  const matched = predicate ? fetched.filter(predicate) : fetched;

  let page = matched;
  let hasMore = false;
  if (limit !== undefined) {
    hasMore = matched.length > limit;
    page = matched.slice(0, limit);
  }

  const last = page[page.length - 1];
  const nextCursor = last ? last.id : (since ?? null);
  return { events: page, nextCursor, hasMore };
}

function formatActor(event: Event): string {
  return `${event.actor.name} (${event.actor.kind})`;
}

/**
 * One line per event: timestamp, verb, actor, the entity ref, then the
 * acting session when present (design.md §4.2's brief for human output).
 * "The entity ref" is `event.entity.id` verbatim — ticket/session ids are
 * already self-describing prefixed ULIDs (`ticket_…`/`session_…`, D6), so
 * no extra lookup (and no risk of failing on a since-deleted reference) is
 * needed to make the line readable. `event.entity` (what the event is
 * about) and `event.session` (which session it happened under) are
 * distinct fields — see event.ts's schema — so both can appear on one
 * line and legitimately differ.
 */
function formatHumanLine(event: Event): string {
  const parts = [event.at, event.verb, formatActor(event), event.entity.id];
  if (event.session !== null) parts.push(`session:${event.session}`);
  return parts.join("  ");
}

/**
 * Recompute `next_cursor`/`has_more` against `kept` — what's ACTUALLY
 * being returned in this rendering — rather than trusting `page`'s
 * pre-budget values. Needed because `--budget` (E1) can elide trailing
 * events from `page.events` on top of whatever `--limit` already did; a
 * caller that pages with `--since <next_cursor>` must land exactly after
 * the last event it actually SAW, never after one that got silently
 * elided (that would drop it from every future page too).
 */
function pageFor(page: EventsPage, kept: readonly Event[], since: EventId | undefined): EventsPage {
  const hasMore = page.hasMore || kept.length < page.events.length;
  const last = kept[kept.length - 1];
  const nextCursor = last ? last.id : (since ?? null);
  return { events: [...kept], nextCursor, hasMore };
}

function buildHuman(page: EventsPage, kept: readonly Event[], elisions: readonly string[]): string {
  const lines: string[] = [];
  if (kept.length === 0) {
    lines.push("no events");
  } else {
    for (const event of kept) lines.push(formatHumanLine(event));
    if (page.hasMore && page.nextCursor) {
      lines.push(`-- more events: continue with --since ${page.nextCursor}`);
    }
  }
  if (elisions.length > 0) {
    lines.push("");
    lines.push(`(--budget, ${CONTEXT_PACK_BUDGET_UNIT}):`);
    for (const note of elisions) lines.push(`  - ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

function buildJson(
  page: EventsPage,
  since: EventId | undefined,
  ticketId: TicketId | undefined,
  limit: number | undefined,
  elisions: readonly string[],
): string {
  const body = {
    query: { since: since ?? null, ticket: ticketId ?? null, limit: limit ?? null },
    events: page.events,
    count: page.events.length,
    next_cursor: page.nextCursor,
    has_more: page.hasMore,
    elided: elisions,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export async function runEvents(opts: EventsOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);

  let since: EventId | undefined;
  if (opts.since !== undefined) {
    since = parseSinceCursor(opts.since);
    await verifyCursorExists(paths, since);
  }

  const limit = opts.limit !== undefined ? parseLimit(opts.limit) : undefined;

  let predicate: ((event: Event) => boolean) | undefined;
  let ticketId: TicketId | undefined;
  if (opts.ticket !== undefined) {
    const ticket = await resolveTicketRef(paths, opts.ticket);
    ticketId = ticket.id;
    predicate = await ticketEventPredicate(paths, ticket.id);
  }

  const page = await fetchPage(paths, since, predicate, limit);

  const rendered = renderEntriesWithBudget(
    page.events,
    (kept, elisions) =>
      opts.json
        ? buildJson(pageFor(page, kept, since), since, ticketId, limit, elisions)
        : buildHuman(pageFor(page, kept, since), kept, elisions),
    opts.budget,
    { format: opts.json ? "json" : "text", noun: "event" },
  );
  process.stdout.write(rendered.text);
}

/** `slop events` — design.md §3, §4.2; work item D3. */
export function registerEventsCommand(program: Command): void {
  program
    .command("events")
    .description("List immutable events, optionally since a cursor or scoped to a ticket.")
    .option("--since <event_id>", "exclusive cursor: only events after this event id")
    .option("--ticket <ref>", "only events for this ticket (id, slug, or short prefix)")
    .option("--limit <n>", "cap the number of events returned", parseIntegerOption("--limit"))
    .option("--json", "machine-readable output (events + a next cursor for paging)")
    .option(
      "--budget <n>",
      `cap output size to N ${CONTEXT_PACK_BUDGET_UNIT} (elides the newest trailing events first, ` +
        "adjusting next_cursor/has_more to match what's actually returned)",
      parseIntegerOption("--budget"),
    )
    .action(runEvents);
}
