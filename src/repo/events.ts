/**
 * Event entity CRUD over `<root>/.slop/db/events/event_<ulid>.jsonc`
 * (design.md §3). Events are immutable (design.md §4.1 item 4): there is
 * no `updateEvent`, and — as of A4 — no `deleteEvent` either. A3 originally
 * shipped a `deleteEvent` as a plain CRUD-completeness primitive
 * ("test cleanup" per its own doc comment); A4 removes it outright. This
 * work item's brief is explicit: "there should be no supported path to
 * modify or delete an event." Keeping a delete function around at all,
 * even documented as test-only, is exactly the kind of supported path
 * that invites a future caller to reach for it — every other repo-layer
 * test file already cleans up via `rm(scratch, { recursive: true, force:
 * true })` on its whole scratch directory (see e.g. tickets.test.ts), so
 * nothing legitimate is lost by removing it.
 *
 * A4 also lands here:
 *   - {@link EventContext} / {@link MutationEventSpec} / {@link
 *     withMutationEvent} — the emit-on-mutation hook. tickets.ts's
 *     `createTicket`/`updateTicket` and sessions.ts's `createSession`/
 *     `updateSession` are ALL implemented in terms of this function, which
 *     is what makes "every repo mutation produces exactly one event" a
 *     property of calling the repo layer rather than a convention a future
 *     command has to remember to uphold — see those two modules, and
 *     tests/acceptance/A4.test.ts for the property test.
 *   - {@link EventQuery} / {@link queryEvents} — the ULID-cursor
 *     pagination primitive D3's `slop events --since` builds directly on.
 */
import { join } from "node:path";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import {
  type Actor,
  type Event,
  type EventEntity,
  type EventId,
  type EventVerb,
  type SessionId,
  type TicketId,
  eventSchema,
  isEventId,
  newEventId,
} from "../core/index.js";
import { createEntityFileCanonical, listEntityIds, readEntityFile } from "./entity-file.js";
import type { RepoPaths } from "./paths.js";

export function eventFilePath(paths: RepoPaths, id: EventId): string {
  return join(paths.eventsDir, `${id}.jsonc`);
}

export async function readEvent(paths: RepoPaths, id: EventId): Promise<Event> {
  return readEntityFile(eventFilePath(paths, id), eventSchema);
}

/**
 * New event file. Always canonical (machine-only, write-once — jsonc.ts's
 * module doc). Low-level primitive: most callers want {@link
 * withMutationEvent} instead — this function alone just writes whatever
 * `Event` it's handed, with no guarantee it's paired with the mutation it
 * describes.
 */
export async function createEvent(paths: RepoPaths, event: Event): Promise<void> {
  await createEntityFileCanonical(eventFilePath(paths, event.id), event);
}

/**
 * Event ids present on disk, ascending — this *is* the event-ordering
 * cursor design.md §3 refers to ("event ordering cursors on the event
 * ULID itself"), since ULIDs sort chronologically as plain strings, and
 * core/ids.ts's shared monotonic factory keeps that total and strictly
 * increasing even for ids minted within the same millisecond.
 */
export async function listEventIds(paths: RepoPaths): Promise<EventId[]> {
  return listEntityIds(paths.eventsDir, isEventId);
}

/** Every event on disk, read and validated, in cursor order. */
export async function listEvents(paths: RepoPaths): Promise<Event[]> {
  const ids = await listEventIds(paths);
  return Promise.all(ids.map((id) => readEvent(paths, id)));
}

// --- A4: emit-on-mutation hook --------------------------------------------

/**
 * Who is acting, and under which session — the two facts every event
 * needs that the repo layer itself can never infer on its own (design.md
 * §4.1 item 4: event carries "actor, session"). `session` is nullable:
 * plenty of mutations happen outside any `start`ed session (e.g. `slop
 * new` run cold, before any session exists).
 *
 * Required — not optional — on every mutating repo-layer call (see
 * tickets.ts/sessions.ts's `createTicket`/`updateTicket`/`createSession`/
 * `updateSession`, all of which take this as a parameter with no
 * default). An optional context that quietly defaulted to some "unknown"
 * actor would make it easy to ship a mutation with a meaningless audit
 * trail entry; requiring it makes omitting it a compile error instead.
 */
export interface EventContext {
  actor: Actor;
  /** The session this mutation happens under, or `null` outside any session. */
  session: SessionId | null;
}

/**
 * What varies per call site: which of the 15 {@link EventVerb}s applies
 * (the caller's business — only the command knows whether an update is a
 * plain `ticket.updated` or a `ticket.state_changed`; see event.ts's
 * EVENT_VERBS doc) and any verb-specific payload. Deliberately does NOT
 * include `entity` — the mutation functions in tickets.ts/sessions.ts
 * already know exactly which entity they're writing (it's the same
 * ticket/session the caller is mutating), so asking the caller to repeat
 * it here would just be one more way for a payload to accidentally
 * disagree with the write it's describing.
 */
