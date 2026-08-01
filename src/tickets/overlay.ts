/**
 * The ONE shared derived-overlay module (G2, unify-effective-overlay):
 * every pure fold that turns stored entities into derived, never-asserted
 * overlay values lives here — consumed by BOTH the flatfile driver's index
 * build (`src/repo/db-index.ts`) and the web explorer
 * (`src/web/overlays.ts`), which previously each carried their own copy
 * and had already drifted once (E1's web/CLI review-staleness divergence).
 *
 * Everything in this module is pure and I/O-free: plain functions over
 * `Ticket`/`Event` values from `src/core/`. That's what makes it safe for
 * both consumers — it drags none of the repo layer's locking/persistence
 * machinery into the web package, and none of the web package's rendering
 * concerns into the driver. It sits in `src/tickets/` beside its sibling
 * pure domain modules (`staleness.ts`, `ready.ts`, `state.ts`) — the same
 * placement precedent C5 set when `staleness.ts` became the one shared
 * staleness formula.
 *
 * What lives here:
 *  - {@link deriveEffectiveOverlay} / {@link deriveEffectiveTickets} — the
 *    effective `latest_note`/`last_activity_at` fold (a lock-free
 *    `update --progress` appends an event and never rewrites the ticket
 *    file; every read path folds those events back in — see
 *    docs/concurrency-and-merging.md).
 *  - {@link computeBlockedCounts} / {@link isLiveBlockerState} — the live
 *    blocked-by derivation (D5: "blocked" is derived, never asserted, and
 *    never a decremented counter — a decrement is provably wrong for a
 *    diamond dependency).
 *  - {@link computeReady} — design.md §2's ready verdict, verbatim.
 *  - {@link buildReverseEdgeIndex} — the reverse-edge derivation (edges
 *    are stored only on their source ticket; "who blocks me" is always
 *    derived by scanning outgoing edges and inverting).
 */
import type { Event, Ticket, TicketId, TicketState } from "../core/index.js";
import { isTicketId, outgoingEdges } from "../core/index.js";

/** {@link deriveEffectiveOverlay}'s result — the two fields that are
 * derived (event-folded), not stored-verbatim. */
export interface EffectiveOverlay {
  latest_note: string | null;
  last_activity_at: string;
}

/** The minimal ticket-shaped input {@link deriveEffectiveOverlay} needs. */
export interface EffectiveOverlaySource {
  latest_note: string | null;
  last_activity_at: string;
}

/**
 * Fold a ticket's stored baseline together with every `payload.progress`
 * -carrying event for that same ticket, keeping whichever note is most
 * recent — this is the ONE place that combination happens; the driver's
 * `buildIndex` calls it per ticket over events already grouped by
 * `entity.id`, and the web explorer applies it across a list via
 * {@link deriveEffectiveTickets}.
 *
 * `events` MUST already be scoped to this one ticket (callers group every
 * event by `entity.id` once, up front, rather than filtering per row) — a
 * non-`"ticket"`-kind entry is skipped defensively, but this function
 * never checks `entity.id` itself. Order MUST be cursor (ascending id /
 * chronological): since two events can (rarely, under real concurrency)
 * share the same millisecond-resolution `at`, iterating in id order and
 * using `>=` (not `>`) to decide "this event is newer" means ties resolve
 * toward whichever event has the greater id — full determinism, without
 * needing the id itself as a second sort key.
 *
 * A LOCKED `update --progress` (progress alongside a real field change)
 * mints its accompanying event from the exact same clock reading used to
 * build the ticket it writes (`src/cli/commands/update.ts`), so that
 * event's `at` is never strictly greater than the ticket's own
 * `last_activity_at` — the `>=` comparison below can re-select it, but
 * only ever with content identical to the stored baseline it's tied with,
 * so the effective result is byte-for-byte the same either way. Only a
 * genuinely lock-free progress event (whose `at` is strictly later,
 * having never touched the ticket file's own baseline at all) can
 * actually move the result.
 */
export function deriveEffectiveOverlay(
  ticket: EffectiveOverlaySource,
  events: readonly Event[],
): EffectiveOverlay {
  let latestNote = ticket.latest_note;
  let lastActivityAt = ticket.last_activity_at;
  for (const event of events) {
    if (event.entity.kind !== "ticket") continue;
    const progress = event.payload.progress;
    if (typeof progress !== "string") continue;
    if (event.at >= lastActivityAt) {
      lastActivityAt = event.at;
      latestNote = progress;
    }
  }
  return { latest_note: latestNote, last_activity_at: lastActivityAt };
}

/**
 * Group `events` by ticket id once (O(events)) — the shared first phase of
 * every whole-db effective-overlay pass; both `buildIndex` and
 * {@link deriveEffectiveTickets} use it so a list-wide fold is always
 * O(tickets + events), never O(tickets × events).
 */
export function groupEventsByTicket(events: readonly Event[]): Map<TicketId, Event[]> {
  const eventsByTicket = new Map<TicketId, Event[]>();
  for (const event of events) {
    if (event.entity.kind !== "ticket" || !isTicketId(event.entity.id)) continue;
    const list = eventsByTicket.get(event.entity.id);
    if (list) list.push(event);
    else eventsByTicket.set(event.entity.id, [event]);
  }
  return eventsByTicket;
}

