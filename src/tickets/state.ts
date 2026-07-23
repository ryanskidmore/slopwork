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
 *
 * ---------------------------------------------------------------------
 * C3 addendum: the two excluded edges, checked here too
 * ---------------------------------------------------------------------
 *
 * C3 lands `slop review`/`slop done` — the dedicated commands the two
 * rejections above point at — and extends this file (rather than forking
 * a second table) with {@link checkReviewEntry}, {@link checkDoneEntry},
 * and {@link checkDropEntry}: three small, single-edge legality checks
 * that, together with {@link RAW_STATE_TRANSITIONS} above, cover every
 * edge in §2's diagram with nothing left implicit:
 *
 *   - `checkReviewEntry`: `in_progress -> review` (D15) — the one edge
 *     `to === "review"` above always rejects.
 *   - `checkDoneEntry`: `review -> done` (D15: "`done` closes review
 *     out"). §2's diagram draws NO direct `in_progress -> done` edge —
 *     the only path to `done` runs through `review` — matching design.md
 *     §5's house rule for agents ("open an MR and call `review` before
 *     claiming done"). This is C3's resolved v0 decision (the work item's
 *     brief explicitly allows either choice, provided it's enforced here
 *     and documented — see DECISIONS.md's C3 entry): `slop done` on an
 *     `in_progress` ticket is a CONFLICT, not a shortcut.
 *   - `checkDropEntry`: `-> dropped` (§2: "dropped (wontdo) from
 *     anywhere"). Legal from any non-terminal state — but, UNLIKE
 *     `checkStateTransition`'s generic same-state shortcut, dropping an
 *     ALREADY-`dropped` (or `done`) ticket is rejected, not silently
 *     accepted: `slop drop` is a real terminal action with side effects
 *     (session finalization, the done-cascade), not an idempotent field
 *     setter, so `checkStateTransition(current.state, "dropped")` (whose
 *     `from === to` shortcut would wrongly treat a second `slop drop` on
 *     an already-dropped ticket as a legal no-op) is deliberately NOT
 *     reused here.
 *
 * None of the three carries a same-state shortcut the way `draft`/
 * `undraft` (via `checkStateTransition`'s `from === to` rule) do — re
 * -running `slop review`/`slop done` on a ticket already at that state is
 * rejected, not a no-op: v0 stores exactly one MR per review round (§8.2
 * item 4), so there is no supported "update the MR while still in
 * review" flow, and `done`/`drop` are one-way, side-effecting actions
 * where "already there" is a genuine usage mistake worth surfacing, not
 * something to swallow silently.
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

/** Shared by all three C3 checks below — see this module's doc, "the two excluded edges, checked here too". */
function terminalStateCheck(from: TicketState): StateTransitionCheck | null {
  if (from === "done" || from === "dropped") {
    return {
      ok: false,
      reason: `"${from}" is a terminal state; no further state changes are possible`,
    };
  }
  return null;
}

/**
 * `in_progress -> review` (D15) — the sole legal entry into `review`,
 * matching §2's diagram exactly. `slop review` (C3) checks this directly
 * instead of routing through `checkStateTransition`, because — unlike
 * `update --state` — it DOES have what the transition needs (the MR
 * link, `review.by`/`requested_at`); it is exactly the "dedicated
 * command" `checkStateTransition`'s own `to === "review"` rejection
 * above points at. No same-state shortcut: see this module's doc.
 */
export function checkReviewEntry(from: TicketState): StateTransitionCheck {
  if (from === "in_progress") return { ok: true };
  const terminal = terminalStateCheck(from);
  if (terminal !== null) return terminal;
  if (from === "review") {
    return {
      ok: false,
      reason:
        'ticket is already in "review" (design.md §2 has no review -> review edge; v0 stores one MR ' +
        "per review round, §8.2 item 4) — run `slop done` to close it out, or `slop start` to re-enter " +
        "as a changes-requested round (D15)",
    };
  }
  return {
    ok: false,
    reason:
      `illegal transition "${from}" -> "review" (design.md §2); review is reachable only from ` +
      '"in_progress" — run `slop start` first',
  };
}

/**
 * `review -> done` (D15: "`done` closes review out") — the sole legal
 * entry into `done`. §2's diagram draws NO direct `in_progress -> done`
 * edge; this is C3's resolved v0 decision, matching design.md §5's house
 * rule ("open an MR and call review before claiming done") — see this
 * module's doc and DECISIONS.md's C3 entry. `slop done` (C3) checks this
 * directly for the same reason `checkReviewEntry` does: `update --state`
 * excludes `-> done` because it can't finalize the session/cascade this
 * transition needs (this module's top doc); the dedicated command both
 * has that machinery AND is the one place §2's review-gates-done rule can
 * be enforced. No same-state shortcut: see this module's doc.
 */
export function checkDoneEntry(from: TicketState): StateTransitionCheck {
  if (from === "review") return { ok: true };
  const terminal = terminalStateCheck(from);
  if (terminal !== null) return terminal;
  return {
    ok: false,
    reason:
      `illegal transition "${from}" -> "done" (design.md §2); done is reachable only from "review" — ` +
      'run `slop review --mr <url>` first (design.md §5: "open an MR and call review before claiming done")',
  };
}

/**
 * `-> dropped` (§2: "dropped (wontdo) from anywhere") — legal from any
 * non-terminal state, exactly once. Deliberately NOT implemented as
 * `checkStateTransition(from, "dropped")`: see this module's doc for why
 * that generic same-state shortcut is wrong for a real, side-effecting
 * action like `slop drop`.
 */
export function checkDropEntry(from: TicketState): StateTransitionCheck {
  const terminal = terminalStateCheck(from);
  if (terminal !== null) return terminal;
  return { ok: true };
}
