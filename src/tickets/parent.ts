/**
 * `--parent <ref>` resolution for `slop new` (B1) — a local ref (full id /
 * slug / short prefix, via `resolveTicketRef`) or an external ref like
 * `jira:PROJ-123` (D1: "External parents from day one"). Also computes the
 * resulting `root_id`/`path` (D6), since that computation is entirely
 * determined by which of the three cases above applies.
 */
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { Ticket, TicketId } from "../core/index.js";
import { EXIT_CODES, isTicketId, nowIso } from "../core/index.js";
import { EXTERNAL_REF_PATTERN, checkJiraRefFormat } from "../core/entities/ref.js";
import type { RepoPaths } from "../repo/paths.js";
import { resolveTicketRef } from "../repo/refs.js";
import { SlopError } from "../cli/errors.js";
import { deepEqualJson } from "./patch.js";

export type ParentResolution =
  | { kind: "none" }
  | { kind: "external"; ref: string; warning?: string }
  | { kind: "local"; ticket: Ticket };

/**
 * Resolve `raw` (the `--parent` flag's value, or `undefined` if omitted).
 * An external-shaped ref (`<system>:<key>`, e.g. `jira:PROJ-123`) is never
 * looked up locally — it's accepted as-is, with `checkJiraRefFormat`'s
 * warn-only format check attached (design.md §8.2 item 5: "warn on format
 * mismatch, don't block" — a malformed `jira:` ref still returns a `kind:
 * "external"` result here, just with `warning` set; it is the caller's job
 * to print that warning and proceed regardless). Anything else is resolved
 * as a local ref via `resolveTicketRef` (full id / slug / short prefix,
 * per D12/D6/§8.1 item 5) — which throws NOT_FOUND / AMBIGUOUS_REF /
 * USAGE_ERROR exactly as any other local-ref lookup would.
 */
export async function resolveParentRef(
  paths: RepoPaths,
  raw: string | undefined,
): Promise<ParentResolution> {
  if (raw === undefined) return { kind: "none" };
  if (EXTERNAL_REF_PATTERN.test(raw)) {
    const check = checkJiraRefFormat(raw);
    return { kind: "external", ref: raw, warning: check.warning };
  }
  const ticket = await resolveTicketRef(paths, raw);
  return { kind: "local", ticket };
}

export interface Ancestry {
  /** The value to store on `ticket.parent` — `undefined` for no parent at all. */
  parent: string | undefined;
  rootId: TicketId;
  path: TicketId[];
}

/**
 * D6/D1: for a local parent, inherit `root_id`/`path` from it (this
 * ticket's path is the parent's path plus the parent itself). For an
 * external parent OR no parent at all, this ticket has no local ancestor
 * to inherit from, so it becomes its own local root with an empty path —
 * D1's "external parents terminate the local tree" restated as the
 * `root_id`/`path` computation. `selfId` is the new ticket's own freshly
 * -minted id (the caller mints it before calling this, since a "none"/
 * "external" result needs it for `root_id`).
 */
export function ancestryFor(resolution: ParentResolution, selfId: TicketId): Ancestry {
  if (resolution.kind === "local") {
    return {
      parent: resolution.ticket.id,
      rootId: resolution.ticket.root_id,
      path: [...resolution.ticket.path, resolution.ticket.id],
    };
  }
  if (resolution.kind === "external") {
    return { parent: resolution.ref, rootId: selfId, path: [] };
  }
  return { parent: undefined, rootId: selfId, path: [] };
}

export interface ReparentResult {
  /** `candidate` with `root_id`/`path` recomputed from its (possibly new) `parent` field — every other field untouched. */
  ticket: Ticket;
  /**
   * Every EXISTING ticket whose `root_id`/`path` must change as a result —
   * i.e. every descendant of `candidate` in the pre-write tree (`others`,
   * before this write lands). Empty when `changed` is `false`. Each entry
   * has ONLY `root_id`/`path`/`updated_at` touched relative to its
   * corresponding entry in `others`.
   */
  descendants: Ticket[];
  /**
   * `true` iff `candidate`'s own `root_id`/`path` actually differ from
   * what they were before — i.e. whether this write is a genuine reparent
   * (needs the multi-file transaction below) or an ancestry no-op (a
   * plain single-file write suffices; `descendants` is always `[]` in
   * that case).
   */
  changed: boolean;
}

