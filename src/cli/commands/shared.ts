/**
 * Small helpers shared by the command registration modules in this
 * directory. Kept deliberately tiny — A1 only registers commands, it
 * does not implement them.
 */
import { BUDGET_UNIT } from "../../core/budget.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import type { Actor, Session } from "../../core/index.js";
import { SlopError } from "../errors.js";
import { shortTicketCode } from "../../core/index.js";
import type { TicketId } from "../../core/index.js";

/** Commander "collect" reducer for options that may be repeated, e.g.
 * `--blocks x --blocks y` → `["x", "y"]`. */
export function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

/**
 * Parse a CLI option value into an integer, raising a {@link SlopError}
 * carrying `USAGE_ERROR` (exit 2) that names the offending flag.
 *
 * **E1 exit-code audit fix:** this used to `throw new Error(...)` on a
 * commented (but false) assumption that Commander's own top-level error
 * handling would catch and re-shape it into a usage error. Verified
 * directly against the compiled binary that it does not — Commander's
 * `_callParseArg` only intercepts errors carrying its own
 * `commander.invalidArgument` code (see `node_modules/commander/lib/
 * command.js`), so a plain `Error` from a custom option parser propagates
 * all the way to `src/cli/index.ts`'s top-level catch, which is not a
 * `CommanderError` either, so it falls into `reportError`'s generic
 * `Error` branch — `GENERIC_ERROR` (1), not the documented `USAGE_ERROR`
 * (2) for "missing/invalid arguments or flags." E.g. `slop new x
 * --priority notanumber` exited 1 before this fix. Every option parser
 * built from this helper (`--priority`, `--limit`, `--check`/`--uncheck`,
 * `--port`, `ready`'s `--budget`, ...) is fixed by throwing a
 * {@link SlopError} instead, which `reportError` always honors regardless
 * of which layer catches it.
 *
 * **Input-validation fix:** `Number.parseInt` silently truncates
 * leading-numeric garbage — `parseInt("2abc", 10)` is `2`, not NaN — so
 * `--priority 2abc` used to persist priority `2` (a DIFFERENT value than
 * the one typed, a data-integrity gap) instead of being rejected, and
 * `--priority 1.9` truncated to `1`. The value's full trimmed text must
 * now match `/^-?\d+$/` (a complete integer, nothing trailing) before
 * it's accepted at all.
 */
export function parseIntegerOption(flag: string): (value: string) => number {
  return (value: string): number => {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new SlopError(`${flag} must be an integer, got "${value}"`, EXIT_CODES.USAGE_ERROR);
    }
    return Number.parseInt(trimmed, 10);
  };
}

/** Parse a `--priority` value into an integer, per design.md §8.1 (4):
 * 0 (urgent) – 3 (low), default 2. Validation of the range is a later
 * work item's concern (B1); this only turns CLI text into a number. */
export const parsePriority = parseIntegerOption("--priority");

/**
 * Parse a `--budget <n>` value — the ONE shared parser for every
 * budget-taking command (`ready`, `search`, `status`, `events`, `context`,
 * `show --context`): a non-negative integer count of {@link BUDGET_UNIT}
 * (characters, core/budget.ts). Rejects negatives as a USAGE_ERROR (exit
 * 2), same eager "usage mistake, reject before any I/O" treatment every
 * other option parser in this module gets.
 *
 * budget-flags-units-and-validation: before this, `context` (alone) had
 * its own negative-rejecting parser while `ready`/`search`/`status`/
 * `events`/`show` all used the generic {@link parseIntegerOption}, which
 * happily accepts a negative `--budget` and hands it straight to
 * core/budget.ts's elision helpers — which then elide EVERY entry (a
 * negative budget can never fit even the empty envelope) and return a
 * successful, valid-looking `{"ready": [], ...}` on exit 0. An agent
 * skimming that output has no way to tell "genuinely nothing is ready"
 * apart from "I mistyped --budget -1" — a silent footgun a same-shaped
 * USAGE_ERROR up front avoids entirely. Every command below now shares
 * this one implementation instead of six independent copies of the same
 * validation (or, as here, five copies missing it).
 */
export function parseBudgetOption(value: string): number {
  const trimmed = value.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!/^-?\d+$/.test(trimmed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new SlopError(
      `--budget must be a non-negative integer (${BUDGET_UNIT}), got "${value}"`,
      EXIT_CODES.USAGE_ERROR,
    );
  }
  return parsed;
}

