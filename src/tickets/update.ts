/**
 * `slop update` (B1) — the general mutator. Pure over an already-loaded
 * {@link Ticket}: given the current ticket and the parsed `--progress
 * /--state/--priority/--label/--name/--spec` flags, produces the
 * resulting ticket, the JSONC patch to persist it (`src/tickets/patch.ts`),
 * and the event verb/payload to emit. `src/cli/commands/update.ts` owns
 * resolving `<ref>`, reading stdin for `--spec -`, calling `updateTicket`,
 * and printing the result.
 */
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { EventVerb, Ticket, TicketState } from "../core/index.js";
import { EXIT_CODES, nowIso, ticketSchema, ticketStateSchema } from "../core/index.js";
import type { JsoncPatchEntry } from "../core/jsonc.js";
import { SlopError } from "../cli/errors.js";
import { diffTicketPatch } from "./patch.js";
import { checkStateTransition } from "./state.js";
import { parseSpecInput } from "./spec.js";
import { formatZodIssuesForUsage } from "./validate.js";

/** Ticket fields `update` may ever touch — deliberately narrower than
 * `patch.ts`'s full `TICKET_FIELDS` (`edit`'s concern): `update` never
 * rewrites `id`/`slug`/`root_id`/`path`/edges/`owner`/`provenance`/etc. */
const UPDATE_TOUCHABLE_FIELDS = [
  "name",
  "spec",
  "state",
  "review",
  "priority",
  "labels",
  "latest_note",
  "last_activity_at",
  "updated_at",
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
    input.specRaw !== undefined
  );
}

/**
 * Build the update. Throws:
 *   - USAGE_ERROR if no flag was given at all, `--state` names an unknown
 *     state, a `--label` entry is malformed, or the resulting ticket fails
 *     schema validation;
 *   - CONFLICT (exit 6) if `--state` names a structurally-known but
 *     illegal transition per `state.ts`'s `checkStateTransition` — this is
 *     B1's brief's "must reject illegal transitions per §2 with exit 6".
 */
export function buildUpdate(
  current: Ticket,
  input: UpdateInput,
  clock: Clock = systemClock,
): UpdateResult {
  if (!hasAnyInput(input)) {
    throw new SlopError(
      "nothing to update — pass at least one of --progress/--state/--priority/--label/--name/--spec",
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
  const now = nowIso(clock);

  const next: Ticket = {
    ...current,
    name: input.name ?? current.name,
    spec:
      input.specRaw !== undefined
        ? parseSpecInput(input.specRaw, input.name ?? current.name)
        : current.spec,
    state: targetState ?? current.state,
    // review -> * (any legal target, since review -> review is a same
    // -state no-op handled above) always clears `review`: this is exactly
    // the "changes requested" re-entry design.md D15 describes, and it is
    // the one review/done-adjacent transition that needs no extra data
    // (state.ts's module doc) — clearing the field is the whole
    // transition.
    review: current.state === "review" && stateChanged ? undefined : current.review,
    priority: input.priority ?? current.priority,
    labels: applyLabelOps(current.labels, labelOps),
    latest_note: input.progress ?? current.latest_note,
    last_activity_at: input.progress !== undefined || stateChanged ? now : current.last_activity_at,
    updated_at: now,
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
  const verb: EventVerb = stateChanged ? "ticket.state_changed" : "ticket.updated";
  const payload: Record<string, unknown> = {};
  if (input.progress !== undefined) payload.progress = input.progress;
  if (stateChanged) {
    payload.from = current.state;
    payload.to = validated.state;
  }
  if (input.priority !== undefined) payload.priority = validated.priority;
  if (labelOps.length > 0) payload.labels = validated.labels;
  if (input.name !== undefined) payload.name = validated.name;
  if (input.specRaw !== undefined) payload.spec = true;

  return { ticket: validated, patch, verb, payload };
}
