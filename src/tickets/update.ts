/**
 * `slop update` (B1) — the general mutator. Pure over an already-loaded
 * {@link Ticket}: given the current ticket and the parsed `--progress
 * /--state/--priority/--label/--name/--spec/--relates-to/--blocks
 * /--discovered-from/--owner/--clear-owner/--parent/--clear-parent` flags,
 * produces the resulting ticket, the JSONC patch to persist it
 * (`src/tickets/patch.ts`), and the event verb/payload to emit.
 * `src/cli/commands/update.ts` owns resolving `<ref>` (including every
 * `--relates-to`/`--blocks`/`--discovered-from <±ref>` target and
 * `--parent <ref>`, via `resolveTicketRef`/`resolveParentRef` — this
 * module never touches the repo, so it only ever sees already-resolved
 * `TicketId`s/{@link ParentResolution}s), reading stdin for `--spec -`,
 * calling `updateTicket`, running the edges-module re-validation
 * `--relates-to`/`--blocks`/`--discovered-from`/`--parent` need
 * (`edges.ts`'s `validateTicketEdges` — this module intentionally does NOT
 * call it, since that requires every OTHER ticket in the db, i.e. I/O)
 * plus, for `--parent`/`--clear-parent`, the `root_id`/`path` recompute +
 * descendant cascade (`parent.ts`'s `recomputeAncestry`, same reason), and
 * printing the result.
 *
 * t-9uvbr: `--clear-owner`/`--clear-parent` (mutually exclusive with
 * `--owner`/`--parent` respectively — the CLI layer enforces that, before
 * this module ever runs, same as it already gates `--spec` against
 * `--summary`/`--details`/`--acceptance`/`--context`) give agents a
 * non-TTY way to clear either field — previously only possible via `slop
 * edit`'s `$EDITOR`, which refuses to launch on a non-TTY at all.
 */
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { EventVerb, Ticket, TicketId, TicketState } from "../core/index.js";
import { EXIT_CODES, nowIso, ticketSchema, ticketStateSchema } from "../core/index.js";
import type { JsoncPatchEntry } from "../core/jsonc.js";
import { SlopError } from "../core/errors.js";
import { assertLabelHasNoLeadingSigil } from "./labels.js";
import { parseOwnerRaw } from "./owner.js";
import type { ParentResolution } from "./parent.js";
import { diffTicketPatch } from "./patch.js";
import { checkStateTransition } from "./state.js";
import { applySpecFieldOverrides, hasSpecFieldOverrides, parseSpecInput } from "./spec.js";
import type { SpecFieldOverrides } from "./spec.js";
import { formatZodIssuesForUsage } from "./validate.js";

/** Ticket fields `update` may ever touch — deliberately narrower than
 * `patch.ts`'s full `TICKET_FIELDS` (`edit`'s concern): `update` never
 * rewrites `id`/`slug`/`root_id`/`path`/`provenance`/etc. `relates_to`/
 * `blocks`/`discovered_from`/`owner`/`parent` are the edge/ownership fields
 * it CAN touch — `--relates-to <±ref>` (ticket_01KYA3Z9FNZ2FDMDRWNKR9EV7J),
 * `--blocks <±ref>`/`--discovered-from <±ref>` (t-9uvbr, same `±`
 * convention)/`--owner <actor>`/`--clear-owner`/`--parent <ref>`
 * /`--clear-parent` (edit-vi-fallback-hangs-agents: a non-interactive
 * alternative to `slop edit` for exactly this post-creation edge/owner
 * repair, since `edit`'s `$EDITOR` fallback hangs agents on a non-TTY —
 * see edit.ts's own fix). `root_id`/`path` are deliberately NOT in this
 * list: unlike `relates_to`/`blocks`/`discovered_from`/`owner`, they're
 * never diffed against `UPDATE_TOUCHABLE_FIELDS` directly —
 * `src/cli/commands/update.ts` recomputes and patches them itself, via
 * `recomputeAncestry`, only when `patch` here actually touches `parent`
 * (this module has no `others`/I/O to recompute them with; see this
 * module's top doc). */
