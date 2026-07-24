/**
 * `slop draft`/`slop undraft` (B2) — the two "sugar" commands design.md
 * §4.2 lists over §2's `draft ⇄ open` edge (D13: "drafts never `ready`").
 * Per §4.2's own framing ("`update <ref> …` general mutator; verbs below
 * are sugar"), the actual transition — legality, the resulting ticket,
 * the JSONC patch, and the event verb/payload — is entirely
 * `update.ts`'s `buildUpdate`, called from the CLI command modules with
 * `{state: "draft"}` / `{state: "open"}`. `buildUpdate` already reuses
 * `state.ts`'s `checkStateTransition` (the seam B1's brief describes: "do
 * not duplicate the legality table") for the transition itself, so
 * nothing in this file re-implements or shadows §2's state diagram.
 *
 * What THIS file adds is the one thing reusing `buildUpdate` alone can't
 * express: `draft`/`undraft` are sugar for one SPECIFIC edge, not "any
 * transition that happens to land on open/draft". Concretely:
 *   - `checkStateTransition(from, "draft")` is already only legal from
 *     `"open"` (or the same-state `"draft"` no-op) — `"draft"` appears in
 *     exactly one state's allowed-target list (`open`'s, `state.ts`'s
 *     `RAW_STATE_TRANSITIONS`), so `assertDraftable` below can never
 *     diverge from that table. It exists purely to give `draft` its own
 *     actionable error text instead of `update`'s more generic one.
 *   - `checkStateTransition(from, "open")` is legal from exactly `"draft"`
 *     (this IS undraft) and the same-state `"open"` no-op —
 *     `state.ts`'s adversarial-review fix closed the third case this
 *     comment used to warn about (`"in_progress" -> "open"`, `stop`'s
 *     edge: `checkStateTransition` itself now rejects it, pointing at
 *     `slop stop`/`slop done`, since leaving `in_progress` this way would
 *     orphan the active session). `assertUndraftable` below is therefore
 *     no longer load-bearing against THAT specific case — but it stays,
 *     both for defense-in-depth (a second, independent guard against the
 *     exact same mistake) and because it gives `undraft` its own
 *     actionable, ticket-specific error text instead of `update`'s more
 *     generic one, the same rationale `assertDraftable` above already
 *     has. Mirrors `sessions/stop.ts`'s `assertStoppable`, which layers
 *     its own precondition (`active_session !== null`) in front of the
 *     generic machinery rather than trusting it alone.
 */
import type { Ticket } from "../core/index.js";
import { EXIT_CODES } from "../core/index.js";
import { SlopError } from "../cli/errors.js";

function describeTicketRef(t: Pick<Ticket, "slug" | "name">): string {
  return `${t.slug} ("${t.name}")`;
}

/**
 * `slop draft <ref>`: legal only from `"open"` (design.md §2/D13's
 * `draft ⇄ open` edge), or a same-state no-op call on a ticket already
 * `"draft"` (idempotent — `state.ts`'s own "same-state is always legal"
 * convention). Every other state is rejected here with a message naming
 * this specific edge, before `buildUpdate`/`checkStateTransition` ever
 * run — see this module's doc for why this can never disagree with the
 * real legality table.
 */
export function assertDraftable(ticket: Ticket): void {
  if (ticket.state === "open" || ticket.state === "draft") return;
  throw new SlopError(
    `cannot draft ${describeTicketRef(ticket)}: state is "${ticket.state}", not "open" — ` +
      'design.md §2/D13\'s "draft ⇄ open" edge only applies to open tickets ' +
      `(ticket ${ticket.id})`,
    EXIT_CODES.CONFLICT,
  );
}

/**
 * `slop undraft <ref>`: legal only from `"draft"`, or a same-state no-op
 * on an already-`"open"` ticket. `state.ts`'s `checkStateTransition`
 * itself now also rejects `"in_progress" -> "open"` (see this module's
 * doc), so this guard is defense-in-depth rather than the last line of
 * defense it used to be — but it still gives `undraft` its own
 * ticket-specific, actionable error text instead of `update`'s generic
 * one, exactly like {@link assertDraftable}'s.
 */
export function assertUndraftable(ticket: Ticket): void {
  if (ticket.state === "draft" || ticket.state === "open") return;
  throw new SlopError(
    `cannot undraft ${describeTicketRef(ticket)}: state is "${ticket.state}", not "draft" — ` +
      `undraft only applies to draft tickets (ticket ${ticket.id})`,
    EXIT_CODES.CONFLICT,
  );
}