/**
 * Apply {@link deriveEffectiveOverlay} across a whole ticket list in one
 * O(tickets + events) pass. A ticket whose effective values are
 * byte-identical to its stored ones (the overwhelmingly common case) is
 * returned as the SAME object reference, not a needless copy.
 */
export function deriveEffectiveTickets(
  tickets: readonly Ticket[],
  events: readonly Event[],
): Ticket[] {
  const eventsByTicket = groupEventsByTicket(events);
  return tickets.map((ticket) => {
    const overlay = deriveEffectiveOverlay(ticket, eventsByTicket.get(ticket.id) ?? []);
    if (
      overlay.latest_note === ticket.latest_note &&
      overlay.last_activity_at === ticket.last_activity_at
    ) {
      return ticket;
    }
    return { ...ticket, ...overlay };
  });
}

/**
 * Ticket states that no longer block anything (D5's "blocked" derived
 * overlay). A blocker that has reached one of these states is CLOSED and
 * stops counting as a "live" blocker for whatever it names in its own
 * `blocks` array. Matches `src/tickets/state.ts`'s own treatment of
 * `done`/`dropped` as terminal.
 */
const CLOSED_TICKET_STATES: ReadonlySet<TicketState> = new Set(["done", "dropped"]);

/** Is a ticket in `state` still capable of blocking something? See {@link CLOSED_TICKET_STATES}. */
export function isLiveBlockerState(state: TicketState): boolean {
  return !CLOSED_TICKET_STATES.has(state);
}

/**
 * Live blocked-by count for every ticket in `tickets` — for each ticket,
 * how many OTHER tickets currently in a non-`done`/`dropped` state name it
 * in their own `blocks` array. Pure, synchronous, no I/O. Always has an
 * entry (possibly `0`) for every id in `tickets`.
 *
 * This is the ONE place `blocked_count` is computed: the driver's
 * `buildIndex` calls it over the full ticket set, and B4's done-cascade
 * (`src/tickets/cascade.ts`) calls it again over a freshly re-read ticket
 * set after a closure, instead of decrementing a number stored anywhere
 * (a decrement-by-one is provably wrong for a diamond dependency: closing
 * one of two live blockers must not flip a ticket to unblocked while the
 * other is still live).
 */
export function computeBlockedCounts(tickets: readonly Ticket[]): Map<TicketId, number> {
  const counts = new Map<TicketId, number>();
  for (const ticket of tickets) counts.set(ticket.id, 0);
  for (const blocker of tickets) {
    if (!isLiveBlockerState(blocker.state)) continue;
    for (const edge of outgoingEdges(blocker)) {
      if (edge.kind !== "blocks") continue;
      if (!isTicketId(edge.to)) continue; // "blocks" edges are always local (edge.ts) — defensive only
      if (!counts.has(edge.to)) continue; // target absent from this ticket set — shouldn't happen for a consistent db
      counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * design.md §2's `ready` verdict for a single ticket, verbatim —
 * `open ∧ no live blockers ∧ no active session`. Pure; the one place this
 * predicate is implemented, so the index's `ready` column and any other
 * caller (e.g. the done-cascade deciding whether a newly-unblocked ticket
 * deserves a `ticket.ready` event) always agree.
 */
export function computeReady(
  state: TicketState,
  liveBlockedCount: number,
  activeSession: string | null,
): boolean {
  return state === "open" && liveBlockedCount === 0 && activeSession === null;
}

/**
 * Every relationship's REVERSE direction — none of these are stored
 * (edges live only on their source ticket), so "who blocks me"/"who
 * relates to me"/"what got discovered here" all have to be derived by
 * scanning every ticket's outgoing edges and inverting. `parent`/
 * `children` has no entry here — D6's materialised `root_id`/`path`
 * already give ancestry without needing a "children of" index.
 */
export interface ReverseEdgeIndex {
  /** Tickets whose `blocks` array names the key ticket — i.e. who blocks it (any state, not just live). */
  blockedBy: ReadonlyMap<TicketId, TicketId[]>;
  /** Tickets whose `relates_to` array names the key ticket. */
  relatedFrom: ReadonlyMap<TicketId, TicketId[]>;
  /** Tickets whose `discovered_from` array names the key ticket — i.e. what was discovered while working the key ticket. */
  discovered: ReadonlyMap<TicketId, TicketId[]>;
}

function pushInto<K>(map: Map<K, TicketId[]>, key: K, value: TicketId): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

export function buildReverseEdgeIndex(tickets: readonly Ticket[]): ReverseEdgeIndex {
  const blockedBy = new Map<TicketId, TicketId[]>();
  const relatedFrom = new Map<TicketId, TicketId[]>();
  const discovered = new Map<TicketId, TicketId[]>();
  for (const ticket of tickets) {
    for (const edge of outgoingEdges(ticket)) {
      if (!isTicketId(edge.to)) continue; // only `parent` edges may be external (edge.ts) — irrelevant here
      if (edge.kind === "blocks") pushInto(blockedBy, edge.to, edge.from);
      else if (edge.kind === "relates-to") pushInto(relatedFrom, edge.to, edge.from);
      else if (edge.kind === "discovered-from") pushInto(discovered, edge.to, edge.from);
    }
  }
  return { blockedBy, relatedFrom, discovered };
}