const UPDATE_TOUCHABLE_FIELDS = [
  "name",
  "spec",
  "state",
  "review",
  "priority",
  "labels",
  "relates_to",
  "blocks",
  "discovered_from",
  "owner",
  "parent",
  "latest_note",
  "last_activity_at",
  "updated_at",
] as const satisfies readonly (keyof Ticket)[];

/**
 * `UPDATE_TOUCHABLE_FIELDS` minus the two derived timestamps — this is the
 * "did anything REAL change" set a same-state (or otherwise fully
 * redundant) `update` call is judged against, below. Timestamps are never
 * part of this: they're an effect of a real change, not evidence of one.
 * `parent` IS included, even though `contentNext.parent` (below) is only
 * the raw resolved value, not yet reconciled against `root_id`/`path`
 * (that reconciliation is `src/cli/commands/update.ts`'s job, via
 * `recomputeAncestry`, once it sees `parent` in the returned `patch`) —
 * "did `parent`'s own field value change" is still a perfectly complete
 * answer on its own, independent of whatever `root_id`/`path` end up
 * being once reconciled.
 */
const UPDATE_CONTENT_FIELDS = [
  "name",
  "spec",
  "state",
  "review",
  "priority",
  "labels",
  "relates_to",
  "blocks",
  "discovered_from",
  "owner",
  "parent",
  "latest_note",
] as const satisfies readonly (keyof Ticket)[];

export interface LabelOp {
  op: "+" | "-";
  label: string;
}

/** Parse one `--label +x`/`--label -y` entry. Throws a USAGE_ERROR
 * `SlopError` if it doesn't start with `+`/`-`, the label text after the
 * sigil is blank, or that label text ITSELF starts with another `+`/`-`
 * (`--label ++bug`/`--label +-bug`) — same shared rule
 * {@link assertLabelHasNoLeadingSigil} enforces on `new --label`, so
 * "what's a valid label" can never drift between the two commands. */
export function parseLabelOp(raw: string): LabelOp {
  const sigil = raw.charAt(0);
  if (sigil !== "+" && sigil !== "-") {
    throw new SlopError(
      `--label "${raw}": must start with + (add) or - (remove), e.g. --label +bug --label -triage`,
      EXIT_CODES.USAGE_ERROR,
    );
  }
  const label = raw.slice(1).trim();
  if (label.length === 0) {
    throw new SlopError(`--label "${raw}": nothing after the ${sigil}`, EXIT_CODES.USAGE_ERROR);
  }
  assertLabelHasNoLeadingSigil(label, "--label");
  return { op: sigil, label };
}

/**
 * A `--relates-to <±ref>` entry, split into its sigil and raw ref TEXT —
 * `{op: "+", ref: "auth-migration"}` for `--relates-to +auth-migration`.
 * Deliberately mirrors {@link LabelOp}'s shape (`op` + payload), but the
 * payload here is unresolved ref text, not a final value: unlike a label
 * (an arbitrary string, needing no lookup), a relates-to target is a
 * `<ref>` that must be resolved against the repo (`resolveTicketRef`, I/O)
 * before it's usable — this module is pure and never touches the repo, so
 * that resolution is `src/cli/commands/update.ts`'s job, using
 * {@link parseRelatesToOpText} to split the sigil from the ref text first.
 */
export interface RelatesToOpText {
  op: "+" | "-";
  ref: string;
}

/** A `--relates-to <±ref>` entry AFTER `src/cli/commands/update.ts` has
 * resolved its ref text to a real {@link TicketId} via `resolveTicketRef`
 * — what {@link buildUpdate} actually consumes (see {@link UpdateInput}). */
export interface RelatesToOp {
  op: "+" | "-";
  id: TicketId;
}

