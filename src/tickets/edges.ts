/**
 * B3: the graph module — write-time validation for `parent`/`blocks`/
 * `relates-to`/`discovered-from` edges (design.md §4.1 item 2). Pure,
 * synchronous, no I/O: every function here takes the candidate ticket
 * being written plus the rest of the db's tickets (read by the caller —
 * `new`/`edit` today, B4/C3 as they land) and either returns normally or
 * throws a {@link SlopError}. This is the seam B1 deliberately left open
 * (see src/core/entities/edge.ts and src/tickets/tree.ts's doc comments):
 * nothing before B3 checks cycles or degree caps at write time.
 *
 * ## Which edge kinds are cycle-checked, and why
 *
 * - **`parent`** — an ancestry cycle is checked. It's checked because it's
 *   catastrophic: D6's materialised `root_id`/`path` are computed by
 *   walking the parent chain, and a cycle there makes that walk undefined
 *   (see {@link "./parent.js"}'s `recomputeAncestry`, which trusts this
 *   module having already confirmed acyclicity before it ever runs).
 * - **`blocks`** — a blocking cycle is checked. It's checked because it's a
 *   deadlock: `ready` (B4) is "no live blockers"; a cycle of blockers means
 *   every ticket in it can *never* satisfy that, forever, with no way out
 *   short of manually dropping an edge.
 * - **`relates-to`** — NOT cycle-checked. It's a symmetric, purely
 *   informational "these are connected" edge (design.md never gives it
 *   direction-sensitive meaning the way `blocks`/`parent` have); a "cycle"
 *   in a symmetric relation is a tautology (A relates-to B and B relates
 *   -to A is just... the same fact, stated from both ends), not a
 *   structural hazard. There is nothing here for a cycle check to protect.
 * - **`discovered-from`** — NOT cycle-checked. It's provenance ("I found
 *   this bug while working on that ticket") — inherently historical, and
 *   nothing in v0 ever *walks* a discovered-from chain the way `parent`'s
 *   chain is walked for ancestry or `blocks`'s graph is walked for
 *   readiness. A two-ticket mutual "discovered-from" pair is temporally
 *   odd (each claims to have been discovered while working the other) but
 *   not structurally harmful to anything this codebase computes — flagged
 *   here as a known, deliberate gap rather than silently ignored.
 *
 * ## Degree cap
 *
 * {@link EDGE_DEGREE_CAP} (500) is enforced **per ticket, per edge kind**,
 * against the *outgoing* edge count on the ticket being written — i.e.
 * `candidate.blocks.length`, `candidate.relates_to.length`, and
 * `candidate.discovered_from.length` each individually capped at 500. This
 * is the only cap enforceable purely from the ticket being written, which
 * matches the storage model (DECISIONS.md: edges live only on their source
 * ticket — there is no reverse store to cap against without an expensive
 * full-db scan on every write). It does NOT cap in-degree (e.g. how many
 * *other* tickets' `blocks` arrays name a given ticket) — many different
 * tickets could each independently add ≤500 edges to the same target,
 * and nothing here (or anywhere in v0) stops that. `parent` has no degree
 * cap: it is a single optional field, never an array, so "degree" doesn't
 * apply.
 *
 * Duplicate targets within one kind's array are also rejected here (not
 * silently deduped) — an edge is a graph edge, not a multiset entry, and a
 * duplicate is far more likely to be a mistake (a repeated `--blocks`, a
 * hand-edit typo) than a deliberate "this matters twice."
 *
 * ## Bounded BFS
 *
 * {@link detectCycle} is a breadth-first search bounded by
 * {@link MAX_CYCLE_CHECK_VISITS} (100,000 edge visits, overridable per call
 * for testing). Since only the candidate ticket's own outgoing edges
 * change on any single write, and every OTHER ticket's edges are trusted
 * to already form an acyclic graph (the invariant this very check
 * maintains), a single BFS from the candidate — using its NEW edge set —
 * looking for a path back to itself is sufficient: any cycle introduced by
 * this write must pass through the candidate, so finding no return path
 * proves the whole graph stays acyclic. The bound exists as a second,
 * independent line of defense on top of the visited-set (which already
 * caps a well-formed search at O(tickets)): if `others` is somehow already
 * cyclic (e.g. a hand-edited db that bypassed `slop` entirely) the BFS
 * could otherwise be made to do more work than a check is worth. Hitting
 * the bound throws (exit 6, CONFLICT) rather than returning "no cycle
 * found" — refusing an unverifiable write is safe; treating "couldn't
 * finish checking" as "must be fine" is not.
 */
import type { Ticket, TicketId } from "../core/index.js";
import { EXIT_CODES, isTicketId } from "../core/index.js";
import { SlopError } from "../core/errors.js";

