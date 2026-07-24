/**
 * `slop new` (B1) — assembling a brand-new, fully-validated {@link Ticket}
 * from the §4.2 creation flags. Pure domain orchestration: this module
 * does read the repo (parent/blocks/discovered-from ref resolution, slug
 * uniqueness) but never writes anything — `src/cli/commands/new.ts` owns
 * the write (`createTicket`, under `withLock` so slug assignment is race
 * -free across concurrent `new` calls) and all stdout/stderr formatting.
 */
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { Actor, Ticket, TicketId } from "../core/index.js";
import {
  EXIT_CODES,
  newTicketId,
  nextAvailableSlug,
  nowIso,
  parseExplicitSlug,
  ticketSchema,
} from "../core/index.js";
import type { RepoPaths } from "../repo/paths.js";
import { resolveTicketRef } from "../repo/refs.js";
import { listTickets } from "../repo/tickets.js";
import { SlopError } from "../cli/errors.js";
import { validateTicketEdges } from "./edges.js";
import { ancestryFor, resolveParentRef } from "./parent.js";
import { pickSlug, takenSlugs } from "./slug.js";
import { defaultSpec, parseSpecInput } from "./spec.js";
import { formatZodIssuesForUsage } from "./validate.js";

export interface NewTicketInput {
  name: string;
  /** Raw `--spec` text (already read from stdin if `--spec -` was given), or `undefined` if `--spec` was omitted entirely. */
  specRaw?: string;
  /** Raw `--parent` ref text, or `undefined` if omitted. */
  parentRaw?: string;
  /** Raw `--blocks` ref texts (repeatable). */
  blocksRaw: string[];
  /**
   * Raw `--relates-to` ref texts (repeatable) — mirrors `blocksRaw`
   * exactly: `relates-to` is a symmetric, non-cycle-checked edge
   * (edges.ts's module doc), so there's nothing direction-sensitive about
   * resolving it the same way `blocks` is resolved.
   */
  relatesToRaw: string[];
  /** Raw `--discovered-from` ref text, or `undefined` if omitted. */
  discoveredFromRaw?: string;
  labels: string[];
  draft: boolean;
  adhoc: boolean;
  /** Raw `--owner` name, or `undefined` if omitted. */
  ownerRaw?: string;
  priority: number;
  actor: Actor;
  /**
   * Raw `--slug` value (D12: short, branch-style handles), or `undefined`
   * if omitted — the common case, where the slug is auto-generated from
   * `name` (see {@link resolveSlug}). When given, it's validated/
   * normalized by `parseExplicitSlug` (core/slug.ts) rather than derived
   * from `name` at all: an explicit slug like `fix/ui-not-showing` is
   * taken as the caller's chosen handle, not a name to slugify.
   */
  slugRaw?: string;
}

export interface NewTicketResult {
  ticket: Ticket;
  /** Non-fatal notices to surface to the user — currently only a malformed-`jira:`-ref format warning (§8.2 item 5). */
  warnings: string[];
}

/**
 * D12: the slug a new ticket gets — an explicit `--slug` when given,
 * otherwise auto-generated from `name` (`pickSlug`, unchanged). Either way
 * runs through the SAME collision rule (`nextAvailableSlug` against the
 * real on-disk "taken" set): an explicit `--slug` that collides with an
 * existing ticket is disambiguated with a `-2`/`-3`/... suffix exactly
 * like an auto-generated one, never rejected and never silently
 * overwriting — "uniqueness preserved" applies uniformly, not just to the
 * auto-slug path. An invalid `--slug` (bad charset, more than one `/`,
 * leading/trailing separators, too long, empty) is rejected as a
 * USAGE_ERROR (exit 2) via `parseExplicitSlug` before uniqueness is even
 * considered.
 */
async function resolveSlug(paths: RepoPaths, input: NewTicketInput): Promise<string> {
  if (input.slugRaw === undefined) {
    return pickSlug(paths, input.name);
  }
  let base: string;
  try {
    base = parseExplicitSlug(input.slugRaw);
  } catch (err) {
    throw new SlopError(err instanceof Error ? err.message : String(err), EXIT_CODES.USAGE_ERROR);
  }
  const taken = await takenSlugs(paths);
  return nextAvailableSlug(base, taken);
}

