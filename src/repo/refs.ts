/**
 * Ref resolution (D12, D6, design.md §8.1 item 5): turn a user-supplied
 * `<ref>` into a ticket.
 *
 * Precedence, in order — and this order is load-bearing, not incidental:
 *   1. **Full prefixed id** (`ticket_<ULID>`) — an exact filename lookup,
 *      no scan needed. ULIDs are canonically uppercase (core/ids.ts), so
 *      this step is intentionally case-sensitive — an exact filename
 *      match either is or isn't.
 *   2. **Exact slug, case-insensitively** — always wins over a
 *      short-prefix interpretation. This matters because a slug and a
 *      ULID prefix live in disjoint character spaces in practice (slugs
 *      are lowercase-hyphenated words; ULID prefixes are Crockford
 *      base32) but nothing *stops* a short prefix from accidentally
 *      reading as a plausible slug fragment, so the rule needs to be
 *      explicit rather than "whichever matches first": slug wins.
 *      Slugs are lowercase by construction (`slugify`, core/slug.ts), so
 *      the incoming ref is lowercased before this lookup (adversarial
 *      -review Finding 5: slug matching used to be exact-case only, so
 *      `Alpha-Ticket` failed to resolve against slug `alpha-ticket` even
 *      though a mixed-case ULID prefix resolved fine at step 3 below —
 *      inconsistent, and strictly more surprising than being forgiving
 *      here too). This is strictly more permissive than before, never
 *      less: anything that resolved by exact-case slug still does.
 *      D12 branch-style slugs (`fix/ui-not-showing`, an explicit `slop
 *      new --slug`): this step needs no special-casing for the `/` —
 *      `index.slugs` is keyed by the slug's full string (db-index.ts's
 *      `buildIndex`), and a plain object-key lookup does not care whether
 *      that string contains a `/`. It's still exactly one exact-match
 *      lookup, not a path split. This also can never collide with step 1
 *      (no ticket id contains `/`) or the external-ref check just above
 *      this step (`EXTERNAL_REF_PATTERN` requires a `:`, not a `/`).
 *   3. **Short `t-<code>` handle** (`shortTicketCode`, core/ids.ts —
 *      ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1): tried only when the
 *      (lowercased) ref has the exact `t-<5 lowercase base36 chars>`
 *      shape (`isShortTicketCodeRef`). This is *after* slug on purpose —
 *      a real slug that happens to look `t-`-ish (`t-shirt-feature`, or
 *      even, in principle, an exact 5-char one) always resolves as that
 *      slug first; the code form only gets a turn once slug lookup has
 *      already come up empty. The exact-length shape gate also means this
 *      step can never match anything the short-id-prefix step below
 *      would (a `ticket_...`/bare-ULID prefix never contains a literal
 *      hyphen at that position), so there is no ordering hazard between
 *      3 and 4 either way — see core/ids.ts's doc for the fuller
 *      writeup. Every ticket's code is *computed*, never stored, so this
 *      is a scan (like the prefix step), not an index lookup. More than
 *      one candidate is the same git-style "ambiguous ref" error as
 *      step 4's.
 *   4. **Unique short id prefix** (`idMatchesRef`, core/ids.ts) — matches
 *      against the id verbatim or the bare ULID, case-insensitively.
 *      More than one match is a git-style "ambiguous ref" error, not a
 *      pick-the-first-one.
 *
 * Resolution reads through {@link loadIndex} (db-index.ts), not a raw
 * directory scan — this is also what makes an ordinary `resolveTicketRef`
 * call one of the "read paths that need the index" whose auto-heal the
 * A3 acceptance criterion requires.
 */
import { idMatchesRef, isShortTicketCodeRef, isTicketId, shortTicketCode } from "../core/index.js";
import type { Ticket } from "../core/index.js";
import { EXTERNAL_REF_PATTERN } from "../core/entities/ref.js";
import { EXIT_CODES } from "../core/exit-codes.js";
import { SlopError } from "../cli/errors.js";
import { loadIndex } from "./db-index.js";
import type { DbIndex, IndexTicketRow } from "./db-index.js";
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
  return resolveWithIndex(paths, ref, null);
}

