/**
 * t-trqk9: deterministic repair planning for duplicate slugs
 * (`src/repo/db-index.ts`'s `DuplicateSlugProblem[]`) — the pure half of
 * `slop reindex --heal`'s slug-healing (`src/cli/commands/reindex.ts` does
 * the actual reads/writes, under the write transaction). Pure, no I/O, so
 * the repair RULE is independently unit-testable from the read/write
 * plumbing around it.
 *
 * The rule, stated once here rather than left implicit in `reindex.ts`:
 * the OLDEST ticket in each duplicate-slug group (by id — ULIDs sort
 * chronologically, same "age" convention `tickets/ready.ts`'s
 * `compareReadyOrder` documents) keeps the slug unchanged; every OTHER
 * (newer) ticket in the group is re-suffixed via `core/slug.ts`'s existing
 * `nextAvailableSlug` — the exact same `-2`/`-3`/... collision rule a
 * brand-new `slop new` already uses when its own slug collides with one
 * already on disk. Nothing new to learn: a duplicate slug heals exactly
 * the way a fresh collision would have been avoided in the first place.
 */
import type { TicketId } from "../core/index.js";
import { nextAvailableSlug } from "../core/slug.js";
import type { DuplicateSlugProblem } from "../repo/db-index.js";

export interface SlugHealPlan {
  id: TicketId;
  from: string;
  to: string;
}

/**
 * Plan a re-suffix for every ticket in `problems` EXCEPT each group's
 * oldest (`problem.ids[0]` — db-index.ts's `buildIndex` already sorts each
 * group ascending by id before recording it, so this function trusts that
 * ordering rather than re-sorting). `takenSlugs` must be every slug
 * currently claimed anywhere in the db (e.g. `Object.keys(index.slugs)`,
 * which already holds each duplicated slug exactly once — `buildIndex`
 * collapses a duplicate group to one map entry). Assigned suffixes are
 * added to the working `taken` set immediately, so a slug with 3+
 * duplicates (or two independent duplicated slugs that happen to produce
 * the same first suffix candidate) never plans two tickets onto the same
 * new slug.
 */
export function planSlugHeal(
  problems: readonly DuplicateSlugProblem[],
  takenSlugs: ReadonlySet<string>,
): SlugHealPlan[] {
  const taken = new Set(takenSlugs);
  const plans: SlugHealPlan[] = [];
  for (const problem of problems) {
    // ids[0] is the oldest (ascending-id order, per this function's own
    // documented precondition) — it keeps the slug untouched.
    for (let i = 1; i < problem.ids.length; i++) {
      const id = problem.ids[i];
      if (id === undefined) continue; // unreachable: i < problem.ids.length
      const newSlug = nextAvailableSlug(problem.slug, taken);
      taken.add(newSlug);
      plans.push({ id, from: problem.slug, to: newSlug });
    }
  }
  return plans;
}
