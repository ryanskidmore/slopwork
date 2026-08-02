/**
 * `slop events` — design.md §3, §4.2; work item D3.
 *
 * This module exposes two deliberately different cursor contracts:
 *
 * - `--since <event-id>` preserves the original ascending-ULID pagination
 *   API for a static snapshot. It cannot be a durable Git-merge polling
 *   watermark: an older id merged later sorts before the scalar forever.
 * - `--poll [cursor]` is the merge-safe polling API. Its opaque, constant-
 *   size token names local/backend state containing the exact set of ids
 *   actually returned to that consumer. Omit the token once to create it,
 *   then reuse the returned `poll_cursor`; empty polls do not stop older or
 *   late-origin events from being discovered later.
 *
 * Both paths apply `--ticket`, `--limit`, and `--budget`. Poll state advances
 * only through records present in the final rendering, never through events
 * merely fetched and then filtered, limited, or elided.
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
 * session, a plan with checked steps, ..."), §5 item 5
 * ("the human audits via status/web: every state change, plan revision,
 * progress note, and MR — attributed to actor + session +
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
 *   "query": {
 *     "since": "event_… | null",
 *     "poll_cursor": "cursor_v1_… | null",
 *     "cursor_mode": "static_snapshot | merge_safe_poll",
 *     "ticket": "ticket_… | null",
 *     "limit": number
 *   },
 *   "events": [ { "id", "at", "verb", "actor", "session", "entity", "payload" }, … ],
 *   "count": number,           // events.length
 *   "next_cursor": "event_… | null", // static-snapshot mode only
 *   "poll_cursor": "cursor_v1_… | null",
 *   "has_more": boolean,
 *   "elided": ["<note>", ...]  // E1's --budget; only non-empty when a budget forced elision
 * }
 * ```
 *
 * `events[]` entries are the real `Event` records (event.ts's schema),
 * unmodified. In static-snapshot mode a caller pages by passing
 * `next_cursor` back through `--since`; the command warns that this scalar
 * can miss older ids merged later. In merge-safe mode, `next_cursor` is
 * always `null` and the stable `poll_cursor` is reused for every page and
 * later poll.
 *
 * housekeeping-gitignore-lock-stale: `--limit` defaults to
 * {@link DEFAULT_EVENTS_LIMIT} when omitted (was previously unbounded —
 * every matching event, however many, on every call with no flags) —
 * `query.limit` in the `--json` body always reflects the EFFECTIVE limit
 * actually applied, default or explicit, never `null`. `has_more` is
 * `true` whenever the effective limit or `--budget` held back events the
 * caller hasn't seen yet. In static mode, whenever `has_more` is `true`,
 * `next_cursor` is guaranteed to differ from the input `--since` (or from
 * `null` if none was given). In poll mode, progress is recorded behind the
 * stable opaque cursor instead. A
 * `--budget` small enough to elide every fetched event from the rendered
 * page used to report exactly that combination). When `--budget` (E1)
 * elides ALL fetched events from what would otherwise be the page,
 * `has_more` is reported as `false` instead — paging with the SAME
 * cursor/`--limit` would only re-fetch and re-elide the identical
 * events, so it is not genuinely "more" the caller can reach; `elided`
 * already names this explicitly ("all N event(s) omitted to fit
 * --budget"), which is the actionable signal (raise `--budget`), not
 * pagination. This shape is E1's starting point for standardising `--json`
 * across commands, not a final cross-command contract on its own.
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
import { repoPaths, requireRepoRoot } from "../../repo/index.js";
import { CONTEXT_PACK_BUDGET_UNIT } from "../../sessions/context-budget.js";
import type { StorageBackend } from "../../storage/index.js";
import type { EventPollCursor } from "../../storage/index.js";
import { openStorage, parseEventPollCursor } from "../../storage/index.js";
import { SlopError } from "../errors.js";
import { parseBudgetOption, parseIntegerOption } from "./shared.js";

interface EventsOptions {
  since?: string;
  ticket?: string;
  json?: boolean;
  limit?: number;
  budget?: number;
  poll?: boolean | string;
  deletePollCursor?: string;
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
async function verifyCursorExists(backend: StorageBackend, since: EventId): Promise<void> {
  try {
    await backend.readEvent(since);
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

/**
 * housekeeping-gitignore-lock-stale: the effective `--limit` whenever the
 * flag is omitted — see this module's doc comment. Generous enough to
 * comfortably cover a single ticket's whole lifecycle (D1's acceptance
 * fixture: 9 events) or a small burst, while still bounding the truly
 * unbounded case (a long-lived repo's full event log) by default.
 */
