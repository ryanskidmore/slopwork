/**
 * Building `JsoncPatchEntry[]` arrays (core/jsonc.ts's `writeUpdate` input)
 * from two {@link Session} snapshots — work item C1's equivalent of
 * `src/tickets/patch.ts`'s `diffTicketPatch`, for the one thing C1 ever
 * patches on an *existing* session file: ending it (`ended_at` +
 * `end_summary`), either via `stop` or via being superseded by a
 * `--takeover`. Reuses `tickets/patch.ts`'s exported `deepEqualJson`
 * rather than re-implementing structural equality a third time.
 */
import type { JsoncPatchEntry } from "../core/jsonc.js";
import type { Session } from "../core/index.js";
import { deepEqualJson } from "../tickets/patch.js";

/** Every field C1 ever mutates on an existing session via `updateSession`. */
export const SESSION_END_FIELDS = [
  "ended_at",
  "end_summary",
] as const satisfies readonly (keyof Session)[];

/** One patch entry per field in `fields` whose value differs between
 * `before` and `after` (deep-equality) — mirrors `tickets/patch.ts`'s
 * `diffTicketPatch`, generic over {@link Session} instead of `Ticket`. */
export function diffSessionPatch(
  before: Session,
  after: Session,
  fields: readonly (keyof Session)[] = SESSION_END_FIELDS,
): JsoncPatchEntry[] {
  const patch: JsoncPatchEntry[] = [];
  for (const key of fields) {
    if (!deepEqualJson(before[key], after[key])) {
      patch.push({ path: [key], value: after[key] });
    }
  }
  return patch;
}
