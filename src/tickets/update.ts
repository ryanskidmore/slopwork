/**
 * `slop update` (B1) — the general mutator. Pure over an already-loaded
 * {@link Ticket}: given the current ticket and the parsed `--progress
 * /--state/--priority/--label/--name/--spec/--relates-to` flags, produces
 * the resulting ticket, the JSONC patch to persist it
 * (`src/tickets/patch.ts`), and the event verb/payload to emit.
 * `src/cli/commands/update.ts` owns resolving `<ref>` (including every
 * `--relates-to <±ref>` target, via `resolveTicketRef` — this module never
 * touches the repo, so it only ever sees already-resolved `TicketId`s),
 * reading stdin for `--spec -`, calling `updateTicket`, running the edges
 * -module re-validation `--relates-to` needs (`edges.ts`'s
 * `validateTicketEdges` — this module intentionally does NOT call it,
 * since that requires every OTHER ticket in the db, i.e. I/O), and
 * printing the result.
 */
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { EventVerb, Ticket, TicketId, TicketState } from "../core/index.js";
import { EXIT_CODES, nowIso, ticketSchema, ticketStateSchema } from "../core/index.js";
import type { JsoncPatchEntry } from "../core/jsonc.js";
import { SlopError } from "../cli/errors.js";
import { diffTicketPatch } from "./patch.js";
import { checkStateTransition } from "./state.js";
import { applySpecFieldOverrides, hasSpecFieldOverrides, parseSpecInput } from "./spec.js";
import type { SpecFieldOverrides } from "./spec.js";
import { formatZodIssuesForUsage } from "./validate.js";

/** Ticket fields `update` may ever touch — deliberately narrower than
 * `patch.ts`'s full `TICKET_FIELDS` (`edit`'s concern): `update` never
 * rewrites `id`/`slug`/`root_id`/`path`/`parent`/`blocks`/`discovered_from`/
 * `owner`/`provenance`/etc. `relates_to` is the one edge field it CAN
 * touch (`--relates-to <±ref>`, ticket_01KYA3Z9FNZ2FDMDRWNKR9EV7J) —
 * `relates-to` is the symmetric, non-cycle-checked edge (edges.ts's module
 * doc), so exposing add/remove for it here doesn't reopen any of the
 * ancestry/deadlock hazards `parent`/`blocks` carry. */
const UPDATE_TOUCHABLE_FIELDS = [
  "name",
  "spec",
  "state",
  "review",
  "priority",
  "labels",
  "relates_to",
  "latest_note",
  "last_activity_at",
  "updated_at",
] as const satisfies readonly (keyof Ticket)[];

/**
 * `UPDATE_TOUCHABLE_FIELDS` minus the two derived timestamps — this is the
 * "did anything REAL change" set a same-state (or otherwise fully
 * redundant) `update` call is judged against, below. Timestamps are never
 * part of this: they're an effect of a real change, not evidence of one.
 */
const UPDATE_CONTENT_FIELDS = [
  "name",
  "spec",
  "state",
  "review",
  "priority",
  "labels",
  "relates_to",
  "latest_note",
] as const satisfies readonly (keyof Ticket)[];

export interface LabelOp {
  op: "+" | "-";
  label: string;
}

/** Parse one `--label +x`/`--label -y` entry. Throws a USAGE_ERROR
 * `SlopError` if it doesn't start with `+`/`-`, or the label text after
 * the sigil is blank. */
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

/** Apply already-resolved `--relates-to` ops to `current.relates_to` — the
 * `TicketId` analogue of {@link applyLabelOps}: `relates_to` is a SET, not
 * a multiset (edges.ts's `assertDegreeCap` rejects a duplicate target as
 * an error, same as `--blocks` on `new`), so `+` on an already-present
 * target and `-` on an absent one are both no-ops, never an error. */
function applyRelatesToOps(current: readonly TicketId[], ops: readonly RelatesToOp[]): TicketId[] {
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
    (input.relatesToOps?.length ?? 0) > 0
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
 * Does NOT itself run `edges.ts`'s `validateTicketEdges` degree-cap check
 * for `--relates-to` — that needs every OTHER ticket in the db (I/O), which
 * this pure function never does; `src/cli/commands/update.ts` runs it,
 * under the same lock, whenever the returned `patch` actually touches
 * `relates_to`.
 */
export function buildUpdate(
  current: Ticket,
  input: UpdateInput,
  clock: Clock = systemClock,
): UpdateResult {
  if (!hasAnyInput(input)) {
    throw new SlopError(
      "nothing to update — pass at least one of --progress/--state/--priority/--label/" +
        "--name/--spec/--summary/--details/--acceptance/--context/--relates-to",
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

  return { ticket: validated, patch, verb, payload };
}