export const DEFAULT_EVENTS_LIMIT = 100;

function parseLimit(raw: number): number {
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new SlopError(`--limit must be a positive integer, got "${raw}"`, EXIT_CODES.USAGE_ERROR);
  }
  return raw;
}

/** See this file's module doc, "The `--ticket` widening decision". */
async function ticketEventPredicate(
  backend: StorageBackend,
  ticketId: TicketId,
): Promise<(event: Event) => boolean> {
  const sessions = await backend.listSessions();
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
  backend: StorageBackend,
  since: EventId | undefined,
  predicate: ((event: Event) => boolean) | undefined,
  limit: number | undefined,
  seen: ReadonlySet<EventId> = new Set(),
): Promise<EventsPage> {
  const fetched = await backend.queryEvents({ since });
  const unseen = fetched.filter((event) => !seen.has(event.id));
  const matched = predicate ? unseen.filter(predicate) : unseen;

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
 *
 * housekeeping-gitignore-lock-stale: `has_more` is forced `false` whenever
 * `nextCursor` didn't actually advance past the input `since` (`kept` is
 * empty — `--budget` elided every fetched event) — see this module's doc
 * comment for why: reporting `has_more: true` there would be a lie a
 * caller can't act on (re-querying with the SAME `--since` just re-fetches
 * and re-elides the identical events forever), and advancing the cursor
 * anyway would silently drop those fetched-but-never-shown events from
 * every future page — the one thing this function exists to prevent. This
 * makes `next_cursor !== (since ?? null)` a hard invariant of `has_more:
 * true` — never the reverse-inferrable "true but stuck" combination.
 */
function pageFor(
  page: EventsPage,
  kept: readonly Event[],
  since: EventId | undefined,
  polling: boolean,
): EventsPage {
  const last = kept[kept.length - 1];
  const nextCursor = polling ? null : last ? last.id : (since ?? null);
  const madeProgress = polling ? kept.length > 0 : nextCursor !== (since ?? null);
  const hasMore = madeProgress && (page.hasMore || kept.length < page.events.length);
  return { events: [...kept], nextCursor, hasMore };
}

