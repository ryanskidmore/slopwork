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
  slugify,
  ticketSchema,
} from "../core/index.js";
import type { StorageBackend } from "../core/storage-contract.js";
import { SlopError } from "../core/errors.js";
import { validateTicketEdges } from "./edges.js";
import { assertLabelHasNoLeadingSigil } from "./labels.js";
import { parseOwnerRaw } from "./owner.js";
import { ancestryFor, parseParentRef } from "./parent.js";
import type { ParentResolution } from "./parent.js";
import {
  applySpecFieldOverrides,
  defaultSpec,
  hasSpecFieldOverrides,
  parseSpecInput,
} from "./spec.js";
import type { SpecFieldOverrides } from "./spec.js";
import { formatZodIssuesForUsage } from "./validate.js";

export interface NewTicketInput {
  name: string;
  /** Raw `--spec` text (already read from stdin if `--spec -` was given), or `undefined` if `--spec` was omitted entirely. */
  specRaw?: string;
  /** Raw `--summary` text, or `undefined` if omitted. */
  summaryRaw?: string;
  /** Raw `--details` text (already read from stdin if `--details -` was given), or `undefined` if omitted. */
  detailsRaw?: string;
  /** Raw `--acceptance` entries (repeatable). */
  acceptance: string[];
  /** Raw `--context` entries (repeatable). */
  context: string[];
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
   * `name`. When given, it's validated/
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
 * otherwise auto-generated from `name` (`slugify`, unchanged). Either way
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
function slugBase(input: NewTicketInput): string {
  if (input.slugRaw === undefined) {
    return slugify(input.name);
  }
  try {
    return parseExplicitSlug(input.slugRaw);
  } catch (err) {
    throw new SlopError(err instanceof Error ? err.message : String(err), EXIT_CODES.USAGE_ERROR);
  }
}

/**
 * Build (but do not persist) the new ticket. Throws:
 *   - a USAGE_ERROR `SlopError` if any `--label` starts with `+`/`-` — see
 *     {@link assertLabelHasNoLeadingSigil}: that's `update --label`'s
 *     add/remove sigil, never legal as part of a label's actual text on
 *     EITHER command, so it's rejected here up front rather than silently
 *     stored as a literal `"+bug"`-shaped label a later `update --label
 *     -bug` can never correctly address;
 *   - a USAGE_ERROR `SlopError` if BOTH `--spec` and any of
 *     `--summary`/`--details`/`--acceptance`/`--context` are given —
 *     two different ways to say what the spec is, so combining them is
 *     rejected rather than picking a silent winner;
 *   - whatever `resolveTicketRef` throws (NOT_FOUND/AMBIGUOUS_REF/USAGE_ERROR)
 *     for an unresolvable `--parent`/`--blocks`/`--relates-to`/`--discovered-from`
 *     local ref;
 *   - a USAGE_ERROR `SlopError` if `--slug` is given but malformed (see
 *     the slug-base parsing above, or if the assembled candidate fails
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
  backend: StorageBackend,
  input: NewTicketInput,
  clock: Clock = systemClock,
): Promise<NewTicketResult> {
  const warnings: string[] = [];

  for (const label of input.labels) {
    assertLabelHasNoLeadingSigil(label, "--label");
  }

  const specFieldOverrides: SpecFieldOverrides = {
    summary: input.summaryRaw,
    details: input.detailsRaw,
    acceptance: input.acceptance,
    context: input.context,
  };
  if (input.specRaw !== undefined && hasSpecFieldOverrides(specFieldOverrides)) {
    throw new SlopError(
      "--spec cannot be combined with --summary/--details/--acceptance/--context — " +
        "pick one way to give the spec",
      EXIT_CODES.USAGE_ERROR,
    );
  }
  const spec =
    input.specRaw !== undefined
      ? parseSpecInput(input.specRaw, input.name)
      : applySpecFieldOverrides(defaultSpec(input.name), specFieldOverrides);

  const parsedParent = parseParentRef(input.parentRaw);
  const refs = [
    ...(parsedParent.kind === "local" ? [parsedParent.ref] : []),
    ...input.blocksRaw,
    ...input.relatesToRaw,
    ...(input.discoveredFromRaw === undefined ? [] : [input.discoveredFromRaw]),
  ];
  const resolved = refs.length > 0 ? await backend.resolveTicketRefs(refs) : [];
  let resolvedIndex = 0;
  const parentResolution: ParentResolution =
    parsedParent.kind === "local"
      ? { kind: "local", ticket: resolved[resolvedIndex++]! }
      : parsedParent;
  if (parentResolution.kind === "external" && parentResolution.warning) {
    warnings.push(parentResolution.warning);
  }

  // Edges are a set, not a multiset (edges.ts's `assertDegreeCap` rejects
  // a duplicate target as an error on `edit`'s re-validation path) — so a
  // repeated `--blocks` naming the same ticket twice is deduped here
  // rather than surfaced as a creation-time error, which would be a
  // needlessly hostile reaction to a harmless repeated flag/copy-paste.
  // One index snapshot for every creation ref, not a separate load per
  // flag group — see `repo/refs.ts`'s `resolveTicketRefs`. Dedup below is
  // unchanged.
  const blocks: TicketId[] = [];
  const seenBlocks = new Set<TicketId>();
  for (let i = 0; i < input.blocksRaw.length; i++) {
    const target = resolved[resolvedIndex++]!;
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
  for (let i = 0; i < input.relatesToRaw.length; i++) {
    const target = resolved[resolvedIndex++]!;
    if (!seenRelatesTo.has(target.id)) {
      seenRelatesTo.add(target.id);
      relatesTo.push(target.id);
    }
  }

  const discoveredFrom: TicketId[] = [];
  if (input.discoveredFromRaw !== undefined) {
    const target = resolved[resolvedIndex++]!;
    discoveredFrom.push(target.id);
  }

  const id = newTicketId();
  const ancestry = ancestryFor(parentResolution, id);
  // Parsing the explicit slug stays ahead of the strict storage scan,
  // preserving the existing USAGE_ERROR behavior for malformed values.
  const baseSlug = slugBase(input);
  const now = nowIso(clock);

  const baseCandidate = {
    id,
    name: input.name,
    slug: baseSlug,
    spec,
    state: input.draft ? ("draft" as const) : ("open" as const),
    priority: input.priority,
    labels: input.labels,
    parent: ancestry.parent,
    blocks,
    relates_to: relatesTo,
    discovered_from: discoveredFrom,
    root_id: ancestry.rootId,
    path: ancestry.path,
    active_session: null,
    last_activity_at: now,
    latest_note: null,
    // t-9uvbr: "agent:name"/"human:name" prefixes pick the stored actor
    // kind explicitly; a bare name (no prefix) stays "human" — unchanged
    // back-compat behavior. See tickets/owner.ts's own doc.
    owner: input.ownerRaw !== undefined ? parseOwnerRaw(input.ownerRaw) : null,
    // G5 (t-uy8vo): `adhoc` used to be its own standalone stored boolean;
    // it's now folded into `provenance.method` — `"adhoc"` when `--adhoc`
    // was given, `"new"` otherwise — so `provenance.method === "adhoc"` is
    // the single source of truth for adhoc-ness (see `done.ts`'s
    // review-skip nag exemption, its only behavioral consumer). `--draft`
    // does NOT get its own provenance.method the same way: draft-ness is
    // already fully captured by `state` above, with no other behavior
    // riding on it, so folding it in too would just be a second way to ask
    // the same question `state === "draft"` already answers.
    provenance: {
      method: input.adhoc ? ("adhoc" as const) : ("new" as const),
      created_by: input.actor,
    },
    created_at: now,
    updated_at: now,
  };

  // Keep field-level usage failures ahead of `listTickets()`, as before.
  // Collision suffixing can lengthen a valid base slug, so the finalized
  // candidate is parsed once more below after applying the snapshot.
  const baseParsed = ticketSchema.safeParse(baseCandidate);
  if (!baseParsed.success) {
    throw new SlopError(
      formatZodIssuesForUsage("invalid ticket", baseParsed.error),
      EXIT_CODES.USAGE_ERROR,
    );
  }

  const others = await backend.listTickets();
  const slug = nextAvailableSlug(baseSlug, new Set(others.map((ticket) => ticket.slug)));
  const parsed = ticketSchema.safeParse({ ...baseCandidate, slug });
  if (!parsed.success) {
    throw new SlopError(
      formatZodIssuesForUsage("invalid ticket", parsed.error),
      EXIT_CODES.USAGE_ERROR,
    );
  }

  // B3: degree cap (and, uniformly, the cycle checks — always a no-op
  // here, see this function's doc) before this ticket is ever handed back
  // for persisting.
  validateTicketEdges(parsed.data, others);

  return { ticket: parsed.data, warnings };
}