/**
 * Reject a free-form CLI text option once it exceeds `max` characters —
 * housekeeping-gitignore-lock-stale: `--note`/`--reason`/`--outcome` were
 * unbounded at the CLI layer, so an absurdly large value (e.g. `--outcome
 * -` piping in an arbitrary file) would only be caught, far less
 * actionably, when the resulting ticket/session candidate failed schema
 * validation deep inside `build*Ticket`/`build*Session` — a
 * `GENERIC_ERROR` zod dump instead of a clean, specific `USAGE_ERROR`
 * naming the offending flag up front, before any I/O for this command even
 * starts.
 *
 * Measures `value` exactly as given — callers pass whatever the
 * downstream schema field itself measures (e.g. `resolutionSchema` trims
 * before its own `.max()`, so `done.ts` passes an already-`.trim()`med
 * `--outcome`; `end_summary` does not trim, so `stop.ts`/`drop.ts`/
 * `done.ts` pass `--note`/`--reason` as-is), so this can never reject (or
 * accept) a value the schema would later disagree with.
 */
export function assertMaxLength(flag: string, value: string, max: number): void {
  if (value.length > max) {
    throw new SlopError(
      `${flag} is ${value.length} characters, exceeding the ${max}-character limit`,
      EXIT_CODES.USAGE_ERROR,
    );
  }
}

/** Print a non-fatal `warning: <message>` line to stderr — e.g. B1's
 * malformed-`jira:`-ref format check (§8.2 item 5: "warn on format
 * mismatch, don't block"), which must never prevent the command from
 * succeeding. */
export function printWarning(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

/**
 * ticket_01KYAPN9NXY6RPSV6WGR42CJHJ (policy: session ownership): `plan`
 * (incl. `--check`/`--uncheck`), `stop`, `done`, and `drop` all mutate
 * WHATEVER session is currently active on a ticket, resolved via the
 * ticket (`resolveTicketRef`) — never gated on "is the acting actor the
 * one who started it," unlike `start`, which refuses a live session
 * outright without `--takeover` (C1). Decision (recorded here and in
 * docs/agent-workflow.md, "Session ownership"): this is intentional, not
 * a bug — the coordinator pattern (docs/agent-workflow.md, "Dogfooding
 * with parallel agents") legitimately has one actor (a human, or a lead
 * agent) plan/stop/close out sessions other actors started, and every
 * mutation already records the ACTING actor in its event regardless (A4's
 * audit trail is never silent about who really did it) — so this is a
 * WARNING, surfaced to whoever is about to act on someone else's session,
 * never a hard block that would make the coordinator pattern impossible
 * without `--takeover`-style ceremony on four more commands.
 *
 * Compares by `name` only (not `kind`): the SAME person can legitimately
 * show up as `human` in one invocation (a raw shell) and `agent` in
 * another (inside a harness) without being a different actor for
 * ownership purposes — `name` is D17's actual identity axis.
 *
 * Returns `null` when `actor` (the invocation's resolved D17 identity)
 * matches `session.actor` (whoever `start` recorded when this session was
 * created) — the overwhelmingly common case, and the only one every
 * existing test exercised before this ticket. Every caller should print
 * the non-null result via {@link printWarning} AFTER its transaction
 * commits, same convention as every other soft warning in this codebase
 * (e.g. `stop.ts`'s transcript-capture warning) — this is informational,
 * never a reason a mutation could fail.
 */
export function sessionOwnershipWarning(session: Session, actor: Actor): string | null {
  if (session.actor.name === actor.name) return null;
  return (
    `acting as "${actor.name}" (${actor.kind}), but session ${session.id} was started by ` +
    `"${session.actor.name}" (${session.actor.kind}) — proceeding anyway (session ownership is ` +
    'not enforced by design; see docs/agent-workflow.md, "Session ownership").'
  );
}

/** Read all of stdin as UTF-8 text — `--spec -`'s "read from stdin" (B1,
 * `new`/`update`). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The canonical `ticket` object every `--json` result embeds
 * (json-shapes-are-inconsistent-across).
 *
 * The rule this enforces, documented in docs/cli-reference.md: a command that
 * reports ONLY a ticket returns these fields flat (`new`, `update`, `draft`,
 * `undraft`); a command that reports a ticket AND the session it acted on
 * nests them under `ticket` and `session` (`start`, `stop`, `done`, `drop`,
 * `review`). Before this, `start --json` nested while `stop`/`done`/`drop`/
 * `review` flattened ticket fields alongside session ones — so an agent read
 * `ticket.id` from one command and `id` from the next, and in the flat shape
 * `id` meant the ticket while `session_id` meant the session. Routing every
 * ticket sub-object through one function is what keeps the two families from
 * drifting apart again.
 */
export function ticketJson(ticket: { id: TicketId; slug: string; name: string; state: string }): {
  id: string;
  slug: string;
  handle: string;
  name: string;
  state: string;
} {
  return {
    id: ticket.id,
    slug: ticket.slug,
    handle: shortTicketCode(ticket.id),
    name: ticket.name,
    state: ticket.state,
  };
}