/**
 * B3: recompute `root_id`/`path` for `candidate` (from its own, possibly
 * new, `parent` field) and for every one of its EXISTING descendants —
 * design.md D6's materialised ancestry, kept internally consistent across
 * a reparent rather than trusted from whatever a hand-edit (`slop edit`)
 * typed into those two fields directly. `root_id`/`path` are therefore
 * always SERVER-computed from `parent`, never taken at face value from a
 * candidate that came from outside this function — this closes the class
 * of corruption where a hand-edit changes `parent` without updating
 * `root_id`/`path` to match, or types a `root_id`/`path` that doesn't
 * agree with the parent chain at all.
 *
 * Descendants are found by scanning `others` (every OTHER ticket
 * currently on disk — the pre-write state) for any ticket whose CURRENT
 * `path` contains `candidate.id` — every level below `candidate`, not
 * just direct children. Each descendant's new ancestry is computed by
 * splicing candidate's NEW path in place of its old prefix (the portion
 * of the descendant's own path from the root down to and including
 * `candidate`); the portion of its path *below* `candidate` — which
 * encodes structure that hasn't changed — is preserved verbatim.
 *
 * PRECONDITION, enforced by the caller and NOT re-checked here:
 * `edges.ts`'s `assertNoParentCycle` and `assertEdgeTargetsExist` must
 * already have confirmed `candidate`'s new `parent` is acyclic and (if
 * local) resolves to a ticket in `others`. This function trusts that —
 * calling it first is what keeps this whole computation O(1) for
 * `candidate` itself (inherit the parent's already-trusted `root_id`/
 * `path` directly) plus a single O(n) scan for descendants, rather than a
 * repeated walk.
 *
 * Pure, no I/O. `clock` only stamps descendants' `updated_at` — a
 * reparent cascade is a genuine change to what's persisted in each
 * descendant's file, so `updated_at` should move; `last_activity_at` is
 * deliberately left untouched, since nothing in the §2 "activity" sense
 * (progress, state) happened to a descendant caught in the cascade.
 */
export function recomputeAncestry(
  candidate: Ticket,
  others: readonly Ticket[],
  clock: Clock = systemClock,
): ReparentResult {
  const rest = others.filter((t) => t.id !== candidate.id);
  const byId = new Map(rest.map((t) => [t.id, t] as const));

  let newRootId: TicketId;
  let newPath: TicketId[];
  if (candidate.parent !== undefined && isTicketId(candidate.parent)) {
    const parentTicket = byId.get(candidate.parent);
    if (!parentTicket) {
      // Should already have been rejected by edges.ts's
      // assertEdgeTargetsExist before this function is ever called — see
      // this function's documented precondition. A defensive throw
      // instead of silently producing nonsense ancestry.
      throw new SlopError(
        `recomputeAncestry: ${candidate.id}'s parent ${candidate.parent} is not present in the given ticket set`,
        EXIT_CODES.GENERIC_ERROR,
      );
    }
    newRootId = parentTicket.root_id;
    newPath = [...parentTicket.path, parentTicket.id];
  } else {
    newRootId = candidate.id;
    newPath = [];
  }

  const changed = newRootId !== candidate.root_id || !deepEqualJson(newPath, candidate.path);
  const updatedCandidate: Ticket = changed
    ? { ...candidate, root_id: newRootId, path: newPath }
    : candidate;

  if (!changed) {
    return { ticket: updatedCandidate, descendants: [], changed: false };
  }

  const now = nowIso(clock);
  const descendants: Ticket[] = [];
  for (const t of rest) {
    const idx = t.path.indexOf(candidate.id);
    if (idx === -1) continue; // not a descendant of candidate
    const relative = t.path.slice(idx + 1);
    descendants.push({
      ...t,
      root_id: newRootId,
      path: [...newPath, candidate.id, ...relative],
      updated_at: now,
    });
  }

  return { ticket: updatedCandidate, descendants, changed: true };
}
