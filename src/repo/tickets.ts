/**
 * Ticket entity CRUD over `<root>/.slop/db/tickets/ticket_<ulid>.jsonc`
 * (design.md §3).
 *
 * A4: `createTicket`/`updateTicket` are the repo layer's sanctioned
 * ticket-mutation entry points, and both REQUIRE an `EventContext` and a
 * `MutationEventSpec` (events.ts) — every call is built on
 * `withMutationEvent`, so writing a ticket file and emitting the event
 * that describes it are not two separate steps a future caller can
 * forget one half of. `deleteTicket` is excluded from this: there is no
 * `ticket.deleted` verb in event.ts's closed `EVENT_VERBS`, and nothing
 * in the v0 command surface ever deletes a ticket, so it stays a plain,
 * event-free CRUD primitive (test cleanup / a future reparent tool) — the
 * same status events.ts's now-removed `deleteEvent` used to have.
 */
import { join } from "node:path";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import { type Event, type Ticket, type TicketId, isTicketId, ticketSchema } from "../core/index.js";
import type { JsoncPatchEntry } from "../core/jsonc.js";
import {
  createEntityFileCanonical,
  deleteEntityFile,
  listEntityIds,
  readEntityFile,
  updateEntityFile,
} from "./entity-file.js";
import type { EventContext, MutationEventSpec } from "./events.js";
import { withMutationEvent } from "./events.js";
import type { RepoPaths } from "./paths.js";

export function ticketFilePath(paths: RepoPaths, id: TicketId): string {
  return join(paths.ticketsDir, `${id}.jsonc`);
}

export async function readTicket(paths: RepoPaths, id: TicketId): Promise<Ticket> {
  return readEntityFile(ticketFilePath(paths, id), ticketSchema);
}

/**
 * Create a new ticket file, always canonical (see entity-file.ts's doc —
 * a brand-new file has nothing to preserve comments in), AND emit exactly
 * one event describing it (A4, via `withMutationEvent`). `ctx`/`event`
 * are required — see events.ts's `EventContext`/`MutationEventSpec` docs
 * for why emission is not optional here.
 */
export async function createTicket(
  paths: RepoPaths,
  ticket: Ticket,
  ctx: EventContext,
  event: MutationEventSpec,
  clock: Clock = systemClock,
): Promise<Event> {
  return withMutationEvent(
    paths,
    ctx,
    { kind: "ticket", id: ticket.id },
    event,
    () => createEntityFileCanonical(ticketFilePath(paths, ticket.id), ticket),
    clock,
  );
}

/**
 * Update an existing ticket file, preserving human comments where
 * possible (S3/A2's `writeUpdate`), AND emit exactly one event describing
 * it (A4). `expectedAfter` is the full ticket the patch is supposed to
 * produce — always pass the real domain object, never blindly stringify
 * over a hand-edited file. `ctx`/`event` are required, same rationale as
 * `createTicket`. If the underlying write fails (e.g. no such ticket —
 * NOT_FOUND), no event is emitted; see events.ts's `withMutationEvent`.
 */
export async function updateTicket(
  paths: RepoPaths,
  id: TicketId,
  patch: JsoncPatchEntry[],
  expectedAfter: Ticket,
  ctx: EventContext,
  event: MutationEventSpec,
  clock: Clock = systemClock,
): Promise<Event> {
  return withMutationEvent(
    paths,
    ctx,
    { kind: "ticket", id },
    event,
    () => updateEntityFile(ticketFilePath(paths, id), patch, expectedAfter),
    clock,
  );
}

/**
 * Delete a ticket file. NOT part of A4's emit-on-mutation guarantee — see
 * this module's doc for why (no `ticket.deleted` verb exists, and nothing
 * in the v0 command surface calls this for real work).
 */
export async function deleteTicket(paths: RepoPaths, id: TicketId): Promise<void> {
  await deleteEntityFile(ticketFilePath(paths, id));
}

/** Ticket ids present on disk, ascending (= chronological, ULIDs sort). */
export async function listTicketIds(paths: RepoPaths): Promise<TicketId[]> {
  return listEntityIds(paths.ticketsDir, isTicketId);
}

/**
 * Every ticket on disk, read and validated. Throws on the first ticket
 * file that fails to parse or validate (see entity-file.ts) — a
 * corrupt entity file is a real problem that should surface loudly to
 * whichever read path triggered this scan, not be silently skipped.
 */
export async function listTickets(paths: RepoPaths): Promise<Ticket[]> {
  const ids = await listTicketIds(paths);
  return Promise.all(ids.map((id) => readTicket(paths, id)));
}
