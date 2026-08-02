/**
 * `slop split <ref> "sub1" "sub2" …` (B2) — pure(-ish) domain orchestration
 * for building ONE split child, mirroring B1's `new.ts` split exactly:
 * this module reads the repo (slug uniqueness, edge validation against
 * the live ticket set) but never writes anything — `src/cli/commands/
 * split.ts` owns looping over every requested name, writing each child
 * under one `.lock` transaction (design.md §3: "multi-file transactions"),
 * emitting events, and printing.
 *
 * ## Provenance (B2's decision — left open by B1; see new.ts's own doc
 * comment, which names this exact call)
 *
 * Every split child's `provenance` is `{method: "split", created_by:
 * actor, split_from: <the split target's id>}` — `provenanceSchema`
 * (core/entities/ticket.ts) reserves `split_from` for exactly this case,
 * and it is set here and ONLY here (never for `new`, `draft`/`undraft`,
 * or an `edit`).
 *
 * ## The two edges every child carries (design.md §4.1 items 1-2; this
 * work item's literal acceptance criterion)
 *
 *   - `parent = <split target's id>` — the STRUCTURAL tree edge. `root_id`/
 *     `path` are computed from it via `parent.ts`'s `ancestryFor`, called
 *     here with a synthetic `{kind: "local", ticket: parent}` resolution
 *     (the split target is always a local ticket — `<ref>` is resolved by
 *     the CLI layer via `resolveTicketRef` before this module ever runs,
 *     exactly like `new`'s `--parent` local case). D1 falls out of this
 *     for free: if the split target's OWN parent is external (`jira:…`),
 *     the split target is already its own local root (D1: "external
 *     parents terminate the local tree"), so the child simply becomes one
 *     level below that local root — `ancestryFor` never needs to know or
 *     care that the grandparent is external.
 *   - `discovered_from = [<split target's id>]` — the PROVENANCE edge:
 *     "this ticket came out of splitting that one." Distinct in kind from
 *     `parent` even though both name the same ticket here — see
 *     edges.ts's module doc for why `parent` (structural) and
 *     `discovered-from` (historical) are never conflated, and B1's
 *     `--discovered-from` flag for the general (non-split) case this
 *     mirrors.
 *
 * ## Inheritance from the split target (B2's decision — kept deliberately
 * small and easy to reason about; NOT the point of this work item's
 * acceptance criterion, which is about parent/discovered-from)
 *
 *   - **Inherited, verbatim: `labels`, `priority`.** A split child is the
 *     same underlying work, just broken into a smaller piece — carrying
 *     forward what team/type it belongs to and how urgent it is is the
 *     predictable default; either can be changed per-child afterward via
 *     `slop update <child> --label ±x --priority N`.
 *   - **NOT inherited — always the same default `new` uses with no
 *     override:**
 *     - `owner`: always `null`. `split` has no `--owner` override (design.md
 *       §4.2's signature is just `slop split <ref> "sub1" "sub2"`), and
 *       D1's root-ownership question is about roots specifically — quietly
 *       propagating a human owner down through every split, at any depth,
 *       is not what D1 asks for.
 *     - `adhoc`: always `false`. D13's `adhoc` means "created outside
 *       normal planning" — a split is ITSELF an act of planning (a
 *       deliberate breakdown of known work), so its children are never
 *       adhoc regardless of whether the split target happened to be.
 *     - `state`: always `"open"`, regardless of the split target's current
 *       state (even `draft`/`done`/`dropped`) — every child starts ready
 *       to be worked; nothing about the target's own state should be
 *       silently inherited onto a brand-new ticket.
 *     - `spec`: always `defaultSpec(childName)` — the same name-derived
 *       default `new` builds with no `--spec` flag. Copying the parent's
 *       spec verbatim into every child would be actively misleading (each
 *       child is a different slice of the work, not a duplicate of the
 *       whole); a human/agent fills each child's spec in afterward via
 *       `slop update <child> --spec -` or `slop edit`.
 */
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { Actor, Ticket } from "../core/index.js";
import { EXIT_CODES, newTicketId, nowIso, ticketSchema } from "../core/index.js";
import type { StorageBackend } from "../storage/backend.js";
import { SlopError } from "../cli/errors.js";
import { validateTicketEdges } from "./edges.js";
import { ancestryFor } from "./parent.js";
import type { ParentResolution } from "./parent.js";
import { pickSlug } from "./slug.js";
import { defaultSpec } from "./spec.js";
import { formatZodIssuesForUsage } from "./validate.js";