export interface MutationEventSpec {
  verb: EventVerb;
  payload?: Record<string, unknown>;
}

/**
 * The emit-on-mutation hook itself (A4). Runs `write` — the actual entity
 * file mutation — and then emits exactly one event describing it. This is
 * the mechanism the acceptance criterion ("every repo mutation in tests
 * produces exactly one ordered event") depends on: tickets.ts's
 * `createTicket`/`updateTicket` and sessions.ts's `createSession`/
 * `updateSession` are ALL implemented in terms of this function, so the
 * guarantee is a property of calling them, not a convention every future
 * caller has to remember to uphold — the same reasoning that put A3's
 * index auto-heal inside `loadIndex` rather than at every read call site.
 *
 * Ordering is deliberate:
 *   1. `write()` runs first. If it throws, no event is emitted — nothing
 *      happened, so there is nothing to record, and the caller sees the
 *      original error (e.g. `updateTicket` against a nonexistent ticket
 *      throws NOT_FOUND and no event file is ever written).
 *   2. Only once the entity write has genuinely landed on disk (atomic
 *      tmp+rename, per atomic-write.ts) does this mint and write the
 *      event, via {@link createEvent}.
 *
 * What this does NOT provide: cross-file atomicity between the entity
 * write and its event. design.md §3 only promises atomicity *within* a
 * single file (tmp+rename); nothing in this design makes "write the
 * ticket" and "write its event" one indivisible unit. If the process is
 * killed — or the event write itself fails (disk full, etc.) — in the
 * narrow window after step 1 completes but before step 2's `createEvent`
 * call finishes, the entity mutation stands and its event is missing.
 * This is the same trade-off multi-mutation transactions under `.lock`
 * (lock.ts) already accept: `withLock` guarantees mutual exclusion between
 * concurrent transactions, not crash atomicity across the files one
 * transaction touches. Calling this repeatedly inside one `withLock` body
 * (B4's done-cascade) composes correctly for the normal case — N calls
 * produce N durable, immutable events — and on a *thrown* error partway
 * through, every mutation that already completed keeps both its entity
 * write and its event; nothing is rolled back (events are immutable by
 * design, so there is nothing TO roll back) and the transaction's
 * remaining mutations simply never happen. See tests/acceptance/A4.test.ts
 * for both properties exercised directly.
 */
export async function withMutationEvent(
  paths: RepoPaths,
  ctx: EventContext,
  entity: EventEntity,
  spec: MutationEventSpec,
  write: () => Promise<void>,
  clock: Clock = systemClock,
): Promise<Event> {
  await write();
  const event: Event = {
    id: newEventId(),
    actor: ctx.actor,
    session: ctx.session,
    verb: spec.verb,
    entity,
    payload: spec.payload ?? {},
    at: clock.now().toISOString(),
  };
  await createEvent(paths, event);
  return event;
}

// --- A4: ULID cursor query -------------------------------------------------

export interface EventQuery {
  /**
   * Exclusive cursor: only events with an id strictly greater (later, per
   * ULID ordering) than this are returned. This is the cursor D3's `slop
   * events --since <event_…>` passes straight through.
   */
  since?: EventId;
  /**
   * Only events about this ticket — `entity.kind === "ticket" &&
   * entity.id === ticket`. Session-lifecycle events are NOT pulled in
   * even when the session belongs to this ticket; this is A4's minimal,
   * unambiguous reading of design.md §4.2's `--ticket <ref>` filter — D3
   * can widen it later if the dogfood week wants ticket-scoped session
   * events too.
   */
  ticket?: TicketId;
  /** Cap the number of events returned, applied last (after `since`/`ticket` filtering), preserving ULID order. */
  limit?: number;
}

/**
 * The cursor query D3's `slop events --since <event_…> [--ticket <ref>]
 * [--json]` builds directly on. Always returns events in the same total,
 * stable ULID order {@link listEvents} does (design.md §3: "Event
 * ordering cursors on the event ULID itself").
 *
 * Cursor stability across a ticket `index.jsonc` rebuild holds for free:
 * events are immutable, ordered by their own id, and — deliberately, see
 * db-index.ts and this work item's report — entirely independent of
 * `index.jsonc`'s content fingerprint, so rebuilding the ticket index can
 * never change what this function returns for a given query. See
 * tests/acceptance/A4.test.ts for that property exercised directly.
 */
export async function queryEvents(paths: RepoPaths, query: EventQuery = {}): Promise<Event[]> {
  let events = await listEvents(paths);
  if (query.since !== undefined) {
    const since = query.since;
    events = events.filter((event) => event.id > since);
  }
  if (query.ticket !== undefined) {
    const ticket = query.ticket;
    events = events.filter((event) => event.entity.kind === "ticket" && event.entity.id === ticket);
  }
  if (query.limit !== undefined) {
    events = events.slice(0, query.limit);
  }
  return events;
}