/** Parse one `--relates-to +<ref>`/`--relates-to -<ref>` entry into its
 * sigil and ref TEXT (not yet resolved to a ticket — see
 * {@link RelatesToOpText}). Throws a USAGE_ERROR `SlopError` if it doesn't
 * start with `+`/`-`, or the ref text after the sigil is blank — same
 * shape of check as {@link parseLabelOp}. */
export function parseRelatesToOpText(raw: string): RelatesToOpText {
  const sigil = raw.charAt(0);
  if (sigil !== "+" && sigil !== "-") {
    throw new SlopError(
      `--relates-to "${raw}": must start with + (add) or - (remove), e.g. --relates-to ` +
        "+auth-migration --relates-to -old-spike",
      EXIT_CODES.USAGE_ERROR,
    );
  }
  const ref = raw.slice(1).trim();
  if (ref.length === 0) {
    throw new SlopError(
      `--relates-to "${raw}": nothing after the ${sigil}`,
      EXIT_CODES.USAGE_ERROR,
    );
  }
  return { op: sigil, ref };
}

/**
 * `--blocks <±ref>` — the `edit-vi-fallback-hangs-agents` extension of the
 * exact same pattern `--relates-to` established: `blocks`/`relates-to` are
 * both `TicketId[]` set fields on {@link Ticket}, so their unresolved-text
 * ({@link BlocksOpText}) and resolved ({@link BlocksOp}) shapes, and
 * {@link parseBlocksOpText}'s parsing, are byte-for-byte the same logic as
 * {@link RelatesToOpText}/{@link RelatesToOp}/{@link parseRelatesToOpText}
 * — kept as separate named types/functions (rather than one shared generic
 * exposed publicly) so each flag's own error messages name itself
 * correctly, and so a future divergence between the two edge kinds (e.g.
 * `blocks` gaining a rule `relates-to` doesn't need) has an obvious, already
 * -separate home to land in. UNLIKE `relates-to` (symmetric, non-cycle
 * -checked — edges.ts's module doc), `blocks` IS cycle-checked: `src/cli/
 * commands/update.ts` runs `edges.ts`'s full `validateTicketEdges` whenever
 * the returned `patch` touches `blocks`, same as it already does for
 * `relates_to`.
 */
export interface BlocksOpText {
  op: "+" | "-";
  ref: string;
}

/** A `--blocks <±ref>` entry AFTER `src/cli/commands/update.ts` has
 * resolved its ref text to a real {@link TicketId} via `resolveTicketRef`
 * — what {@link buildUpdate} actually consumes (see {@link UpdateInput}). */
export interface BlocksOp {
  op: "+" | "-";
  id: TicketId;
}

/** Parse one `--blocks +<ref>`/`--blocks -<ref>` entry — see
 * {@link parseRelatesToOpText}'s doc for why this is deliberately the same
 * logic under a `--blocks`-specific name. */
export function parseBlocksOpText(raw: string): BlocksOpText {
  const sigil = raw.charAt(0);
  if (sigil !== "+" && sigil !== "-") {
    throw new SlopError(
      `--blocks "${raw}": must start with + (add) or - (remove), e.g. --blocks +auth-migration ` +
        "--blocks -old-spike",
      EXIT_CODES.USAGE_ERROR,
    );
  }
  const ref = raw.slice(1).trim();
  if (ref.length === 0) {
    throw new SlopError(`--blocks "${raw}": nothing after the ${sigil}`, EXIT_CODES.USAGE_ERROR);
  }
  return { op: sigil, ref };
}

