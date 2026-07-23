/**
 * Slug assignment for `slop new` (D12, B1: "slugs (+collision suffix)").
 * `core/slug.ts` (A2) already supplies the pure rules (`slugify`,
 * `nextAvailableSlug`); this is the thin I/O layer that gathers the real
 * "taken" set from the current index (A3's `loadIndex`, which self-heals
 * on every call — see db-index.ts) so the two compose into a real slug
 * assignment.
 */
import { nextAvailableSlug, slugify } from "../core/index.js";
import { loadIndex } from "../repo/db-index.js";
import type { RepoPaths } from "../repo/paths.js";

/** Every slug currently on disk, via the (self-healing) index. */
export async function takenSlugs(paths: RepoPaths): Promise<Set<string>> {
  const { index } = await loadIndex(paths);
  return new Set(Object.keys(index.slugs));
}

/** The slug a new ticket named `name` should get: `slugify(name)`, or
 * `-2`/`-3`/... appended if that base is already taken. */
export async function pickSlug(paths: RepoPaths, name: string): Promise<string> {
  const taken = await takenSlugs(paths);
  return nextAvailableSlug(slugify(name), taken);
}
