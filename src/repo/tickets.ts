/**
 * Ticket entity CRUD over `<root>/.slop/db/tickets/ticket_<ulid>.jsonc`
 * (design.md §3).
 */
import { join } from "node:path";
import type { JsoncPatchEntry } from "../core/jsonc.js";
import { type Ticket, type TicketId, isTicketId, ticketSchema } from "../core/index.js";
import {
  createEntityFileCanonical,
  deleteEntityFile,
  listEntityIds,
  readEntityFile,
  updateEntityFile,
} from "./entity-file.js";
import type { RepoPaths } from "./paths.js";

export function ticketFilePath(paths: RepoPaths, id: TicketId): string {
  return join(paths.ticketsDir, `${id}.jsonc`);
}

export async function readTicket(paths: RepoPaths, id: TicketId): Promise<Ticket> {
  return readEntityFile(ticketFilePath(paths, id), ticketSchema);
}

/** New ticket file. Always canonical — see entity-file.ts's doc. */
export async function createTicket(paths: RepoPaths, ticket: Ticket): Promise<void> {
  await createEntityFileCanonical(ticketFilePath(paths, ticket.id), ticket);
}

/**
 * Update an existing ticket file, preserving human comments where
 * possible (S3/A2's `writeUpdate`). `expectedAfter` is the full ticket
 * the patch is supposed to produce — always pass the real domain object,
 * never blindly stringify over a hand-edited file.
 */
export async function updateTicket(
  paths: RepoPaths,
  id: TicketId,
  patch: JsoncPatchEntry[],
  expectedAfter: Ticket,
): Promise<void> {
  await updateEntityFile(ticketFilePath(paths, id), patch, expectedAfter);
}

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