/**
 * Resolve MANY refs against ONE index load.
 *
 * {@link resolveTicketRef} loads the index on every call, which is right for a
 * single lookup and quadratic for a batch: resolving N refs re-ran the
 * fingerprint scan (a `readdir` plus a `stat` per ticket file) and re-parsed
 * `index.jsonc` N times, so a command like
 * `slop new --blocks a --blocks b …` cost O(refs x tickets). That is not
 * hypothetical at scale — `docs/benchmarks.md` measures a single warm index
 * load at ~1.3s on 100k tickets, so ten `--blocks` refs there would have meant
 * ~13 seconds of pure re-scanning.
 *
 * Loading once is safe precisely because these lookups are independent reads:
 * nothing in a resolution loop writes, so every ref would have observed the
 * same index anyway. Resolution precedence is untouched — both this and the
 * single-ref form share {@link resolveWithIndex}, so there is exactly one copy
 * of the id/slug/`t-`code/prefix rules.
 *
 * Refs are resolved in order and the first failure throws, matching what a
 * caller looping over {@link resolveTicketRef} already saw.
 */
export async function resolveTicketRefs(paths: RepoPaths, refs: string[]): Promise<Ticket[]> {
  if (refs.length === 0) return [];
  if (refs.length === 1) {
    const only = refs[0];
    return only === undefined ? [] : [await resolveTicketRef(paths, only)];
  }
  // One load, shared by every ref below.
  const { index } = await loadIndex(paths);
  const out: Ticket[] = [];
  for (const ref of refs) out.push(await resolveWithIndex(paths, ref, index));
  return out;
}

/** Shared implementation — see {@link resolveTicketRefs} for why `preloaded`
 * exists. `null` means "load it yourself" (the single-ref path). */
async function resolveWithIndex(
  paths: RepoPaths,
  ref: string,
  preloaded: DbIndex | null,
): Promise<Ticket> {
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

  const index = preloaded ?? (await loadIndex(paths)).index;

  // Exact slug always wins over a prefix interpretation (see module doc).
  // Slugs are lowercase by construction, so lowercasing the incoming ref
  // makes this lookup case-insensitive (adversarial-review Finding 5)
  // without risking any false match — a slug can never differ from its
  // lowercased self. A D12 branch-style slug (`fix/ui-not-showing`)
  // resolves here exactly like any other slug: `index.slugs` is keyed by
  // the full slug string, `/` included, so this is one plain exact-match
  // lookup either way, no path-aware handling needed.
  const refLower = ref.toLowerCase();
  const slugMatchId = index.slugs[refLower];
  if (slugMatchId !== undefined) {
    const slugMatches = index.tickets.filter((t) => t.slug === refLower);
    if (slugMatches.length > 1) {
      // Defensive only: slugs are unique by construction (B1's collision
      // suffix). A hand-edited db that broke that invariant should still
      // fail loudly and helpfully rather than silently pick one.
      throw ambiguousRefError(ref, slugMatches);
    }
    return readTicket(paths, slugMatchId);
  }

  // t-<code> short handle (step 3 above, module doc): tried only when
  // refLower has the exact code shape, so this never fires for a slug
  // that merely starts with "t-" — that already resolved (or didn't) at
  // the slug step above, before this line even runs. Every ticket's code
  // is computed here, not read off a stored field (core/ids.ts's
  // shortTicketCode doc) — a scan, same shape as the prefix step below.
  if (isShortTicketCodeRef(refLower)) {
    const codeMatches = index.tickets.filter((t) => shortTicketCode(t.id) === refLower);
    if (codeMatches.length === 1) {
      const only = codeMatches[0];
      if (only) return readTicket(paths, only.id);
    }
    if (codeMatches.length > 1) {
      throw ambiguousRefError(ref, codeMatches);
    }
    // No ticket currently has this code — fall through. The short-id
    // -prefix step below can never match a "t-<code>"-shaped ref either
    // (see module doc), so this always lands on the final notFoundError,
    // exactly as if the shape check above had been the last word.
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