/** design.md's B3 acceptance criterion names this exact number. */
export const EDGE_DEGREE_CAP = 500;

/** See this module's doc, "Bounded BFS". */
export const MAX_CYCLE_CHECK_VISITS = 100_000;

type EdgeArrayKind = "blocks" | "relates-to" | "discovered-from";

function describeTicketRef(t: Pick<Ticket, "slug" | "name">): string {
  return `${t.slug} ("${t.name}")`;
}

function buildLookup(tickets: readonly Ticket[]): Map<TicketId, Ticket> {
  return new Map(tickets.map((t) => [t.id, t] as const));
}

function formatPath(path: readonly TicketId[], lookup: ReadonlyMap<TicketId, Ticket>): string {
  return path
    .map((id) => {
      const t = lookup.get(id);
      return t ? describeTicketRef(t) : id;
    })
    .join(" -> ");
}

function localTarget(ref: string | undefined): TicketId | null {
  return ref !== undefined && isTicketId(ref) ? ref : null;
}

function boundExceededError(maxVisits: number): SlopError {
  return new SlopError(
    `cycle check exceeded ${maxVisits} edge visits without resolving whether this write is acyclic — ` +
      "refusing to write rather than risk silently accepting an unverified cycle (the local graph is " +
      "far larger than v0's target scale, or something outside `slop` made it cyclic already; run " +
      "`slop reindex` and inspect the db by hand)",
    EXIT_CODES.CONFLICT,
  );
}

/**
 * Bounded BFS from `startId` over `adjacency`, looking for a path back to
 * `startId` itself. Returns the cycle as `[startId, ..., startId]` (length
 * 2 for a direct self-edge) if one exists, `null` if `startId` cannot
 * reach itself within `maxVisits` edge visits. Throws a {@link SlopError}
 * (CONFLICT, exit 6) if the bound is hit before either resolving — see
 * this module's doc, "Bounded BFS".
 *
 * `adjacency` must already reflect the candidate write: the caller
 * overrides the candidate ticket's own entry with its NEW outgoing edges
 * before calling this — every other node's entry is the graph as it
 * stands on disk, untouched.
 */
export function detectCycle(
  adjacency: ReadonlyMap<TicketId, readonly TicketId[]>,
  startId: TicketId,
  maxVisits: number = MAX_CYCLE_CHECK_VISITS,
): TicketId[] | null {
  const cameFrom = new Map<TicketId, TicketId>();
  const visited = new Set<TicketId>([startId]);
  const queue: TicketId[] = [startId];
  let visits = 0;

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current === undefined) break; // unreachable: head < queue.length
    const neighbors = adjacency.get(current) ?? [];
    for (const next of neighbors) {
      visits++;
      if (visits > maxVisits) throw boundExceededError(maxVisits);

      if (next === startId) {
        // Reconstruct the path startId -> ... -> current, then close the loop.
        const path: TicketId[] = [current];
        let node = current;
        while (node !== startId) {
          const prev = cameFrom.get(node);
          if (prev === undefined) break; // unreachable: every queued node has a predecessor
          path.push(prev);
          node = prev;
        }
        path.reverse();
        path.push(startId);
        return path;
      }
      if (!visited.has(next)) {
        visited.add(next);
        cameFrom.set(next, current);
        queue.push(next);
      }
    }
  }
  return null;
}

function buildParentAdjacency(
  candidate: Ticket,
  others: readonly Ticket[],
): Map<TicketId, TicketId[]> {
  const adjacency = new Map<TicketId, TicketId[]>();
  for (const t of others) {
    const target = localTarget(t.parent);
    adjacency.set(t.id, target !== null ? [target] : []);
  }
  const candidateTarget = localTarget(candidate.parent);
  adjacency.set(candidate.id, candidateTarget !== null ? [candidateTarget] : []);
  return adjacency;
}

function buildBlocksAdjacency(
  candidate: Ticket,
  others: readonly Ticket[],
): Map<TicketId, TicketId[]> {
  const adjacency = new Map<TicketId, TicketId[]>();
  for (const t of others) adjacency.set(t.id, [...t.blocks]);
  adjacency.set(candidate.id, [...candidate.blocks]);
  return adjacency;
}

/**
 * Reject `candidate.parent` if it would close an ancestry cycle (bounded
 * BFS over every ticket's `parent` field — see this module's doc). A
 * no-op if `candidate.parent` is absent or external (D1: external parents
 * terminate the local tree, so they can never participate in a local
 * cycle). `others` must be every OTHER ticket currently in the db (the
 * candidate's own prior version, if any, is irrelevant — its new `parent`
 * field is what's being checked).
 */
