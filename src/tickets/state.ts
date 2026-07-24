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
 * plus `dropped` (wontdo) from anywhere.
 *
 * ---------------------------------------------------------------------
 * Adversarial-review fix: `update --state` now performs ONLY `draft ⇄
 * open` (D13) — every other edge is a dedicated-command edge
 * ---------------------------------------------------------------------
 *
 * An earlier version of this table let `update --state` also perform
 * `open -> in_progress`, `in_progress -> open`, `review -> in_progress`,
 * and `-> dropped` directly, on the theory that those edges "need no
 * extra data" beyond a bare state write. That was wrong: every one of
 * them has a real, stateful side effect only a dedicated command
 * performs, and `update --state` — a generic, side-effect-free field
 * setter with no session/lock-aware machinery of its own — cannot
 * perform any of them without leaving the db incoherent:
 *
 *   - `-> in_progress` needs a brand-new session (harness+git capture,
 *     D9) — `slop start` (C1). Without one, the ticket would read
 *     `in_progress` with no `active_session`, invisible to `ready`
 *     (which requires `active_session === null`, so it wouldn't even
 *     show up there either) yet unable to be `start`ed without
 *     `--takeover`.
 *   - `in_progress -> open` (or `review -> open`) needs the active
 *     session ENDED (`ended_at`/`end_summary`) — `slop stop` (C1) /
 *     `slop done` (C3). Without that, `active_session` is left pointing
 *     at a session that's still "live" on file while the ticket itself
 *     has moved on — an orphaned session, invisible to every session
 *     -aware invariant.
 *   - `review -> in_progress` (D15's changes-requested re-entry) needs a
 *     FRESH session, not just a cleared `review` field — `slop start`
 *     again (C1/C3) is what actually creates the new session and closes
 *     the old one out with an honest `re_entry: true` audit trail. A bare
 *     `update --state in_progress` on a `review` ticket would silently
 *     reuse the review round's session, no fresh session, no `re_entry`
 *     flag anywhere — a second, unlogged "changes requested" path.
 *   - `-> dropped` needs the active session (if any) finalized AND B4's
 *     done-cascade run (dependents notified via `ticket.ready`) — `slop
 *     drop --reason …` (C3). Without either, a ticket can end up
 *     `dropped` while `active_session` still points at a live session
 *     (later `stop`/`done`/`start` would then operate on a
 *     terminal-but-not-really ticket — see the next paragraph), and
 *     dependents this ticket was blocking never learn they're unblocked.
 *
 * The concrete adversarial finding this closes: `start X` (in_progress,
 * `active_session: S`) → `update X --state dropped` used to leave the
 * ticket `dropped` with `active_session` STILL `S` and no cascade —
 * dependents never got `ticket.ready`, and a later `stop X` would then
 * perform `dropped -> open`, RESURRECTING a terminal ticket (since
 * `stop`'s own guard only ever checked `active_session !== null` plus
 * "not review", never "not already terminal" — there was no legal path
 * to `dropped-with-an-active-session` before this hole existed, so that
 * combination was never guarded against). Similarly, `update X --state
 * open` on an `in_progress` ticket used to leave `active_session` set on
 * an `open` ticket — invisible to `ready`, unable to be `start`ed again
 * without `--takeover`.
 *
 * `to === "review"`/`to === "done"` were ALREADY excluded before this fix
 * (C3's original addendum, kept verbatim below) for the identical reason
 * (MR data / session finalization + cascade this mutator doesn't have).
 * This fix simply applies that same reasoning consistently to every other
 * edge that turns out to need dedicated-command machinery too, so
 * `update --state` is left with exactly the one pair of edges design.md
 * D13 actually describes as side-effect-free field flips: `draft ⇄ open`.
 * Same-state (`from === to`) stays a legal no-op regardless of `from`/
 * `to` — including on a terminal ticket — unchanged from before: a
 * no-op mutates nothing, so it can never produce an incoherent db.
 *
 * C3 owns the FULL machine (session creation/finalization, cascade,
 * takeover warnings, review nagging) — it should feel free to replace this
 * table wholesale, or to keep layering its own richer checks in front of
 * this one. This file's only promise is: never allow more than §2 plainly
 * allows AND never allow a transition this mutator can't perform coherently.
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

/** Direct transitions `update --state` can perform on its own — exactly
 * D13's `draft ⇄ open` edge (see this module's doc, "adversarial-review
 * fix", for why every other §2 edge needs a dedicated command instead).
 * Terminal states (`done`, `dropped`) and the two session-carrying states
 * (`in_progress`, `review`) have no outgoing edges here — leaving either
 * of the latter two requires ending/replacing an active session, which
 * only `stop`/`done`/`review`/`start` (never this generic mutator) may do. */
export const RAW_STATE_TRANSITIONS: Record<TicketState, readonly TicketState[]> = {
  draft: ["open"],
  open: ["draft"],
  in_progress: [],
  review: [],
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
 * already-open ticket shouldn't be an error) — checked FIRST, before
 * anything else, including on a terminal ticket (a same-state no-op on a
 * `done`/`dropped` ticket mutates nothing, so it can never produce an
 * incoherent db).
 *
 * Ordering below matters (adversarial-review finding, minor): the
 * terminal-state check runs BEFORE the dedicated-command messages for
 * `to === "dropped"/"review"/"done"/"in_progress"`, so `update
 * <done-ticket> --state review` reports "is a terminal state", the
 * accurate reason, rather than the misleading "use `slop review --mr`"
 * (which implies the transition would work via the dedicated command from
 * this state too — it wouldn't; `checkReviewEntry` rejects `done` the
 * same way). Previously the dedicated-command checks ran first regardless
 * of `from`, so a terminal ticket got the wrong message.
 */
export function checkStateTransition(from: TicketState, to: TicketState): StateTransitionCheck {
  if (from === to) return { ok: true };

  if (from === "done" || from === "dropped") {
    return {
      ok: false,
      reason: `"${from}" is a terminal state; no further state changes are possible`,
    };
  }

  if (to === "dropped") {
    return {
      ok: false,
      reason:
        "`dropped` finalizes the active session (if any) and cascades unblocks to dependents " +
        "(B4) — `update --state` cannot do either; use `slop drop <ref> --reason …` instead " +
        "(work item C3)",
    };
  }
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
  if (to === "in_progress") {
    return {
      ok: false,
      reason:
        "`in_progress` creates a session (harness + git capture, D9) that `update --state` has " +
        "no way to supply; use `slop start <ref>` instead (work item C1)",
    };
  }

  // Only "draft"/"open" targets remain at this point (every other target
  // was excluded above). Leaving `in_progress`/`review` this way — even
  // to "open" — would either orphan the still-set active session (state
  // moves on, `active_session` doesn't) or bypass the session
  // finalization/re-entry machinery only the dedicated commands perform;
  // see this module's doc, "adversarial-review fix", for the full
  // reasoning and the concrete hole this closes.
  if (from === "in_progress") {
    return {
      ok: false,
      reason:
        '"in_progress" has an active session (D9) that only a dedicated command may end or replace ' +
        "— use `slop stop <ref>` to hand it back to open, `slop review --mr <url>` to send it to " +
        "review, or `slop done <ref>` to complete it (work items C1/C3)",
    };
  }
  if (from === "review") {
    return {
      ok: false,
      reason:
        '"review" still carries an active session (D15) that only a dedicated command may end or ' +
        "replace — use `slop done <ref>` to close it out, or `slop start <ref>` to re-enter as a " +
        "changes-requested round, logged (work item C3)",
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
