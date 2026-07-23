/**
 * `slop edit <ref>` (B1): validating whatever `$EDITOR` handed back before
 * it's ever persisted. This is the module that decides "is this edit safe
 * to keep", not how the editor is spawned or where a rejected draft gets
 * parked — see `src/cli/commands/edit.ts` for that.
 */
import type { Ticket, TicketId } from "../core/index.js";
import { formatParseErrors, parseJsonc, ticketSchema } from "../core/index.js";
import { zodIssueLines } from "./validate.js";

export type EditValidation = { ok: true; ticket: Ticket } | { ok: false; errors: string[] };

/**
 * Parse + schema-validate the user's edited text, with one extra
 * ticket-specific rule on top of plain schema validity: `id` must stay
 * exactly `originalId`. A ticket's id names its own file
 * (`ticket_<id>.jsonc`) — letting a hand-edit change the `id` field inside
 * the file would desynchronize content from filename in a way nothing
 * else in this codebase guards against, so it's rejected here as firmly
 * as any other schema violation (same error-and-rollback path in
 * `src/cli/commands/edit.ts`, not a special case).
 */
export function validateEditedTicketText(raw: string, originalId: TicketId): EditValidation {
  const { value, errors } = parseJsonc<unknown>(raw);
  if (errors.length > 0) {
    return { ok: false, errors: formatParseErrors("<edited ticket>", raw, errors) };
  }

  const parsed = ticketSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, errors: zodIssueLines(parsed.error) };
  }

  if (parsed.data.id !== originalId) {
    return {
      ok: false,
      errors: [
        `  id: must remain "${originalId}" — a ticket's id is immutable (it names the file on disk)`,
      ],
    };
  }

  return { ok: true, ticket: parsed.data };
}
