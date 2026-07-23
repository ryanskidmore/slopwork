/**
 * Ref resolution (D12, D6, design.md §8.1 item 5): turn a user-supplied
 * `<ref>` into a ticket.
 *
 * Precedence, in order — and this order is load-bearing, not incidental:
 *   1. **Full prefixed id** (`ticket_<ULID>`) — an exact filename lookup,
 *      no scan needed.
 *   2. **Exact slug** — always wins over a short-prefix interpretation.
 *      This matters because a slug and a ULID prefix live in disjoint
 *      character spaces in practice (slugs are lowercase-hyphenated
 *      words; ULID prefixes are Crockford base32) but nothing *stops* a
 *      short prefix from accidentally reading as a plausible slug
 *      fragment, so the rule needs to be explicit rather than "whichever
 *      matches first": slug wins.
 *   3. **Unique short id prefix** (`idMatchesRef`, core/ids.ts) — matches
 *      against the id verbatim or the bare ULID, case-insensitively.
 *      More than one match is a git-style "ambiguous ref" error, not a
 *      pick-the-first-one.
 *
 * Resolution reads through {@link loadIndex} (db-index.ts), not a raw
 * directory scan — this is also what makes an ordinary `resolveTicketRef`
 * call one of the "read paths that need the index" whose auto-heal the
 * A3 acceptance criterion requires.
 */
import { idMatchesRef, isTicketId } from "../core/index.js";
import type { Ticket } from "../core/index.js";
import { EXTERNAL_REF_PATTERN } from "../core/entities/ref.js";
import { EXIT_CODES } from "../core/exit-codes.js";
import { SlopError } from "../cli/errors.js";
import { loadIndex } from "./db-index.js";
import type { IndexTicketRow } from "./db-index.js";
import type { RepoPaths } from "./paths.js";
import { readTicket } from "./tickets.js";

/**
 * Git-style ambiguous-ref message body (the caller's `printError` adds
 * the leading `error: `). Modeled on git's own
 * `error: short object ID <x> is ambiguous` + candidate list, but naming
 * each candidate's title/slug too (git only has commit ids to show;
 * tickets have human-readable names, so show those).
 */
export function ambiguousRefMessage(ref: string, candidates: IndexTicketRow[]): string {
  const lines = candidates
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => `hint:   ${c.id}  "${c.name}" (${c.slug})`);
  return [`short ref "${ref}" is ambiguous`, "hint: the candidates are:", ...lines].join("\n");
}

function ambiguousRefError(ref: string, candidates: IndexTicketRow[]): SlopError {
  return new SlopError(ambiguousRefMessage(ref, candidates), EXIT_CODES.AMBIGUOUS_REF);
}

function notFoundError(ref: string): SlopError {
  return new SlopError(`no ticket found for ref "${ref}"`, EXIT_CODES.NOT_FOUND);
}

/**
 * External refs (`jira:PROJ-123`) are never resolvable to a local ticket
 * — D1: they're only valid as `--parent` values. This is a distinct
 * error from "not found": the caller passed the wrong *kind* of ref for
 * a context that requires a local ticket, which is a usage mistake, not
 * a lookup that came up empty.
 */
function externalRefNotResolvableError(ref: string): SlopError {
  return new SlopError(
    `"${ref}" is an external ref and cannot be resolved to a local ticket ` +
      '(external refs like "jira:PROJ-123" are only valid as --parent values); ' +
      "pass a local ticket id, slug, or short prefix instead",
    EXIT_CODES.USAGE_ERROR,
  );
}

/**
 * Resolve `ref` to a full {@link Ticket}, per the precedence documented
 * above. Throws: NOT_FOUND (4) if nothing matches; AMBIGUOUS_REF (5) if
 * more than one short-prefix candidate matches; USAGE_ERROR (2) if `ref`
 * is structurally an external ref.
 */
export async function resolveTicketRef(paths: RepoPaths, ref: string): Promise<Ticket> {
  if (isTicketId(ref)) {
    try {
      return await readTicket(paths, ref);
    } catch (err) {
      if (err instanceof SlopError && err.exitCode === EXIT_CODES.NOT_FOUND) {
        throw notFoundError(ref);
      }
      throw err;
    }
  }

  if (EXTERNAL_REF_PATTERN.test(ref)) {
    throw externalRefNotResolvableError(ref);
  }

  const { index } = await loadIndex(paths);

  // Exact slug always wins over a prefix interpretation (see module doc).
  const slugMatchId = index.slugs[ref];
  if (slugMatchId !== undefined) {
    const slugMatches = index.tickets.filter((t) => t.slug === ref);
    if (slugMatches.length > 1) {
      // Defensive only: slugs are unique by construction (B1's collision
      // suffix). A hand-edited db that broke that invariant should still
      // fail loudly and helpfully rather than silently pick one.
      throw ambiguousRefError(ref, slugMatches);
    }
    return readTicket(paths, slugMatchId);
  }

  const candidates = index.tickets.filter((t) => idMatchesRef(t.id, ref));
  if (candidates.length === 1) {
    const only = candidates[0];
    if (only) return readTicket(paths, only.id);
  }
  if (candidates.length > 1) {
    throw ambiguousRefError(ref, candidates);
  }

  throw notFoundError(ref);
}