export function assertNoParentCycle(candidate: Ticket, others: readonly Ticket[]): void {
  const rest = others.filter((t) => t.id !== candidate.id);
  const adjacency = buildParentAdjacency(candidate, rest);
  const cyclePath = detectCycle(adjacency, candidate.id);
  if (!cyclePath) return;

  const lookup = buildLookup(rest);
  lookup.set(candidate.id, candidate);
  const targetId = cyclePath[1];
  const target = targetId !== undefined ? lookup.get(targetId) : undefined;
  const selfReference = cyclePath.length === 2;

  throw new SlopError(
    [
      `cannot set ${describeTicketRef(candidate)}'s parent to ` +
        `${target ? describeTicketRef(target) : String(targetId)}: this would close an ancestry cycle` +
        (selfReference ? " (a ticket cannot be its own ancestor)" : "") +
        ":",
      `  ${formatPath(cyclePath, lookup)}`,
    ].join("\n"),
    EXIT_CODES.CONFLICT,
  );
}

/**
 * Reject any edge in `candidate.blocks` that would close a blocking cycle
 * (bounded BFS over every ticket's `blocks` array — see this module's
 * doc). `others` must be every OTHER ticket currently in the db.
 */
export function assertNoBlocksCycle(candidate: Ticket, others: readonly Ticket[]): void {
  const rest = others.filter((t) => t.id !== candidate.id);
  const adjacency = buildBlocksAdjacency(candidate, rest);
  const cyclePath = detectCycle(adjacency, candidate.id);
  if (!cyclePath) return;

  const lookup = buildLookup(rest);
  lookup.set(candidate.id, candidate);
  const targetId = cyclePath[1];
  const target = targetId !== undefined ? lookup.get(targetId) : undefined;
  const selfReference = cyclePath.length === 2;

  throw new SlopError(
    [
      `cannot add a "blocks" edge from ${describeTicketRef(candidate)} to ` +
        `${target ? describeTicketRef(target) : String(targetId)}: this would close a blocking cycle` +
        (selfReference ? " (a ticket cannot block itself)" : "") +
        " — nothing in it could ever become ready:",
      `  ${formatPath(cyclePath, lookup)}`,
    ].join("\n"),
    EXIT_CODES.CONFLICT,
  );
}

function assertOneDegreeCap(
  candidate: Pick<Ticket, "slug" | "name">,
  kind: EdgeArrayKind,
  targets: readonly TicketId[],
): void {
  const seen = new Set<TicketId>();
  for (const id of targets) {
    if (seen.has(id)) {
      throw new SlopError(
        `${describeTicketRef(candidate)}'s "${kind}" edges list ${id} more than once — each edge must ` +
          "name a distinct ticket",
        EXIT_CODES.CONFLICT,
      );
    }
    seen.add(id);
  }
  if (targets.length > EDGE_DEGREE_CAP) {
    throw new SlopError(
      `${describeTicketRef(candidate)} would have ${targets.length} "${kind}" edges, exceeding the ` +
        `per-ticket per-edge-kind cap of ${EDGE_DEGREE_CAP}`,
      EXIT_CODES.CONFLICT,
    );
  }
}

/**
 * Enforce {@link EDGE_DEGREE_CAP} (500) and edge-uniqueness on
 * `candidate.blocks`/`relates_to`/`discovered_from` — see this module's
 * doc, "Degree cap". Purely local to `candidate`; no `others` needed.
 */
export function assertDegreeCap(candidate: Ticket): void {
  assertOneDegreeCap(candidate, "blocks", candidate.blocks);
  assertOneDegreeCap(candidate, "relates-to", candidate.relates_to);
  assertOneDegreeCap(candidate, "discovered-from", candidate.discovered_from);
}

/**
 * edges-self-relates-to-is: reject a self-edge in `candidate.relates_to`/
 * `candidate.discovered_from`. Unlike `blocks`/`parent` (rejected via the
 * cycle checks above — a direct self-edge IS a length-2 cycle, so
 * `detectCycle` already catches it with a clear "cannot block itself"/
 * "cannot be its own ancestor" message), `relates-to` and
 * `discovered-from` are deliberately NOT cycle-checked (see this module's
 * doc, "Which edge kinds are cycle-checked") — a symmetric/provenance edge
 * has no cycle for a graph walk to find. Without this explicit check, a
 * self-edge in either would silently pass `checkTargetsExist`'s
 * deliberate "a target naming candidate itself always exists" allowance
 * (see the comment there) and be persisted — `slop update X --relates-to
 * +X` reproduced this before this check existed. A ticket "relating to"
 * or having been "discovered from" itself is meaningless the same way
 * self-blocking is, just not structurally harmful to any graph walk, so
 * it needs its own direct check rather than a cycle check.
 */
