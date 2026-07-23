/**
 * Building `JsoncPatchEntry[]` arrays (core/jsonc.ts's `writeUpdate` input)
 * from two {@link Ticket} snapshots — shared by `update` (B1: a handful of
 * known-touchable fields) and `edit` (B1: every field, since a raw JSONC
 * hand-edit can touch anything). `updateTicket`/`writeUpdate`'s own
 * safety net (reparse + deep-equal against the full `expectedAfter`
 * object, falling back to a canonical rewrite on any mismatch — see
 * core/jsonc.ts) means these patches never need to be perfectly minimal
 * to be correct; they only need to *contain* every field that actually
 * changed, which is what {@link diffTicketPatch} guarantees.
 */
import type { JsoncPatchEntry } from "../core/jsonc.js";
import type { Ticket } from "../core/index.js";

/**
 * Every top-level {@link Ticket} field, as a `Record<keyof Ticket, true>`
 * so TypeScript flags this list at compile time if `Ticket`'s field set
 * ever changes without updating it here (a plain array typed as
 * `(keyof Ticket)[]` would only catch *extra* keys, not missing ones).
 */
const TICKET_FIELD_MARKERS: Record<keyof Ticket, true> = {
  id: true,
  name: true,
  slug: true,
  spec: true,
  state: true,
  review: true,
  priority: true,
  labels: true,
  adhoc: true,
  parent: true,
  blocks: true,
  relates_to: true,
  discovered_from: true,
  root_id: true,
  path: true,
  active_session: true,
  last_activity_at: true,
  latest_note: true,
  owner: true,
  provenance: true,
  created_at: true,
  updated_at: true,
};
export const TICKET_FIELDS = Object.keys(TICKET_FIELD_MARKERS) as (keyof Ticket)[];

/** Structural deep-equality over plain JSON-shaped values — a local
 * equivalent of core/jsonc.ts's private `deepEqualJsonValue` (not
 * exported; see this module's doc for why it isn't reused directly). */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqualJson(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord).sort();
    const bKeys = Object.keys(bRecord).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
    }
    return aKeys.every((key) => deepEqualJson(aRecord[key], bRecord[key]));
  }
  return false;
}

/**
 * One patch entry per field in `fields` whose value differs between
 * `before` and `after` (deep-equality) — `undefined` in `after` becomes a
 * delete entry (`writeUpdate`'s documented semantics), which is exactly
 * what clearing `ticket.review` on a review -> in_progress re-entry needs.
 */
export function diffTicketPatch(
  before: Ticket,
  after: Ticket,
  fields: readonly (keyof Ticket)[],
): JsoncPatchEntry[] {
  const patch: JsoncPatchEntry[] = [];
  for (const key of fields) {
    if (!deepEqualJson(before[key], after[key])) {
      patch.push({ path: [key], value: after[key] });
    }
  }
  return patch;
}

/** Every field of `ticket`, unconditionally, as a patch — `edit`'s
 * "replace everything" write (see edit.ts): correct regardless of which
 * fields a raw hand-edit actually touched, and never less safe than a
 * targeted diff because `writeUpdate`'s reparse-and-deep-equal safety net
 * (core/jsonc.ts) falls back to a full canonical rewrite on any mismatch. */
export function fullFieldPatch(ticket: Ticket): JsoncPatchEntry[] {
  return TICKET_FIELDS.map((key) => ({ path: [key], value: ticket[key] }));
}
