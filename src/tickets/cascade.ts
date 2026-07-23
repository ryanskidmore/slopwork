/**
 * B4's done-cascade (design.md §2, §3 "`.slop/db/.lock` for multi-file
 * transactions (done-cascade, reparent)"; this work item's acceptance
 * criterion: "close 1, verify N flip + events") — the reusable function
 * C3's `done`/`drop` commands call once they've durably written a ticket's
 * terminal state.
 *
 * ## What this module does NOT do
 *
 * This does NOT implement `done`/`drop`/`review` (C3's job — see the B4
 * brief's ground rules) and does NOT itself write the closed ticket's own
 * state change. **The caller must already have durably written `state:
 * "done"` (or `"dropped"`) to the closed ticket's file — under the SAME
 * `withLock` acquisition it passes in here — before calling
 * {@link cascadeOnClose}.** {@link cascadeOnClose} throws if it finds the
 * named ticket still in a live state, precisely to catch a caller that got
 * this order wrong (see "Preconditions" below).
 *
 * ## Recompute-from-truth, not a mutated counter
 *
 * `blocked_count` is never stored anywhere that could be decremented — D5:
 * "blocked"/"stale" derived, never asserted; there is no field on `Ticket`
 * to hold a running counter, and `index.jsonc` itself is a pure,
 * gitignored derivative rebuilt from entity files (db-index.ts's module
 * doc), never hand-mutated in place. So this function does not "decrement
 * a counter by one" for whatever the closed ticket was blocking — it
 * re-reads EVERY ticket fresh from disk (`listTicketsTolerant`) and calls
 * `db-index.ts`'s `computeBlockedCounts` over that live snapshot, the
 * exact same pure function `buildIndex` uses to fill the index's own
 * `blocked_count` column.
 *
 * This is deliberately the safer of the two designs the work item's brief
 * offered ("recompute blocked_count for affected tickets rather than
 * trusting a stored counter you mutate, unless you can prove the counter
 * stays consistent"): a naive "decrement by one, flip to ready at zero"
 * would be WRONG for a diamond — ticket X blocked by both A and B; closing
 * A must NOT flip X to unblocked while B is still live, which a bare
 * decrement gets right only by accident (it needs to *also* know X had
 * more than one live blocker before this closure, i.e. it needs the very
 * live-blocker-count computation this design just does directly). Proving
 * a mutated/decremented counter stays correct under concurrent closures of
 * A and B racing each other is strictly harder than re-deriving the truth
 * from scratch each time, and re-deriving costs nothing extra here — a
 * fresh ticket scan this function needs anyway. It is also self-healing by
 * construction: idempotent. Calling it twice for the same closure (e.g. a
 * caller retrying after an ambiguous failure) computes the exact same
 * "who's newly unblocked" answer both times relative to the ON-DISK state
 * at call time — the SECOND call finds nothing new to do, because the
 * first call's `ticket.ready` events don't change any ticket's state.
 *
 * ## Which tickets are even candidates
 *
 * Only the closed ticket's OWN `blocks` array needs checking — never a
 * wider graph walk. Closing ticket C can only ever change ticket X's live
 * -blocked-count if C was itself one of X's blockers (i.e. `C.blocks`
 * names X); nothing else about C's closure touches any OTHER ticket's
 * blocker set (B is unaffected by A closing, and vice versa, regardless of
 * how deep the graph is beyond them). So {@link cascadeOnClose} restricts
 * its recomputation's *output* to `closedTicket.blocks`, even though the
 * truth-recompute it calls (`computeBlockedCounts`) is itself O(all
 * tickets) — cheap at v0's target scale, and correct regardless of graph
 * shape.
 *
 * ## Locking contract (A3's fencing contract — `src/repo/lock.ts`)
 *
 * {@link cascadeOnClose} takes an ALREADY-ACQUIRED {@link LockHandle} — it
 * does NOT call `withLock` itself. A second `acquireLock` on the SAME lock
 * file from the SAME process, while the first is still held, would
 * deadlock (`O_EXCL` creation fails immediately with `EEXIST`, and the
 * only process that could break the "stale" lock is the very one blocked
 * waiting on it). The caller (C3) must invoke this from INSIDE its own
 * `withLock(paths.lockFile, ...)` block, after already writing the closed
 * ticket's terminal state under that same acquisition — this makes "write
 * the closed ticket" + "cascade its unblocks" one transaction, so a
 * concurrent second closure racing the same graph (e.g. closing both
 * blockers of a diamond at once, from two different processes) can never
 * observe — or produce — a torn intermediate state. Every event this
 * function writes is preceded by `lock.assertHeld()` (A3's fencing
 * contract: "every call site that performs more than one write inside a
 * single withLock block MUST call the handle's assertHeld() between
 * writes") — a transaction that ran long enough to be declared stale and
 * reclaimed by someone else fails loudly here (`SlopError`, CONFLICT) the
 * moment it tries its next write, instead of silently continuing.
 *
 * ## Failure semantics on a partial cascade
 *
 * Events are immutable and independent — there is no multi-event "commit"
 * — so a crash or dispossession partway through (after N of
 * `newlyUnblocked.length` events have been written) leaves exactly N
 * `ticket.ready` events durable and the rest simply never written; nothing
 * is rolled back (the same trade-off `events.ts`'s `withMutationEvent`
 * already documents for a single mutation+event pair, generalised here to
 * N independent event writes under one lock). This is SAFE, not merely
 * tolerated, because of the recompute-from-truth design above: nothing
 * about `blocked_count`/`ready` is EVER left inconsistent by a partial
 * cascade — those columns are recomputed fresh by the very next
 * `loadIndex()`/`buildIndex()` call regardless of how many `ticket.ready`
 * events made it out, so the graph itself is never torn, only the EVENT
 * LOG's "who got notified" bookkeeping can be incomplete. The concrete
 * consequence: a watcher/agent relying SOLELY on `ticket.ready` events
 * (rather than periodically polling `slop ready`) could miss a
 * notification for a ticket that in fact became unblocked. Re-running the
 * SAME cascade is always safe (idempotent, see above), but this function
 * does not self-retry — a caller (C3) that wants at-least-once delivery of
 * `ticket.ready` after a failure should re-invoke {@link cascadeOnClose}
 * for the same `closedTicketId` (a no-new-work call is cheap and correct),
 * NOT re-run the whole `done`/`drop` command, which would try to write the
 * already-closed ticket's state a second time.
 *
 * ## Preconditions (enforced, not just documented)
 *
 * Throws `SlopError` (`GENERIC_ERROR`) if `closedTicketId` cannot be found
 * on disk, or is found but is NOT already in a closed (`done`/`dropped`)
 * state. Both indicate a caller bug — this function invoked before, or
 * without, the closing write it depends on — not a normal runtime
 * condition, so this fails loudly rather than silently computing a cascade
 * against a ticket that (from this function's point of view) never
 * actually closed.
 */
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { Event, Ticket, TicketId } from "../core/index.js";
import { EXIT_CODES, newEventId } from "../core/index.js";
import { SlopError } from "../cli/errors.js";
import {
  computeBlockedCounts,
  createEvent,
  isLiveBlockerState,
  listTicketsTolerant,
} from "../repo/index.js";
import type { EventContext, LockHandle, RepoPaths, TicketReadProblem } from "../repo/index.js";

