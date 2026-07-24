/**
 * Small helpers shared by the command registration modules in this
 * directory. Kept deliberately tiny — A1 only registers commands, it
 * does not implement them.
 */
import { EXIT_CODES } from "../../core/exit-codes.js";
import type { Actor, Session } from "../../core/index.js";
import { SlopError } from "../errors.js";

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
