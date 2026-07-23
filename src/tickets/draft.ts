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
 *   - `checkStateTransition(from, "open")` is legal from THREE states:
 *     `"draft"` (this IS undraft), `"open"` (a no-op), and — separately —
 *     `"in_progress"` (that's `stop`'s edge, `sessions/stop.ts`, a
 *     different command with different side effects, session
 *     finalization included). Reusing `buildUpdate` alone for `undraft`
 *     would therefore silently also accept `in_progress -> open`, letting
 *     `slop undraft <ref>` masquerade as a half-working `stop`. This is
 *     the one place this module's guard is NOT redundant with the table —
 *     `assertUndraftable` below rules that case out explicitly, the same
 *     way `sessions/stop.ts`'s `assertStoppable` layers its own
 *     precondition (`active_session !== null`) in front of the generic
 *     machinery rather than trusting it alone.
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
 * on an already-`"open"` ticket. See this module's doc for why this guard
 * — unlike {@link assertDraftable}'s — is load-bearing: without it,
 * `undraft` on an `"in_progress"` ticket would silently succeed via the
 * generic transition table, masquerading as `stop`.
 */
export function assertUndraftable(ticket: Ticket): void {
  if (ticket.state === "draft" || ticket.state === "open") return;
  throw new SlopError(
    `cannot undraft ${describeTicketRef(ticket)}: state is "${ticket.state}", not "draft" — ` +
      `undraft only applies to draft tickets (ticket ${ticket.id})`,
    EXIT_CODES.CONFLICT,
  );
}