const SELF_EDGE_DESCRIPTION: Record<"relates-to" | "discovered-from", string> = {
  "relates-to": "a ticket cannot relate to itself",
  "discovered-from": "a ticket cannot be discovered from itself",
};

function assertNoSelfEdge(
  candidate: Pick<Ticket, "id" | "slug" | "name">,
  kind: "relates-to" | "discovered-from",
  targets: readonly TicketId[],
): void {
  if (!targets.includes(candidate.id)) return;
  throw new SlopError(
    `cannot add a "${kind}" edge from ${describeTicketRef(candidate)} to itself — ${SELF_EDGE_DESCRIPTION[kind]}`,
    EXIT_CODES.CONFLICT,
  );
}

/**
 * Reject a self-edge in `candidate.relates_to` or `candidate.discovered_from`
 * — see {@link assertNoSelfEdge}. `blocks`/`parent` self-edges are already
 * rejected by {@link assertNoBlocksCycle}/{@link assertNoParentCycle} and
 * are intentionally NOT re-checked here (that would just produce a second,
 * less specific error for the same write).
 */
export function assertNoSelfEdges(candidate: Ticket): void {
  assertNoSelfEdge(candidate, "relates-to", candidate.relates_to);
  assertNoSelfEdge(candidate, "discovered-from", candidate.discovered_from);
}

function danglingEdgeError(
  candidate: Pick<Ticket, "slug" | "name">,
  kind: string,
  target: TicketId,
): SlopError {
  return new SlopError(
    `${describeTicketRef(candidate)}'s "${kind}" edge names ${target}, which is not a ticket in this db`,
    EXIT_CODES.NOT_FOUND,
  );
}

function checkTargetsExist(
  candidate: Ticket,
  kind: string,
  targets: readonly TicketId[],
  lookup: ReadonlyMap<TicketId, Ticket>,
): void {
  for (const id of targets) {
    // A target naming `candidate` itself (a self-edge) always "exists" —
    // it's the very ticket being written. `lookup` is built from `others`
    // with `candidate` deliberately excluded (its OWN prior on-disk
    // version, if any, must never be treated as authoritative — the
    // candidate's new fields are what's being validated), so without this
    // check a self-edge would be misreported as dangling instead of the
    // (correct, and separately checked) cycle it actually is.
    if (id === candidate.id) continue;
    if (!lookup.has(id)) throw danglingEdgeError(candidate, kind, id);
  }
}

/**
 * Reject any local edge target (`parent` if local, or any entry of
 * `blocks`/`relates_to`/`discovered_from`) that doesn't name a ticket
 * present in `others` or `candidate` itself. Required for
 * {@link "./parent.js"}'s `recomputeAncestry` to be safe to call
 * afterward: it trusts a local `parent` target to actually resolve.
 */
export function assertEdgeTargetsExist(candidate: Ticket, others: readonly Ticket[]): void {
  const rest = others.filter((t) => t.id !== candidate.id);
  const lookup = buildLookup(rest);

  const parentTarget = localTarget(candidate.parent);
  if (parentTarget !== null && parentTarget !== candidate.id && !lookup.has(parentTarget)) {
    throw danglingEdgeError(candidate, "parent", parentTarget);
  }
  checkTargetsExist(candidate, "blocks", candidate.blocks, lookup);
  checkTargetsExist(candidate, "relates-to", candidate.relates_to, lookup);
  checkTargetsExist(candidate, "discovered-from", candidate.discovered_from, lookup);
}

/**
 * The single entry point every write path should call before persisting a
 * ticket whose edges are new or changed (`new`, `edit`'s re-validation,
 * and any future edge-mutating command) — see this module's doc for the
 * order and reasoning. `others` is every OTHER ticket currently in the db
 * (the candidate's own on-disk prior version, if any, must NOT be
 * included — its new fields are exactly what's being validated).
 *
 * Order: degree cap (cheapest, purely local) -> self-edges on the two
 * uncycled kinds (also purely local — see {@link assertNoSelfEdges}) ->
 * target existence (needs `others` but no graph walk) -> parent-cycle ->
 * blocks-cycle (the two bounded BFS checks, most expensive, run last).
 */
export function validateTicketEdges(candidate: Ticket, others: readonly Ticket[]): void {
  const rest = others.filter((t) => t.id !== candidate.id);
  assertDegreeCap(candidate);
  assertNoSelfEdges(candidate);
  assertEdgeTargetsExist(candidate, rest);
  assertNoParentCycle(candidate, rest);
  assertNoBlocksCycle(candidate, rest);
}
