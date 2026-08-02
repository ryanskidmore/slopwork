/**
 * t-9uvbr: `--owner`'s value grammar, shared by `new` (tickets/new.ts) and
 * `update` (tickets/update.ts) — the bug this closes: `--owner` used to
 * hardcode `kind: "human"` unconditionally, contradicting D1's
 * agent-owned-below-root policy (an agent-run subtree legitimately has an
 * agent owner, not a human pretending to be one).
 *
 * Grammar: an optional `agent:`/`human:` prefix picks the stored actor
 * kind explicitly; a bare name (no prefix) stays `human` — the pre-t-9uvbr
 * behavior, preserved verbatim for back-compat with every doc/example that
 * already says `--owner priya`.
 */
import type { Actor } from "../core/index.js";
import { EXIT_CODES } from "../core/exit-codes.js";
import { SlopError } from "../cli/errors.js";

const OWNER_KIND_PREFIX = /^(agent|human):(.*)$/;

/**
 * Parse a `--owner <actor>` value into an {@link Actor}. `"agent:codex-3"`
 * -> `{name: "codex-3", kind: "agent"}`; `"human:priya"` ->
 * `{name: "priya", kind: "human"}`; a bare `"priya"` (no recognized
 * prefix) -> `{name: "priya", kind: "human"}`, unchanged from before this
 * ticket. Throws a `USAGE_ERROR` `SlopError` if a recognized prefix is
 * given with nothing (or only whitespace) after the `:` — `actorSchema`'s
 * own `.min(1)` would eventually reject an empty name too, but this fails
 * faster, at the flag itself, naming exactly what's wrong.
 */
export function parseOwnerRaw(raw: string): Actor {
  const match = OWNER_KIND_PREFIX.exec(raw);
  if (match) {
    const kind = match[1] as "agent" | "human";
    const name = (match[2] ?? "").trim();
    if (name.length === 0) {
      throw new SlopError(
        `--owner "${raw}": nothing after the "${kind}:" prefix — expected --owner ${kind}:<name>`,
        EXIT_CODES.USAGE_ERROR,
      );
    }
    return { name, kind };
  }
  return { name: raw, kind: "human" };
}