/**
 * `--discovered-from <±ref>` (t-9uvbr) — the same `±` set-edit convention
 * `--relates-to`/`--blocks` already use, extended to the one edge kind that
 * previously had no post-creation CLI flag at all: `slop new
 * --discovered-from <ref>` sets it at creation time (add-only, a single
 * ref), but editing it afterward required `slop edit`'s `$EDITOR` — which
 * refuses to launch on a non-TTY. `discovered_from` is a `TicketId[]` set
 * field exactly like `blocks`/`relates_to` (edge.ts), so its unresolved-text
 * ({@link DiscoveredFromOpText}) and resolved ({@link DiscoveredFromOp})
 * shapes mirror those two byte-for-byte. UNLIKE `blocks` (cycle-checked),
 * `discovered-from` is NOT cycle-checked — same as `relates-to` (edges.ts's
 * module doc, "Which edge kinds are cycle-checked"); `src/cli/commands/
 * update.ts` still re-runs `edges.ts`'s full `validateTicketEdges` whenever
 * the returned `patch` touches `discovered_from`, for its degree-cap/
 * self-edge/target-existence checks.
 */
export interface DiscoveredFromOpText {
  op: "+" | "-";
  ref: string;
}

/** A `--discovered-from <±ref>` entry AFTER `src/cli/commands/update.ts`
 * has resolved its ref text to a real {@link TicketId} via
 * `resolveTicketRef` — what {@link buildUpdate} actually consumes (see
 * {@link UpdateInput}). */
export interface DiscoveredFromOp {
  op: "+" | "-";
  id: TicketId;
}

/** Parse one `--discovered-from +<ref>`/`--discovered-from -<ref>` entry —
 * see {@link parseRelatesToOpText}'s doc for why this is deliberately the
 * same logic under a `--discovered-from`-specific name. */
export function parseDiscoveredFromOpText(raw: string): DiscoveredFromOpText {
  const sigil = raw.charAt(0);
  if (sigil !== "+" && sigil !== "-") {
    throw new SlopError(
      `--discovered-from "${raw}": must start with + (add) or - (remove), e.g. ` +
        "--discovered-from +some-spike --discovered-from -old-context",
      EXIT_CODES.USAGE_ERROR,
    );
  }
  const ref = raw.slice(1).trim();
  if (ref.length === 0) {
    throw new SlopError(
      `--discovered-from "${raw}": nothing after the ${sigil}`,
      EXIT_CODES.USAGE_ERROR,
    );
  }
  return { op: sigil, ref };
}

/** Apply already-resolved add/remove ops to a `TicketId[]` SET field — the
 * shared engine behind {@link applyRelatesToOps}/`applyBlocksOps` below
 * (both `relates_to`/`blocks` are sets, not multisets: edges.ts's
 * `assertDegreeCap` rejects a duplicate target as an error, same as
 * `--blocks` on `new`), so `+` on an already-present target and `-` on an
 * absent one are both no-ops, never an error. */
function applyIdSetOps(
  current: readonly TicketId[],
  ops: readonly { op: "+" | "-"; id: TicketId }[],
): TicketId[] {
  const ids = [...current];
  for (const { op, id } of ops) {
    if (op === "+") {
      if (!ids.includes(id)) ids.push(id);
    } else {
      const idx = ids.indexOf(id);
      if (idx !== -1) ids.splice(idx, 1);
    }
  }
  return ids;
}

function applyRelatesToOps(current: readonly TicketId[], ops: readonly RelatesToOp[]): TicketId[] {
  return applyIdSetOps(current, ops);
}

function applyBlocksOps(current: readonly TicketId[], ops: readonly BlocksOp[]): TicketId[] {
  return applyIdSetOps(current, ops);
}

function applyDiscoveredFromOps(
  current: readonly TicketId[],
  ops: readonly DiscoveredFromOp[],
): TicketId[] {
  return applyIdSetOps(current, ops);
}