export interface CascadeOnCloseResult {
  /** Tickets that flipped open+blocked -> open+unblocked as a direct
   * result of this closure, ascending id (= creation) order. Every one of
   * these got exactly one `ticket.ready` event — same order, same length,
   * as `events`. */
  unblocked: TicketId[];
  /** The `ticket.ready` events emitted, one per `unblocked` entry, same order. */
  events: Event[];
  /** Ticket files skipped while re-reading the db for this cascade (see
   * db-index.ts's "Fault tolerance") — normally `[]`. The cascade still
   * runs against every ticket it COULD read; the caller may want to warn
   * about these (e.g. via db-index.ts's `formatIndexProblems`). */
  problems: TicketReadProblem[];
}

function buildTicketReadyEvent(
  ticketId: TicketId,
  closedTicketId: TicketId,
  ctx: EventContext,
  clock: Clock,
): Event {
  return {
    id: newEventId(),
    actor: ctx.actor,
    session: ctx.session,
    verb: "ticket.ready",
    entity: { kind: "ticket", id: ticketId },
    payload: { unblocked_by: closedTicketId },
    at: clock.now().toISOString(),
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/**
 * Run the done-cascade for a ticket whose terminal state (`done` or
 * `dropped`) the caller has ALREADY durably written to disk, under the
 * SAME `lock` acquisition passed in here — see this module's doc for the
 * full locking contract, the recompute-from-truth design, and the failure
 * semantics of a partial cascade.
 *
 * For every ticket `closedTicketId.blocks` names that is `open` and whose
 * freshly-recomputed live `blocked_count` is now `0`, emits one
 * `ticket.ready` event (`payload: { unblocked_by: closedTicketId }`).
 * Tickets still blocked by something else (a diamond) are left alone — see
 * module doc, "Which tickets are even candidates".
 */
export async function cascadeOnClose(
  paths: RepoPaths,
  closedTicketId: TicketId,
  ctx: EventContext,
  lock: LockHandle,
  clock: Clock = systemClock,
): Promise<CascadeOnCloseResult> {
  const { tickets, problems } = await listTicketsTolerant(paths);

  const closedTicket = tickets.find((t) => t.id === closedTicketId);
  if (closedTicket === undefined) {
    throw new SlopError(
      `cascadeOnClose: ${closedTicketId} was not found on disk — the caller must durably write its ` +
        "closed (done/dropped) state before invoking the cascade",
      EXIT_CODES.GENERIC_ERROR,
    );
  }
  if (isLiveBlockerState(closedTicket.state)) {
    throw new SlopError(
      `cascadeOnClose: ${closedTicketId} is still "${closedTicket.state}" on disk, not done/dropped — ` +
        "the caller must write its closed state before invoking the cascade",
      EXIT_CODES.GENERIC_ERROR,
    );
  }

  const blockedCounts = computeBlockedCounts(tickets);

  const candidateIds = [...new Set(closedTicket.blocks)];
  const newlyUnblocked = candidateIds
    .map((id) => tickets.find((t) => t.id === id))
    .filter((t): t is Ticket => isDefined(t))
    .filter((t) => t.state === "open" && (blockedCounts.get(t.id) ?? 0) === 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const events: Event[] = [];
  for (const ticket of newlyUnblocked) {
    await lock.assertHeld();
    const event = buildTicketReadyEvent(ticket.id, closedTicketId, ctx, clock);
    await createEvent(paths, event);
    events.push(event);
  }

  return { unblocked: newlyUnblocked.map((t) => t.id), events, problems };
}