export interface BuildSplitChildInput {
  /** One of `slop split <ref> "sub1" "sub2" …`'s name arguments. */
  name: string;
  /** The already-resolved split target (`<ref>`) — the CLI layer resolves
   * this once, up front, and reuses it for every child in the batch. */
  parent: Ticket;
  actor: Actor;
}

export interface BuildSplitChildResult {
  ticket: Ticket;
}

/**
 * Build (never persist) ONE split child. See this module's doc for the
 * exact provenance/edge/inheritance shape. Throws:
 *   - a USAGE_ERROR `SlopError` if `input.name` is blank after trimming,
 *     or if the assembled candidate otherwise fails `ticketSchema` (e.g.
 *     an over-long name). The blank-name case is checked explicitly,
 *     UP FRONT, rather than left to `ticketSchema.safeParse` below to
 *     catch: `defaultSpec` (spec.ts, B1) derives the spec's `summary` from
 *     the same (trimmed) name and calls a THROWING `specSchema.parse`
 *     internally — a blank name would otherwise surface as an uncaught
 *     raw `ZodError` out of `defaultSpec`, before this function ever gets
 *     to its own `ticketSchema.safeParse`/`SlopError` handling. The CLI
 *     layer (`src/cli/commands/split.ts`) already rejects every blank name
 *     across the whole batch before acquiring the lock at all — this is
 *     the same check, kept here too so this function's own documented
 *     contract ("throws USAGE_ERROR", not "may throw a raw ZodError") is
 *     true for any caller, not just the CLI's.
 *   - a CONFLICT (exit 6) `SlopError` from `edges.ts`'s
 *     `validateTicketEdges` — structurally always a no-op here (a
 *     brand-new id, one freshly-set `parent` + a one-element
 *     `discovered_from`, can never already be named by anything else's
 *     edges, so neither cycle check nor the degree cap can ever fire),
 *     kept for the same "one uniform validated-write code path" reasoning
 *     `buildNewTicket` documents rather than special-casing it away.
 *
 * `backend` is read (not written): `pickSlug` for a live, collision-safe
 * slug, and a fresh `listTickets` for edge validation against the CURRENT
 * on-disk set — both of which is exactly why the CLI layer must build
 * -then-write each child in sequence, one at a time, rather than building
 * the whole batch before persisting any of it (see split.ts's own doc):
 * only that ordering makes "the live taken-set" (B2's brief) actually live
 * across a multi-name split.
 */
export async function buildSplitChild(
  backend: StorageBackend,
  input: BuildSplitChildInput,
  clock: Clock = systemClock,
): Promise<BuildSplitChildResult> {
  if (input.name.trim().length === 0) {
    throw new SlopError(
      `invalid ticket\n  name: sub-ticket name must be non-blank, got ${JSON.stringify(input.name)}`,
      EXIT_CODES.USAGE_ERROR,
    );
  }

  const id = newTicketId();
  const parentResolution: ParentResolution = { kind: "local", ticket: input.parent };
  const ancestry = ancestryFor(parentResolution, id);
  const slug = await pickSlug(backend, input.name);
  const now = nowIso(clock);

  const candidate = {
    id,
    name: input.name,
    slug,
    spec: defaultSpec(input.name),
    state: "open" as const,
    priority: input.parent.priority,
    labels: input.parent.labels,
    adhoc: false,
    parent: ancestry.parent,
    blocks: [],
    relates_to: [],
    discovered_from: [input.parent.id],
    root_id: ancestry.rootId,
    path: ancestry.path,
    active_session: null,
    last_activity_at: now,
    latest_note: null,
    owner: null,
    provenance: {
      method: "split" as const,
      created_by: input.actor,
      split_from: input.parent.id,
    },
    created_at: now,
    updated_at: now,
  };

  const parsed = ticketSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SlopError(
      formatZodIssuesForUsage("invalid ticket", parsed.error),
      EXIT_CODES.USAGE_ERROR,
    );
  }

  // B3: same uniform pre-persist validation `buildNewTicket` runs — see
  // this function's doc for why it's structurally a no-op for a split
  // child specifically, and why it still runs anyway.
  const others = await backend.listTickets();
  validateTicketEdges(parsed.data, others);

  return { ticket: parsed.data };
}