function buildHuman(
  page: EventsPage,
  kept: readonly Event[],
  elisions: readonly string[],
  pollCursor: EventPollCursor | undefined,
): string {
  const lines: string[] = [];
  if (kept.length === 0) {
    lines.push("no events");
  } else {
    for (const event of kept) lines.push(formatHumanLine(event));
    if (page.hasMore && pollCursor) {
      lines.push(`-- more unseen events: continue with --poll ${pollCursor}`);
    } else if (page.hasMore && page.nextCursor) {
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
  limit: number,
  elisions: readonly string[],
  pollCursor: EventPollCursor | undefined,
): string {
  const body = {
    query: {
      since: since ?? null,
      poll_cursor: pollCursor ?? null,
      cursor_mode: pollCursor ? "merge_safe_poll" : "static_snapshot",
      ticket: ticketId ?? null,
      limit,
    },
    events: page.events,
    count: page.events.length,
    next_cursor: page.nextCursor,
    poll_cursor: pollCursor ?? null,
    has_more: page.hasMore,
    elided: elisions,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export async function runEvents(opts: EventsOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const backend = await openStorage(paths);

  if (opts.deletePollCursor !== undefined) {
    if (opts.poll !== undefined || opts.since !== undefined || opts.ticket !== undefined) {
      throw new SlopError(
        "--delete-poll-cursor cannot be combined with --poll, --since, or --ticket",
        EXIT_CODES.USAGE_ERROR,
      );
    }
    const cursor = parseEventPollCursor(opts.deletePollCursor);
    await backend.deleteEventPollCursor(cursor);
    process.stdout.write(
      opts.json
        ? `${JSON.stringify({ deleted_poll_cursor: cursor }, null, 2)}\n`
        : `deleted event polling cursor ${cursor}\n`,
    );
    return;
  }

  if (opts.poll !== undefined && opts.since !== undefined) {
    throw new SlopError(
      "--poll and --since are different cursor contracts and cannot be combined",
      EXIT_CODES.USAGE_ERROR,
    );
  }

  let since: EventId | undefined;
  if (opts.since !== undefined) {
    since = parseSinceCursor(opts.since);
    await verifyCursorExists(backend, since);
    process.stderr.write(
      "warning: --since is static-snapshot pagination and can miss events merged later with older ids; use --poll for durable polling\n",
    );
  }

  let pollCursor: EventPollCursor | undefined;
  let seen = new Set<EventId>();
  if (opts.poll !== undefined) {
    pollCursor =
      typeof opts.poll === "string"
        ? parseEventPollCursor(opts.poll)
        : await backend.createEventPollCursor();
    const state = await backend.readEventPollCursor(pollCursor);
    seen = new Set(state.seen);
  }

  // housekeeping-gitignore-lock-stale: `--limit` always has an EFFECTIVE
  // value now — the user's if given, else DEFAULT_EVENTS_LIMIT — never
  // "no limit at all" (see this module's doc comment for why an unbounded
  // default was the other half of the bug this closes).
  const limit = opts.limit !== undefined ? parseLimit(opts.limit) : DEFAULT_EVENTS_LIMIT;

  let predicate: ((event: Event) => boolean) | undefined;
  let ticketId: TicketId | undefined;
  if (opts.ticket !== undefined) {
    const ticket = await backend.resolveTicketRef(opts.ticket);
    ticketId = ticket.id;
    predicate = await ticketEventPredicate(backend, ticket.id);
  }

  const page = await fetchPage(backend, since, predicate, limit, seen);

  const rendered = renderEntriesWithBudget(
    page.events,
    (kept, elisions) =>
      opts.json
        ? buildJson(
            pageFor(page, kept, since, pollCursor !== undefined),
            since,
            ticketId,
            limit,
            elisions,
            pollCursor,
          )
        : buildHuman(
            pageFor(page, kept, since, pollCursor !== undefined),
            kept,
            elisions,
            pollCursor,
          ),
    opts.budget,
    { format: opts.json ? "json" : "text", noun: "event" },
  );
  if (pollCursor !== undefined) {
    const returned = page.events.slice(0, rendered.keptCount).map((event) => event.id);
    await backend.advanceEventPollCursor(pollCursor, returned);
  }
  process.stdout.write(rendered.text);
}

/** `slop events` — design.md §3, §4.2; work item D3. */
export function registerEventsCommand(program: Command): void {
  program
    .command("events")
    .description("List immutable events, page a snapshot, or poll merge-safely.")
    .option(
      "--since <event_id>",
      "deprecated for polling: page after this id in the current ordered snapshot",
    )
    .option(
      "--poll [cursor]",
      "merge-safe polling: omit cursor to create one, then pass the returned cursor to continue",
    )
    .option(
      "--delete-poll-cursor <cursor>",
      "delete a retired polling cursor and its local/server-side seen state",
    )
    .option("--ticket <ref>", "only events for this ticket (id, slug, or short prefix)")
    .option(
      "--limit <n>",
      `cap the number of events returned (default ${DEFAULT_EVENTS_LIMIT})`,
      parseIntegerOption("--limit"),
    )
    .option("--json", "machine-readable output with explicit cursor mode and checkpoint")
    .option(
      "--budget <n>",
      `cap output size to N ${CONTEXT_PACK_BUDGET_UNIT} (elides the newest trailing events first, ` +
        "adjusting next_cursor/has_more to match what's actually returned)",
      parseBudgetOption,
    )
    .action(runEvents);
}
