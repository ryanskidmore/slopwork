/**
 * `slop edit <ref>` (B1): validating whatever `$EDITOR` handed back before
 * it's ever persisted. This is the module that decides "is this edit safe
 * to keep", not how the editor is spawned or where a rejected draft gets
 * parked — see `src/cli/commands/edit.ts` for that.
 *
 * Adversarial-review fix: a hand-edit used to be free to write ANY `state`
 * (schema+edges+ancestry+id-immutability were the only checks — see the
 * ticket this closes) and any `active_session`, independently of each
 * other. That let an edit install an out-of-order state (`open` ->
 * `done`, skipping `review` and the done-cascade) or an incoherent pairing
 * (`state: "done"` with `active_session` still pointing at a live
 * session) — and a later `slop stop` would then pass its own guards
 * (`assertStoppable` only checks `active_session !== null` plus "not
 * review") and resurrect the done ticket back to `open`. Two checks below
 * close that: `state` changes are routed through the exact same legality
 * table `slop update --state` uses (`state.ts`'s `checkStateTransition`),
 * and the final candidate's `active_session`/`state` pairing is checked
 * for coherence regardless of whether `state` itself changed (a hand-edit
 * could leave `state` alone and only touch `active_session`).
 */
import type { Ticket } from "../core/index.js";
import type { ExitCode } from "../core/index.js";
import { EXIT_CODES, formatParseErrors, parseJsonc, ticketSchema } from "../core/index.js";
import { checkStateTransition } from "./state.js";
import { zodIssueLines } from "./validate.js";

export type EditValidation =
  | { ok: true; ticket: Ticket }
  | { ok: false; errors: string[]; exitCode: ExitCode };

/**
 * Parse + schema-validate the user's edited text against `original` (the
 * pre-edit ticket), with three extra ticket-specific rules on top of
 * plain schema validity:
 *
 *   1. `id` must stay exactly `original.id`. A ticket's id names its own
 *      file (`ticket_<id>.jsonc`) — letting a hand-edit change the `id`
 *      field inside the file would desynchronize content from filename in
 *      a way nothing else in this codebase guards against, so it's
 *      rejected here as firmly as any other schema violation (same
 *      error-and-rollback path in `src/cli/commands/edit.ts`, not a
 *      special case).
 *   2. If `state` changed, `original.state -> state` must be a legal
 *      transition per `state.ts`'s `checkStateTransition` — exactly the
 *      table `slop update --state` is held to (see this module's top
 *      doc). That table permits only the same-state no-op and `draft <->
 *      open` directly; every other edge (entering/leaving
 *      `in_progress`/`review`/`done`/`dropped`) is rejected with a
 *      message naming the dedicated command (`start`/`review`/`done`/
 *      `drop`/`stop`) that has the session/cascade machinery `edit`
 *      doesn't.
 *   3. The final candidate's `active_session` must agree with its
 *      `state`: session-carrying states (`in_progress`, `review`, D9/D15)
 *      require a non-null `active_session`; every other state (`draft`,
 *      `open`, and the terminal `done`/`dropped`) requires
 *      `active_session === null`. Checked unconditionally (not gated on
 *      `state` having changed) — an edit that only touches
 *      `active_session` and leaves `state` alone can be just as
 *      incoherent.
 *
 * Each rejection carries the {@link ExitCode} `src/cli/commands/edit.ts`
 * should surface: `USAGE_ERROR` for a shape problem (bad JSON, schema
 * violation, immutable `id`), `CONFLICT` for a semantically-illegal state
 * or state/session pairing — mirroring `update.ts`'s own
 * `checkStateTransition` -> `CONFLICT` convention.
 */
export function validateEditedTicketText(raw: string, original: Ticket): EditValidation {
  const { value, errors } = parseJsonc<unknown>(raw);
  if (errors.length > 0) {
    return {
      ok: false,
      errors: formatParseErrors("<edited ticket>", raw, errors),
      exitCode: EXIT_CODES.USAGE_ERROR,
    };
  }

  const parsed = ticketSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, errors: zodIssueLines(parsed.error), exitCode: EXIT_CODES.USAGE_ERROR };
  }
  const candidate = parsed.data;

  if (candidate.id !== original.id) {
    return {
      ok: false,
      errors: [
        `  id: must remain "${original.id}" — a ticket's id is immutable (it names the file on disk)`,
      ],
      exitCode: EXIT_CODES.USAGE_ERROR,
    };
  }

  if (candidate.state !== original.state) {
    const check = checkStateTransition(original.state, candidate.state);
    if (!check.ok) {
      return {
        ok: false,
        errors: [
          `  state: ${check.reason ?? `illegal transition "${original.state}" -> "${candidate.state}"`}`,
        ],
        exitCode: EXIT_CODES.CONFLICT,
      };
    }
  }

  const sessionCarrying = candidate.state === "in_progress" || candidate.state === "review";
  if (sessionCarrying && candidate.active_session === null) {
    return {
      ok: false,
      errors: [
        `  active_session: state "${candidate.state}" carries an active session (D9/D15) — ` +
          "active_session must not be null here. If you meant to end the session, edit isn't the " +
          "right tool — use `slop stop`/`slop done`/`slop drop` instead",
      ],
      exitCode: EXIT_CODES.CONFLICT,
    };
  }
  if (!sessionCarrying && candidate.active_session !== null) {
    return {
      ok: false,
      errors: [
        `  active_session: state "${candidate.state}" must not carry an active session — only ` +
          '"in_progress"/"review" do (D9/D15). Clear active_session, or — if there really is a ' +
          "live session to account for — use `slop stop`/`slop done`/`slop drop` instead of hand" +
          "-editing state",
      ],
      exitCode: EXIT_CODES.CONFLICT,
    };
  }

  return { ok: true, ticket: candidate };
}
