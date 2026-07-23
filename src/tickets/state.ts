/**
 * `update --state` transition legality (design.md §2's state diagram) —
 * the seam B1's brief asks for: "the full state machine is C3's; implement
 * what §2 plainly allows and leave a clear seam."
 *
 * §2's diagram:
 *
 *   draft ⇄ open ──start──▶ in_progress ──review --mr──▶ review ──done──▶ done
 *                ▲              │  ▲                       │
 *                └────stop──────┘  └──────start (changes requested)──────┘
 *
 * plus `dropped` (wontdo) from anywhere. Two of those edges need data this
 * generic, side-effect-free mutator doesn't have and B1 isn't building:
 *   - `in_progress -> review` needs an MR link + `review.by`/`requested_at`
 *     (D15) — `slop review --mr <url>` (C3).
 *   - `review -> done`/anything `-> done` needs session finalization +
 *     B4's done-cascade — `slop done` (C3).
 * Both are therefore treated as illegal *for this entry point* — always,
 * regardless of current state — with a message pointing at the dedicated
 * command that C3 will build. Every other edge in the diagram needs no
 * extra data (including `review -> in_progress`, the "changes requested"
 * re-entry: clearing `ticket.review` is all that transition requires, no
 * new information), so `update --state` implements those directly.
 *
 * C3 owns the FULL machine (session creation/finalization, cascade,
 * takeover warnings, review nagging) — it should feel free to replace this
 * table wholesale once `review`/`done` have real dedicated commands, or to
 * keep layering its own richer checks in front of this one. This file's
 * only promise is: never allow more than §2 plainly allows.
 */
import type { TicketState } from "../core/index.js";

/** Direct transitions `update --state` can perform on its own — every §2
 * edge except the two that need data this mutator doesn't have (see
 * module doc). Terminal states (`done`, `dropped`) have no outgoing edges. */
export const RAW_STATE_TRANSITIONS: Record<TicketState, readonly TicketState[]> = {
  draft: ["open", "dropped"],
  open: ["draft", "in_progress", "dropped"],
  in_progress: ["open", "dropped"],
  review: ["in_progress", "dropped"],
  done: [],
  dropped: [],
};

export interface StateTransitionCheck {
  ok: boolean;
  /** Present iff `ok` is `false` — an actionable, user-facing reason. */
  reason?: string;
}

/**
 * Is `from -> to` a transition `update --state` may perform directly?
 * Same-state is always legal (an idempotent no-op, not really a
 * "transition" at all — re-running `update --state open` on an
 * already-open ticket shouldn't be an error).
 */
export function checkStateTransition(from: TicketState, to: TicketState): StateTransitionCheck {
  if (from === to) return { ok: true };

  if (to === "review") {
    return {
      ok: false,
      reason:
        "`review` carries an MR link (D15) that `update --state` has no way to supply; " +
        "use `slop review --mr <url>` instead (work item C3)",
    };
  }
  if (to === "done") {
    return {
      ok: false,
      reason:
        "`done` finalizes the session and cascades unblocks (B4) — `update --state` cannot " +
        "do either; use `slop done` instead (work item C3)",
    };
  }
  if (from === "done" || from === "dropped") {
    return {
      ok: false,
      reason: `"${from}" is a terminal state; no further state changes are possible`,
    };
  }

  const allowed = RAW_STATE_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    const allowedList = allowed.length > 0 ? allowed.join(", ") : "(none)";
    return {
      ok: false,
      reason:
        `illegal transition "${from}" -> "${to}" (design.md §2); legal direct transitions ` +
        `from "${from}" via \`update --state\` are: ${allowedList}`,
    };
  }
  return { ok: true };
}
