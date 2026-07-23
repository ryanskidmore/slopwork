/**
 * Actor (design.md §4.1 item 5: "name + kind"). Not a stored entity with
 * its own id or file — §3's db layout has no `actors/` directory — it's a
 * small embedded value object referenced wherever something needs to say
 * who did it: `ticket.owner`, `session.actor`, `event.actor`,
 * `ticket.review.by`, `ticket.provenance.created_by`.
 */
import { z } from "zod";

export const ACTOR_KINDS = ["human", "agent"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];
export const actorKindSchema = z.enum(ACTOR_KINDS);

export const actorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: actorKindSchema,
});
export type Actor = z.infer<typeof actorSchema>;

/**
 * D17 actor-identity resolution order (design.md decision D17):
 *
 *   1. `--as <name>` CLI flag
 *   2. `SLOP_ACTOR` environment variable
 *   3. `user:` in `.slop/config.yaml`
 *   4. `git config user.name`
 *
 * A2 owns the *shape* of this resolution rule (pure, no I/O) so it can't
 * silently get reordered by whichever work item happens to touch it
 * next. Actually reading the flag / env / config file / running `git
 * config` is I/O and belongs to A3+/C1 — they gather the four candidate
 * strings (in this order) and pass them here.
 */
export interface ActorNameCandidates {
  asFlag?: string | null;
  slopActorEnv?: string | null;
  configUser?: string | null;
  gitUserName?: string | null;
}

/** The first non-empty (post-trim) candidate, in D17 order, or `null` if none resolved. */
export function resolveActorName(candidates: ActorNameCandidates): string | null {
  const ordered = [
    candidates.asFlag,
    candidates.slopActorEnv,
    candidates.configUser,
    candidates.gitUserName,
  ];
  for (const candidate of ordered) {
    if (candidate != null && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}