/** The value to store on `ticket.parent` for an already-resolved
 * `--parent <ref>` OR an explicit `--clear-parent` — `undefined` for
 * `resolution.kind === "none"`, which (t-9uvbr) `src/cli/commands/update.ts`
 * NOW does deliberately pass in for `--clear-parent` (previously it never
 * constructed this variant at all — see {@link UpdateInput.parentResolution}'s
 * doc for the current contract). Mirrors `parent.ts`'s own `ancestryFor`,
 * minus the `root_id`/`path` half that function also computes — `update`
 * has no fresh id to compute a NEW root from the way `new` does, and
 * reconciling an EXISTING ticket's `root_id`/`path` against a changed (or
 * cleared) `parent` is `recomputeAncestry`'s job, one layer up (needs
 * every other ticket — I/O). */
function parentValueFromResolution(resolution: ParentResolution): string | undefined {
  if (resolution.kind === "local") return resolution.ticket.id;
  if (resolution.kind === "external") return resolution.ref;
  return undefined;
}

function applyLabelOps(current: readonly string[], ops: readonly LabelOp[]): string[] {
  const labels = [...current];
  for (const { op, label } of ops) {
    if (op === "+") {
      if (!labels.includes(label)) labels.push(label);
    } else {
      const idx = labels.indexOf(label);
      if (idx !== -1) labels.splice(idx, 1);
    }
  }
  return labels;
}

export interface UpdateInput {
  progress?: string;
  /** Raw `--state` text — validated against the known state enum here, not by the CLI layer. */
  state?: string;
  priority?: number;
  /** Raw `--label` entries (repeatable), e.g. `["+bug", "-triage"]`. */
  labelOps: string[];
  name?: string;
  /** Raw `--spec` text (already read from stdin if `-`), or `undefined` if omitted. */
  specRaw?: string;
  /** Raw `--summary` text, or `undefined` if omitted. */
  summaryRaw?: string;
  /** Raw `--details` text (already read from stdin if `-`), or `undefined` if omitted. */
  detailsRaw?: string;
  /** Raw `--acceptance` entries (repeatable); replaces `current.spec.acceptance` wholesale if non-empty, else leaves it untouched. */
  acceptance: string[];
  /** Raw `--context` entries (repeatable); same replace-if-given-else-untouched rule as `acceptance`. */
  context: string[];
  /**
   * Already-resolved `--relates-to <±ref>` entries (repeatable) — the CLI
   * layer has already turned each ref TEXT into a real `TicketId` via
   * `resolveTicketRef` before this ever runs (see this module's top doc);
   * `buildUpdate` only ever applies set add/remove over ids, never touches
   * the repo itself. Optional (defaults to none), unlike `labelOps` —
   * `draft.ts`/`undraft.ts` call `buildUpdate` directly with a `{state,
   * labelOps}`-only input and have no reason to ever touch `relates_to`,
   * so this stays out of their way rather than forcing every existing
   * `buildUpdate` call site to spell out an empty array.
   */
  relatesToOps?: RelatesToOp[];
  /** Already-resolved `--blocks <±ref>` entries (repeatable) — same
   * resolved-elsewhere convention as {@link relatesToOps}; see
   * {@link BlocksOp}'s doc for the `blocks` vs `relates_to` distinction
   * (cycle-checked). Optional for the same `draft.ts`/`undraft.ts` reason. */
  blocksOps?: BlocksOp[];
  /** Already-resolved `--discovered-from <±ref>` entries (repeatable,
   * t-9uvbr) — same resolved-elsewhere convention as {@link relatesToOps};
   * see {@link DiscoveredFromOp}'s doc for the `discovered-from` vs
   * `blocks`/`relates_to` distinction (not cycle-checked, same as
   * `relates-to`). Optional for the same `draft.ts`/`undraft.ts` reason. */
  discoveredFromOps?: DiscoveredFromOp[];
  /** Raw `--owner <actor>` value, or `undefined` if omitted. Parsed via
   * `tickets/owner.ts`'s `parseOwnerRaw` (t-9uvbr: an `agent:`/`human:`
   * prefix picks the stored actor kind explicitly; a bare name stays
   * `human`, unchanged back-compat behavior). Mutually exclusive with
   * {@link clearOwner} — the CLI layer enforces that before this ever runs,
   * same as it already gates `--spec` against `--summary`/etc. */
  ownerRaw?: string;
  /** t-9uvbr: `--clear-owner` — sets `ticket.owner` to `null`. Mutually
   * exclusive with {@link ownerRaw} (CLI-layer-enforced). `undefined`/`false`
   * when `--clear-owner` wasn't given at all — the common case. */
  clearOwner?: boolean;
  /**
   * Already-resolved `--parent <ref>` OR an explicit `{kind: "none"}` for
   * `--clear-parent` (t-9uvbr) — `src/cli/commands/update.ts` has turned
   * the raw ref text into a {@link ParentResolution} via `parent.ts`'s
   * `resolveParentRef` (local ref lookup OR an external `jira:`-shaped ref,
   * exactly `new --parent`'s own resolution) before this ever runs, OR
   * constructs `{kind: "none"}` directly (no resolution needed) when
   * `--clear-parent` was given instead — mutually exclusive with `--parent`,
   * CLI-layer-enforced. `undefined` when NEITHER flag was given at all —
   * `buildUpdate` only touches `ticket.parent` when this is present at all
   * (a `{kind: "none"}` resolution clears it via
   * {@link parentValueFromResolution}; a `{kind: "local"|"external"}`
   * resolution sets it). Only `ticket.parent` itself is set/cleared here;
   * `root_id`/`path` are NOT recomputed by this pure function either way
   * (that needs every OTHER ticket, i.e. I/O — `src/cli/commands/update.ts`
   * runs `parent.ts`'s `recomputeAncestry` itself, under the same lock,
   * whenever the returned `patch` touches `parent` — a clear included, same
   * as a reparent — then persists ITS returned `root_id`/`path`/descendant
   * cascade on top of what this function already computed — see this
   * module's top doc).
   */
  parentResolution?: ParentResolution;
}

