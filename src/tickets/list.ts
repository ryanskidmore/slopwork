/**
 * `slop list` (t-km7mb) — pure filter/sort logic over full {@link Ticket}s,
 * no I/O anywhere in this file (`src/cli/commands/list.ts` gathers the
 * tickets via `backend.listTicketsTolerant()`, resolves `--parent`/
 * `--subtree` refs, and calls into this module — same "pure core, thin CLI
 * shell" split `tickets/ready.ts`/`tickets/search.ts` already use).
 *
 * ## Why full `Ticket`s, not the derived index
 *
 * `ready`/`status` read `IndexTicketRow` (db-index.ts) — a per-ticket
 * summary row cheap to build in bulk. `list`'s brief explicitly requires a
 * free-text match against `name`/`slug`/`spec.summary` (mirroring the web
 * UI's own `q` filter, `src/web/api/tickets.ts`'s `matchesFilters`), and
 * `spec.summary` is never carried in the index row (it's ticket detail, not
 * a list-worthy summary field) — adding it would mean yet another
 * `INDEX_SCHEMA_VERSION` bump for one command's benefit. Reading full
 * tickets via the already-fault-tolerant `listTicketsTolerant()` (the same
 * primitive `slop search` already uses for the identical reason) is simpler
 * and needs no schema change; every other filter this module supports
 * (state/label/owner/priority/parent/subtree) is trivially available on a
 * plain `Ticket` too.
 *
 * ## Sort order — this ticket's acceptance criterion, verbatim: "deterministic
 * sort (state, then priority, then age)"
 *
 * 1. **state**, by {@link TICKET_STATES}' own declared order (`draft`,
 *    `open`, `in_progress`, `review`, `done`, `dropped`) — the same
 *    workflow-lifecycle order the state machine itself is defined in
 *    (core/entities/ticket.ts), so "list" reads roughly front-to-back
 *    through a ticket's life: what's being defined, what's workable, what's
 *    active, what's done.
 * 2. **priority**, ascending (0 urgent .. 3 low — design.md §8.1 item 4,
 *    same convention `tickets/ready.ts`'s `compareReadyOrder` documents).
 * 3. **age**, oldest first, via the ticket's own `id` — a ULID minted once
 *    at creation and never touched again, so ascending-id order IS
 *    ascending-creation-order to the millisecond, and (being globally
 *    unique by construction) a complete, gap-free tiebreak — same
 *    reasoning `tickets/ready.ts`'s `compareReadyOrder` documents at length
 *    for why this is preferred over adding a redundant sort column.
 */
import type { Ticket, TicketId, TicketState } from "../core/index.js";
import { TICKET_STATES } from "../core/index.js";

const STATE_ORDER = new Map<TicketState, number>(TICKET_STATES.map((state, i) => [state, i]));