/**
 * Build (but do not persist) the new ticket. Throws:
 *   - whatever `resolveTicketRef` throws (NOT_FOUND/AMBIGUOUS_REF/USAGE_ERROR)
 *     for an unresolvable `--parent`/`--blocks`/`--relates-to`/`--discovered-from`
 *     local ref;
 *   - a USAGE_ERROR `SlopError` if `--slug` is given but malformed (see
 *     {@link resolveSlug}), or if the assembled candidate fails
 *     `ticketSchema` validation (bad priority, empty name, an over-long
 *     label, ...) — every field-level constraint funnels through one
 *     final validation pass rather than being hand-checked piecemeal;
 *   - a CONFLICT (exit 6) `SlopError` (B3, `edges.ts`'s `validateTicketEdges`)
 *     if `--blocks`/`--relates-to` would exceed the per-ticket per-edge-kind
 *     degree cap. A cycle is structurally impossible at creation time — a
 *     brand-new id can't already be named by anything else's edges — but
 *     the same validation call runs here anyway for one uniform code path
 *     shared with `edit`'s re-validation, rather than a special-cased
 *     subset.
 */
export async function buildNewTicket(
  paths: RepoPaths,
  input: NewTicketInput,
  clock: Clock = systemClock,
): Promise<NewTicketResult> {
  const warnings: string[] = [];

  const spec =
    input.specRaw !== undefined
      ? parseSpecInput(input.specRaw, input.name)
      : defaultSpec(input.name);

  const parentResolution = await resolveParentRef(paths, input.parentRaw);
  if (parentResolution.kind === "external" && parentResolution.warning) {
    warnings.push(parentResolution.warning);
  }

  // Edges are a set, not a multiset (edges.ts's `assertDegreeCap` rejects
  // a duplicate target as an error on `edit`'s re-validation path) — so a
  // repeated `--blocks` naming the same ticket twice is deduped here
  // rather than surfaced as a creation-time error, which would be a
  // needlessly hostile reaction to a harmless repeated flag/copy-paste.
  const blocks: TicketId[] = [];
  const seenBlocks = new Set<TicketId>();
  for (const ref of input.blocksRaw) {
    const target = await resolveTicketRef(paths, ref);
    if (!seenBlocks.has(target.id)) {
      seenBlocks.add(target.id);
      blocks.push(target.id);
    }
  }

  // `--relates-to`: same resolution + dedup treatment as `--blocks` above
  // (edges are a set, not a multiset) — the only difference is which
  // ticket field the resolved ids land in.
  const relatesTo: TicketId[] = [];
  const seenRelatesTo = new Set<TicketId>();
  for (const ref of input.relatesToRaw) {
    const target = await resolveTicketRef(paths, ref);
    if (!seenRelatesTo.has(target.id)) {
      seenRelatesTo.add(target.id);
      relatesTo.push(target.id);
    }
  }

  const discoveredFrom: TicketId[] = [];
  if (input.discoveredFromRaw !== undefined) {
    const target = await resolveTicketRef(paths, input.discoveredFromRaw);
    discoveredFrom.push(target.id);
  }

  const id = newTicketId();
  const ancestry = ancestryFor(parentResolution, id);
  const slug = await resolveSlug(paths, input);
  const now = nowIso(clock);

  const candidate = {
    id,
    name: input.name,
    slug,
    spec,
    state: input.draft ? ("draft" as const) : ("open" as const),
    priority: input.priority,
    labels: input.labels,
    adhoc: input.adhoc,
    parent: ancestry.parent,
    blocks,
    relates_to: relatesTo,
    discovered_from: discoveredFrom,
    root_id: ancestry.rootId,
    path: ancestry.path,
    active_session: null,
    last_activity_at: now,
    latest_note: null,
    owner: input.ownerRaw !== undefined ? { name: input.ownerRaw, kind: "human" as const } : null,
    // Always "new": D13's draft/adhoc creation affordances are already
    // fully captured by `state`/`adhoc` above, so `--draft`/`--adhoc`
    // don't also need a distinct provenance.method here — see B1's report
    // for the full reasoning and the ambiguity flagged for B2 (which owns
    // "provenance stamps" per the plan, for the `split` case: method
    // "split" + `split_from`).
    provenance: { method: "new" as const, created_by: input.actor },
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

  // B3: degree cap (and, uniformly, the cycle checks — always a no-op
  // here, see this function's doc) before this ticket is ever handed back
  // for persisting.
  const others = await listTickets(paths);
  validateTicketEdges(parsed.data, others);

  return { ticket: parsed.data, warnings };
}