export interface UpdateResult {
  ticket: Ticket;
  patch: JsoncPatchEntry[];
  verb: EventVerb;
  payload: Record<string, unknown>;
}

function hasAnyInput(input: UpdateInput): boolean {
  return (
    input.progress !== undefined ||
    input.state !== undefined ||
    input.priority !== undefined ||
    input.labelOps.length > 0 ||
    input.name !== undefined ||
    input.specRaw !== undefined ||
    input.summaryRaw !== undefined ||
    input.detailsRaw !== undefined ||
    input.acceptance.length > 0 ||
    input.context.length > 0 ||
    (input.relatesToOps?.length ?? 0) > 0 ||
    (input.blocksOps?.length ?? 0) > 0 ||
    (input.discoveredFromOps?.length ?? 0) > 0 ||
    input.ownerRaw !== undefined ||
    input.clearOwner === true ||
    input.parentResolution !== undefined
  );
}

/**
 * Build the update. Throws:
 *   - USAGE_ERROR if no flag was given at all, BOTH `--spec` and any of
 *     `--summary`/`--details`/`--acceptance`/`--context` are given
 *     together, `--state` names an unknown state, a `--label` entry is
 *     malformed, or the resulting ticket fails schema validation;
 *   - CONFLICT (exit 6) if `--state` names a structurally-known but
 *     illegal transition per `state.ts`'s `checkStateTransition` — this is
 *     B1's brief's "must reject illegal transitions per §2 with exit 6".
 *
 * Does NOT itself run `edges.ts`'s `validateTicketEdges` degree-cap/cycle
 * checks for `--relates-to`/`--blocks`/`--discovered-from`/`--parent`, or
 * `parent.ts`'s `recomputeAncestry` for `--parent`/`--clear-parent` — both
 * need every OTHER ticket in the db (I/O), which this pure function never
 * does; `src/cli/commands/update.ts` runs them, under the same lock,
 * whenever the returned `patch` actually touches `relates_to`/`blocks`/
 * `discovered_from`/`parent`.
 */