/** See this module's doc, "Sort order". */
export function compareListOrder(a: Ticket, b: Ticket): number {
  const stateDiff = (STATE_ORDER.get(a.state) ?? 0) - (STATE_ORDER.get(b.state) ?? 0);
  if (stateDiff !== 0) return stateDiff;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface ListQueryOptions {
  /** OR across states — a ticket matching ANY given state passes. `[]`/`undefined` means no state filter (every state, including drafts — UNLIKE `ready`, `list` is a plain enumeration, not a "workable now" query, so it has no reason to hide drafts by default). */
  states?: readonly TicketState[];
  /** AND across labels — every given label must be present (matches `slop ready`'s own t-175oq semantics and the web UI's multi-select label filter). */
  labels?: readonly string[];
  /** Exact actor-name match (kind ignored — matches `sessionOwnershipWarning`'s identity axis and the web UI's owner filter). */
  owner?: string;
  priority?: number;
  /** DIRECT children only — `ticket.parent === parentId`. */
  parentId?: TicketId;
  /** The whole descendant tree rooted at `subtreeId`, INCLUSIVE of `subtreeId` itself — `ticket.id === subtreeId || ticket.path.includes(subtreeId)`. */
  subtreeId?: TicketId;
  /** Case-insensitive substring match against `name`/`slug`/`spec.summary`, joined into one haystack — same shape as the web UI's `q` filter (`src/web/api/tickets.ts`'s `matchesFilters`), not a multi-word AND scan the way `slop search` is (`list` is a filter, not a ranked search). */
  text?: string;
  /**
   * G4 (t-jggg9): the set of ticket ids currently `awaiting_input` (>=1
   * unanswered question) — event-derived, so this pure module can't
   * compute it itself; the CLI layer precomputes it once
   * (`overlay.ts`'s `computeAwaitingInputByTicket`) and passes it in, same
   * "pure module stays event-free" split as `deriveEffectiveOverlay`'s own
   * separation from `db-index.ts`. Always used for the `--awaiting-input`
   * filter below; also read by the CLI layer directly (not through this
   * module) to render each row's badge.
   */
  awaitingInputIds?: ReadonlySet<TicketId>;
  /** `--awaiting-input` — keep ONLY tickets present in `awaitingInputIds`. `undefined`/`false` applies no filter (unlike `ready`, `list` never excludes awaiting-input tickets by default — it's a plain browse, not a "workable now" query). */
  awaitingInput?: boolean;
}

function matchesStates(t: Ticket, states: readonly TicketState[] | undefined): boolean {
  return states === undefined || states.length === 0 || states.includes(t.state);
}

function matchesLabels(t: Ticket, labels: readonly string[] | undefined): boolean {
  return labels === undefined || labels.every((label) => t.labels.includes(label));
}

function matchesOwner(t: Ticket, owner: string | undefined): boolean {
  return owner === undefined || t.owner?.name === owner;
}

function matchesPriority(t: Ticket, priority: number | undefined): boolean {
  return priority === undefined || t.priority === priority;
}

function matchesParent(t: Ticket, parentId: TicketId | undefined): boolean {
  return parentId === undefined || t.parent === parentId;
}

function matchesSubtree(t: Ticket, subtreeId: TicketId | undefined): boolean {
  return subtreeId === undefined || t.id === subtreeId || t.path.includes(subtreeId);
}

function matchesText(t: Ticket, text: string | undefined): boolean {
  if (text === undefined || text.trim().length === 0) return true;
  const needle = text.toLowerCase();
  const haystack = `${t.name} ${t.slug} ${t.spec.summary}`.toLowerCase();
  return haystack.includes(needle);
}

/** G4: see {@link ListQueryOptions.awaitingInput}'s doc. */
function matchesAwaitingInput(
  t: Ticket,
  awaitingInput: boolean | undefined,
  awaitingInputIds: ReadonlySet<TicketId> | undefined,
): boolean {
  if (awaitingInput !== true) return true;
  return awaitingInputIds?.has(t.id) ?? false;
}

/** Apply every given filter (AND across filter KINDS; each filter's own
 * internal semantics are documented on {@link ListQueryOptions}), then sort
 * via {@link compareListOrder}. */
export function filterTickets(
  tickets: readonly Ticket[],
  options: ListQueryOptions = {},
): Ticket[] {
  return tickets
    .filter(
      (t) =>
        matchesStates(t, options.states) &&
        matchesLabels(t, options.labels) &&
        matchesOwner(t, options.owner) &&
        matchesPriority(t, options.priority) &&
        matchesParent(t, options.parentId) &&
        matchesSubtree(t, options.subtreeId) &&
        matchesText(t, options.text) &&
        matchesAwaitingInput(t, options.awaitingInput, options.awaitingInputIds),
    )
    .slice()
    .sort(compareListOrder);
}

export interface PagedResult<T> {
  /** The page itself — `items.slice(offset, limit === undefined ? undefined : offset + limit)`. */
  page: T[];
  /** Total matches BEFORE pagination (but after every filter) — what `--limit`/`--offset` are paging over. */
  total: number;
}

/** `--limit`/`--offset` over an already-filtered-and-sorted list — a plain
 * slice, split out as its own function (generic over `T`, not
 * `Ticket`-specific — pure index arithmetic) so `list.test.ts` can assert
 * on the pagination math independently of the filter/sort logic above. */
export function paginateTickets<T>(
  items: readonly T[],
  offset: number,
  limit: number | undefined,
): PagedResult<T> {
  const total = items.length;
  const page = limit === undefined ? items.slice(offset) : items.slice(offset, offset + limit);
  return { page, total };
}