export function buildUpdate(
  current: Ticket,
  input: UpdateInput,
  clock: Clock = systemClock,
): UpdateResult {
  if (!hasAnyInput(input)) {
    throw new SlopError(
      "nothing to update — pass at least one of --progress/--state/--priority/--label/" +
        "--name/--spec/--summary/--details/--acceptance/--context/--relates-to/--blocks/" +
        "--discovered-from/--owner/--clear-owner/--parent/--clear-parent",
      EXIT_CODES.USAGE_ERROR,
    );
  }

  const specFieldOverrides: SpecFieldOverrides = {
    summary: input.summaryRaw,
    details: input.detailsRaw,
    acceptance: input.acceptance,
    context: input.context,
  };
  const hasFieldOverrides = hasSpecFieldOverrides(specFieldOverrides);
  if (input.specRaw !== undefined && hasFieldOverrides) {
    throw new SlopError(
      "--spec cannot be combined with --summary/--details/--acceptance/--context — " +
        "pick one way to give the spec",
      EXIT_CODES.USAGE_ERROR,
    );
  }

  const labelOps = input.labelOps.map(parseLabelOp);

  let targetState: TicketState | undefined;
  if (input.state !== undefined) {
    const parsedState = ticketStateSchema.safeParse(input.state);
    if (!parsedState.success) {
      throw new SlopError(
        `--state "${input.state}" is not a known state (draft|open|in_progress|review|done|dropped)`,
        EXIT_CODES.USAGE_ERROR,
      );
    }
    targetState = parsedState.data;
    const check = checkStateTransition(current.state, targetState);
    if (!check.ok) {
      throw new SlopError(check.reason ?? "illegal state transition", EXIT_CODES.CONFLICT);
    }
  }

  const stateChanged = targetState !== undefined && targetState !== current.state;

  const contentNext: Ticket = {
    ...current,
    name: input.name ?? current.name,
    spec:
      input.specRaw !== undefined
        ? parseSpecInput(input.specRaw, input.name ?? current.name)
        : hasFieldOverrides
          ? applySpecFieldOverrides(current.spec, specFieldOverrides)
          : current.spec,
    state: targetState ?? current.state,
    // Defensive only, not reachable via this command today: `checkStateTransition`
    // (above) now rejects every `from === "review"` transition except the
    // same-state no-op (state.ts's adversarial-review fix — leaving
    // "review" needs a dedicated command, `slop done`/`slop start`, since
    // it still carries an active session), so `stateChanged` can never be
    // `true` here while `current.state === "review"`. Left in place —
    // harmless, and correct in spirit (the schema requires `review`
    // absent outside `state === "review"` regardless) — as a second,
    // independent guard against ever persisting a ticket with `review`
    // set but `state !== "review"`.
    review: current.state === "review" && stateChanged ? undefined : current.review,
    priority: input.priority ?? current.priority,
    labels: applyLabelOps(current.labels, labelOps),
    relates_to: applyRelatesToOps(current.relates_to, input.relatesToOps ?? []),
    blocks: applyBlocksOps(current.blocks, input.blocksOps ?? []),
    discovered_from: applyDiscoveredFromOps(current.discovered_from, input.discoveredFromOps ?? []),
    // t-9uvbr: `--clear-owner` wins if somehow both were set (the CLI layer
    // already rejects giving both as a USAGE_ERROR before this ever runs —
    // this ordering is defense in depth, not the enforcement point).
    owner:
      input.clearOwner === true
        ? null
        : input.ownerRaw !== undefined
          ? parseOwnerRaw(input.ownerRaw)
          : current.owner,
    parent:
      input.parentResolution !== undefined
        ? parentValueFromResolution(input.parentResolution)
        : current.parent,
    latest_note: input.progress ?? current.latest_note,
  };

  // Fix (polish batch): a call whose resulting content is identical to
  // `current` in every field that actually matters — most visibly `update
  // --state open` on an already-open ticket, with no other flag changing
  // anything either — used to still be treated as a real mutation: it
  // bumped `updated_at` (sometimes `last_activity_at` too) and produced a
  // `ticket.updated` event with an empty payload describing nothing.
  // Mirrors draft.ts/undraft.ts's E1 same-state no-op, but generalised to
  // every `UPDATE_CONTENT_FIELDS` field rather than `state` alone (e.g. a
  // redundant `--label +already-present` with nothing else given is the
  // same kind of fake mutation) — reusing `diffTicketPatch` itself (rather
  // than a second, hand-rolled equality check) so "did anything real
  // change" can never disagree with what the patch below actually
  // contains. A genuine no-op call still succeeds (it's not a usage
  // error — `hasAnyInput` above only requires a flag be PASSED, not that
  // it change anything), it just does nothing further.
  const hasRealChange = diffTicketPatch(current, contentNext, UPDATE_CONTENT_FIELDS).length > 0;
  const now = nowIso(clock);

  const next: Ticket = {
    ...contentNext,
    last_activity_at:
      hasRealChange && (input.progress !== undefined || stateChanged)
        ? now
        : current.last_activity_at,
    updated_at: hasRealChange ? now : current.updated_at,
  };

  const parsed = ticketSchema.safeParse(next);
  if (!parsed.success) {
    throw new SlopError(
      formatZodIssuesForUsage("invalid ticket", parsed.error),
      EXIT_CODES.USAGE_ERROR,
    );
  }
  const validated = parsed.data;

  const patch = diffTicketPatch(current, validated, UPDATE_TOUCHABLE_FIELDS);
  // `patch` is the ground truth for "did this field actually change" — a
  // payload key is only worth emitting for a field the patch itself
  // touched, so a redundant flag (e.g. `--priority` re-stating the
  // ticket's current priority, or `--label +already-present`) given
  // alongside a genuinely no-op call can never describe a change in the
  // event payload that the patch doesn't back up (same "no fake mutation"
  // principle as the `hasRealChange` short-circuit above, just applied
  // per-field instead of to the call as a whole).
  const patchedFields = new Set(patch.map((entry) => entry.path[0]));
  const verb: EventVerb = stateChanged ? "ticket.state_changed" : "ticket.updated";
  const payload: Record<string, unknown> = {};
  if (input.progress !== undefined && patchedFields.has("latest_note")) {
    payload.progress = input.progress;
  }
  if (stateChanged) {
    payload.from = current.state;
    payload.to = validated.state;
  }
  if (input.priority !== undefined && patchedFields.has("priority")) {
    payload.priority = validated.priority;
  }
  if (labelOps.length > 0 && patchedFields.has("labels")) payload.labels = validated.labels;
  if (input.name !== undefined && patchedFields.has("name")) payload.name = validated.name;
  if ((input.specRaw !== undefined || hasFieldOverrides) && patchedFields.has("spec")) {
    payload.spec = true;
  }
  if ((input.relatesToOps?.length ?? 0) > 0 && patchedFields.has("relates_to")) {
    payload.relates_to = validated.relates_to;
  }
  if ((input.blocksOps?.length ?? 0) > 0 && patchedFields.has("blocks")) {
    payload.blocks = validated.blocks;
  }
  if ((input.discoveredFromOps?.length ?? 0) > 0 && patchedFields.has("discovered_from")) {
    payload.discovered_from = validated.discovered_from;
  }
  if ((input.ownerRaw !== undefined || input.clearOwner === true) && patchedFields.has("owner")) {
    payload.owner = validated.owner;
  }
  if (input.parentResolution !== undefined && patchedFields.has("parent")) {
    payload.parent = validated.parent ?? null;
  }

  return { ticket: validated, patch, verb, payload };
}
