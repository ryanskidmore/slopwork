/**
 * `.slop/db/index.jsonc` — derived, gitignored (D14), a pure function of
 * the entity files on disk. Rebuilding it is always safe and always
 * correct by construction: nothing here is authoritative, everything is
 * recomputed from tickets/ (today) and, as later work items land,
 * whatever else needs deriving.
 *
 * Auto-heal (A3 scope item 5): {@link loadIndex} is the one function every
 * other read path that needs the index should call. It transparently
 * rebuilds when the on-disk index is missing, unparseable, stamped with a
 * schema version other than {@link INDEX_SCHEMA_VERSION}, or — see
 * "Content staleness" below — stale relative to the entity files it was
 * built from. A user who `rm`s the index, a fresh clone where it's
 * gitignored and so *always* absent, and a repo that just went through a
 * `git merge`/`git pull`/`$EDITOR` hand-edit that never ran a single
 * `slop` command, all self-heal transparently, per this item's acceptance
 * criterion ("deleted index self-heals").
 *
 * ## Content staleness
 *
 * Coordinator ruling (superseding A3's original approach): the index must
 * NOT depend on every ticket-mutating command remembering to call
 * `rebuildIndex()` — that's a bug class where one forgotten call site
 * silently serves wrong `ready`/slug-resolution answers, and it flatly
 * doesn't cover `git merge`/`git pull`/`checkout`/a hand-edit via
 * `$EDITOR`, none of which go through any `slop` command at all. Since
 * `index.jsonc` is gitignored (D14), it is *never* merged, so it is stale
 * by construction after every routine `git pull` that touched tickets.
 *
 * The fix: every built index embeds a cheap **content fingerprint** —
 * per entity directory the index's content depends on (today: `tickets/`,
 * plus — C5 — `config.yaml` itself, single-file rather than a directory
 * but shaped the same: a `{count, digest}` pair, `count` being `0`/`1` for
 * absent/present), a count plus a sha256 digest over every file's own
 * `(filename, mtimeMs, size)` tuple, sorted by filename (see
 * {@link computeContentFingerprint}). `loadIndex()` recomputes this
 * fingerprint on every call via `readdir`/`stat` only — no file is parsed
 * or its content read — and rebuilds if it differs from the one recorded
 * in the index, exactly like the missing/unparseable/stale
 * -schema-version cases (`reason: "stale_content"`). This is cheap: see
 * this work item's report for a measured number on ~1k tickets, kept well
 * inside D4's "< 1s on 1k tickets" budget.
 *
 * Fingerprinting `config.yaml` (C5) matters because `stale_at`/
 * `review_stale_at` (see below) are computed from its `defaults.
 * stale_after`/`review_stale_after` — without this, hand-editing those
 * thresholds would silently do nothing until some unrelated ticket file
 * also changed, since nothing else about the index would look stale.
 *
 * (Supersedes an earlier count+max-mtime-only design — adversarial-review
 * Finding 2: a file whose mtime moves *backwards* below the directory's
 * existing max — a `cp -p`/`rsync -t`/backup-restore/clock-skewed-machine
 * write, all realistic for this project's explicit multi-agent/multi
 * -machine target — could change content while the recorded max mtime
 * never advances, making the old fingerprint bit-identical across a real
 * change and `loadIndex()` report `"fresh"` forever, e.g. turning a slug
 * rename into a permanent false NOT_FOUND. Hashing every file's own tuple
 * closes that hole: any single file's mtime or size changing, in either
 * direction, changes the digest.)
 *
 * KNOWN LIMITATION: mtime has millisecond granularity (coarser on some
 * filesystems). A write that changes a file's content but leaves BOTH its
 * mtime (to the millisecond) AND its byte size identical to what was last
 * fingerprinted — landing in the exact same millisecond as the prior
 * write, and not changing length — could theoretically still be missed.
 * This is a substantially narrower hole than the old design's (which
 * missed any mtime-non-advancing change regardless of size): the
 * same-millisecond window is already vanishingly unlikely in practice,
 * and requiring the size to *also* coincide shrinks it further. Accepted
 * for v0 — `slop reindex` is the explicit manual escape hatch, and the
 * *next* write that changes the file count, or any survivor's mtime or
 * size, is caught normally.
 *
 * ## Fault tolerance (adversarial-review Finding 3)
 *
 * A single unparseable/invalid ticket file used to make the WHOLE index
 * build throw — which made `slop reindex`, the command that exists
 * specifically to recover from a corrupt db, itself unusable in exactly
 * that situation (and took every other `loadIndex` caller — ref
 * resolution, `ready`, `status`, ... — down with it too). `buildIndex`
 * now reads every ticket via tickets.ts's fault-tolerant
 * `listTicketsTolerant` instead of the strict `listTickets`: a file that
 * fails to parse or validate is skipped and recorded — path, id, and the
 * SAME high-quality error `readTicket` would have thrown (exact path,
 * 1-based line:column, specific parse code / zod path) — in the returned
 * index's `problems` array, rather than aborting the whole build.
 *
 * This is fault-tolerant, never silent: {@link loadIndex} warns on
 * stderr every time it returns an index carrying one or more problems —
 * not just the read that triggered a rebuild, since a `"fresh"`
 * (non-rebuilt) load can still be serving a persisted `problems` list
 * from an earlier build. `slop reindex` (src/cli/commands/reindex.ts)
 * goes further: it reports every problem in one pass with its full
 * actionable error, still rebuilds and persists everything it *could*
 * read, and exits non-zero (`GENERIC_ERROR`, 1) when any problem remains
 * — `--strict` restores the old fail-fast, all-or-nothing behavior for
 * anyone who explicitly wants it.
 *
 * `readTicket`/`listTickets` themselves are UNCHANGED and still throw on
 * a corrupt file — correct there, since a direct-by-id read is the
 * caller asking for that exact ticket and has no sensible "skip it"
 * option.
 *
 * Shape: per-ticket summary rows, a slug→id map, reverse edges (edges are
 * stored only on the source ticket — DECISIONS.md — so "who blocks me"
 * etc. has to be derived by scanning every ticket's outgoing edges and
 * inverting), and the fault-tolerance `problems` list above.
 *
 * B4's room to grow, without a schema-version bump: every
 * {@link IndexTicketRow} already carried `blocked_count`/`ready` (B4:
 * "Derivations: blocked_count in index, ready query ... done-cascade"),
 * typed as `<T> | null`. A3 always wrote `null` for both. **B4 now fills
 * these in for real** — see {@link computeBlockedCounts}/
 * {@link computeReady} below, called from `buildIndex`. Filling in an
 * already-nullable field is not a reshape, so this doesn't need
 * `INDEX_SCHEMA_VERSION` bumped either — same reasoning as the
 * `fingerprint` shape change and the `problems` field below: a pre-fix
 * `index.jsonc` on disk simply fails schema validation against a
 * genuinely new shape and falls into the existing `invalid_schema`
 * auto-heal path, transparently rebuilding.
 *
 * **Known limitation this leaves (documented, not fixed — same class as
 * the mtime-granularity limitation below):** a schema bump protects
 * against a *shape* mismatch, not a *value* one. An `index.jsonc` already
 * on disk, written by a pre-B4 binary, has `blocked_count`/`ready` fields
 * that are already `null` — which still satisfies today's nullable
 * schema. If no ticket file has changed since (so the content fingerprint
 * still matches), `loadIndex()` will report that file `"fresh"` and serve
 * those stale nulls rather than the real computed values, until something
 * changes a ticket file or someone runs `slop reindex` (the same escape
 * hatch the mtime limitation already relies on). This is a real, narrow
 * gap for a long-lived local `.slop/db` upgraded across a `slop` binary
 * version boundary with no ticket writes in between; it does not affect
 * any fresh build (every test fixture, every fresh clone — index.jsonc is
 * gitignored, D14, so it never exists pre-populated) and self-heals on
 * the next `slop reindex` or the next ticket mutation either way.
 *
 * ## C5: `stale_at`/`review_stale_at` — a deadline, not a boolean
 *
 * A3 reserved two boolean fields here (`stale`/`review_stale`, always
 * `null`). C5 does **not** fill those booleans in — a boolean baked in at
 * build time would be wrong by construction, since staleness is a
 * function of wall-clock time and this index only rebuilds on ticket
 * *content* changes (the fingerprint above), never on the mere passage of
 * time. A ticket that goes stale purely because N hours elapsed with zero
 * edits would never trigger a reindex, so a baked `false` would stay
 * wrong forever — exactly the "stale review ticket surfaces" case C5's
 * acceptance criterion targets.
 *
 * Instead, {@link IndexTicketRow} carries `stale_at`/`review_stale_at`:
 * **content-derived deadline timestamps** (`last_activity_at +
 * stale_after` for `in_progress`; `review.requested_at +
 * review_stale_after` for `review`; `null` when the state doesn't apply —
 * see `src/tickets/staleness.ts`'s `computeStaleAt`/`computeReviewStaleAt`
 * for the full formulas and the `requested_at`-vs-`last_activity_at`
 * rationale). A deadline IS safe to store here, because — unlike a
 * boolean — it only changes when the ticket's own content changes
 * (`last_activity_at`/`review` moving, or a state transition), which the
 * fingerprint already tracks. The live `stale`/`review_stale` BOOLEAN is
 * computed at READ TIME by callers (`ready --resumable`, `status`) via
 * `staleness.ts`'s `isStale`/`isReviewStale`, against an explicitly
 * injected clock — never baked into this file. See DECISIONS.md's C5
 * entry for the fuller writeup, and `tests/acceptance/C5.test.ts` for the
 * proof: rebuilding the index at two different "now"s leaves a given
 * row's `stale_at` unchanged — only the derived boolean, computed
 * separately by the caller, differs.
 *
 * This IS a row-shape change (`stale`/`review_stale: boolean | null` →
 * `stale_at`/`review_stale_at: IsoTimestamp | null`) — unlike B4's
 * fill-in-a-nullable-field change above, a pre-C5 `index.jsonc` fails
 * schema validation against the new field names/types outright, so this
 * bumps {@link INDEX_SCHEMA_VERSION} (1 → 2) to force every such index
 * through the existing `invalid_schema`/`stale_schema_version` auto-heal
 * path rather than silently misreading old boolean fields as the new
 * timestamp ones.
 *
 * Thresholds come from `.slop/config.yaml`'s `defaults.stale_after`/
 * `review_stale_after` (design.md §3), read tolerantly via
 * `repo/config.ts`'s `loadConfigDefaultsTolerant` (never throws — falls
 * back to the schema's own defaults, `60m`/`24h`, so a repo with no
 * config.yaml, e.g. most unit-test fixtures, still builds a valid index).
 * `computeContentFingerprint` also fingerprints `config.yaml` itself (see
 * below), so editing `stale_after`/`review_stale_after` by hand is
 * treated the same as editing a ticket file: it invalidates the index and
 * triggers a rebuild on the next `loadIndex()` call, keeping every row's
 * `stale_at`/`review_stale_at` computed against the CURRENT configured
 * thresholds, not whatever was configured the last time some ticket file
 * happened to change.
 *
 * ## ticket_01KY9RWFM80BKNE2CDX85QMKGS: `latest_note`/`last_activity_at` are EFFECTIVE, not stored-verbatim
 *
 * A pure `slop update --progress "..."` (no other field) is lock-free
 * (`src/cli/commands/update.ts`): it appends a `ticket.updated` event
 * whose `payload.progress` carries the note and never re-reads/writes the
 * ticket file at all — no `withLock`, zero write contention between any
 * number of concurrent callers. That means the ticket file's own stored
 * `latest_note`/`last_activity_at` can lag behind reality, exactly the
 * way `index.jsonc` itself can lag a `git pull` — so this row's
 * `last_activity_at` (and new `latest_note` column) are the same kind of
 * DERIVED value `stale_at`/`review_stale_at` already are just above:
 * `deriveEffectiveOverlay` folds every `payload.progress`-carrying event
 * for a ticket in on top of its stored baseline, keeping whichever is
 * more recent. A LOCKED update that changes `--progress` alongside a real
 * field (state/priority/label/name/spec) still writes the ticket file
 * directly, exactly as before — its own accompanying event's `at` is
 * mint from the SAME clock reading `src/cli/commands/update.ts` used to
 * build the ticket, so the overlay is always a no-op there: single-writer
 * `status`/`show`/`ready`/`web` output is unaffected, byte for byte (see
 * DECISIONS.md / this ticket's report for the full writeup).
 *
 * Correctness depends on `loadIndex()` noticing a lock-free progress
 * event even though it never touches `tickets/` or `config.yaml` —
 * {@link computeContentFingerprint} therefore ALSO fingerprints
 * `events/` (see {@link fingerprintEventsDir}): since events are
 * immutable and strictly append-only (events.ts's module doc — no
 * `updateEvent`, no `deleteEvent`), `{count, digest: <max event id>}` is
 * a complete, cheap (zero `stat` calls) signature — it changes if, and
 * only if, at least one event was appended since the index was built.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import {
  isEventId,
  isTicketId,
  labelSchema,
  outgoingEdges,
  parentRefSchema,
  prioritySchema,
  sessionIdSchema,
  ticketIdSchema,
  ticketStateSchema,
} from "../core/index.js";
import type { Event, SessionId, Ticket, TicketId, TicketState } from "../core/index.js";
import { isoTimestampSchema } from "../core/timestamp.js";
import { slugSchema } from "../core/slug.js";
import { parseJsonc, writeCanonical } from "../core/jsonc.js";
import { isRepresentableDurationMs, parseDurationMs } from "../core/duration.js";
// C5: pure staleness-deadline formulas — see this module's "C5:
// stale_at/review_stale_at" doc section above for why importing from
// tickets/ (normally the reverse dependency direction — tickets/*.ts
// depends on repo/, not the other way around) is a deliberate, safe
// exception here: staleness.ts is pure/I-O-free (no import back on
// repo/), so there is no cycle, only a one-off crossing chosen so the
// formula lives alongside its sibling pure ticket-domain modules
// (tickets/ready.ts, tickets/status.ts, tickets/cascade.ts) rather than
// being duplicated or relocated into core/. See DECISIONS.md's C5 entry.
import { computeReviewStaleAt, computeStaleAt } from "../tickets/staleness.js";
import { atomicWriteFile } from "./atomic-write.js";
import { loadConfigDefaultsTolerant } from "./config.js";
import { listEventsTolerant } from "./events.js";
import { isEnoent, readDirSafe } from "./fs-utils.js";
import type { RepoPaths } from "./paths.js";
import { listTicketsTolerant } from "./tickets.js";

/**
 * C5 bumped this 1 → 2 (`stale`/`review_stale` -> `stale_at`/
 * `review_stale_at`). ticket_01KY9RWFM80BKNE2CDX85QMKGS bumps it again,
 * 2 → 3: a new required `latest_note` column joins `last_activity_at` as
 * an EFFECTIVE (event-derived), not stored-verbatim, value — see this
 * module's doc section above. A genuine row-shape change, not an
 * already-nullable-field fill-in, so any `index.jsonc` written by an
 * older binary fails `dbIndexSchema` validation against the new field and
 * falls into the existing `stale_schema_version`/`invalid_schema`
 * auto-heal path, exactly like every prior schema bump.
 */
export const INDEX_SCHEMA_VERSION = 3;

export const indexTicketRowSchema = z.object({
  id: ticketIdSchema,
  slug: slugSchema,
  name: z.string(),
  state: ticketStateSchema,
  priority: prioritySchema,
  parent: parentRefSchema.nullable(),
  root_id: ticketIdSchema,
  path: z.array(ticketIdSchema),
  labels: z.array(labelSchema),
  // --- ticket_01KY9RWFM80BKNE2CDX85QMKGS: EFFECTIVE, not stored-verbatim
  // — see this module's doc section above. `deriveEffectiveOverlay` folds
  // the ticket's stored baseline together with every `payload.progress`
  // -carrying event, so this reflects a lock-free `update --progress`
  // note the ticket FILE itself was never rewritten to contain. ---
  latest_note: z.string().nullable(),
  last_activity_at: isoTimestampSchema,
  active_session: sessionIdSchema.nullable(),

  // --- Reverse edges (derived; forward edges live only on the source
  // ticket — DECISIONS.md, outgoingEdges()). "parent" has no reverse
  // entry here: D6's materialised root_id/path already give every
  // descendant's ancestry without needing a "children of" index. ---
  /** Tickets whose `blocks` array names this ticket — i.e. who blocks it. */
  blocked_by: z.array(ticketIdSchema),
  /** Tickets whose `relates_to` array names this ticket. */
  related_from: z.array(ticketIdSchema),
  /** Tickets whose `discovered_from` array names this ticket. */
  discovered: z.array(ticketIdSchema),

  // --- B4 slots in here: count of *live* (non-done/dropped) entries in
  // `blocked_by`, and the `ready` query's per-ticket verdict. A3 always
  // writes `null`. ---
  blocked_count: z.number().int().nullable(),
  ready: z.boolean().nullable(),

  // --- C5: content-derived staleness DEADLINES, not booleans — see this
  // module's "C5: stale_at/review_stale_at" doc section above for why. A
  // ticket's own state + last_activity_at (in_progress) or
  // review.requested_at (review) plus config.yaml's stale_after/
  // review_stale_after; `null` when the state doesn't apply. Read-time
  // callers compute the live boolean via tickets/staleness.ts's
  // isStale/isReviewStale against an injected clock — never here. ---
  stale_at: isoTimestampSchema.nullable(),
  review_stale_at: isoTimestampSchema.nullable(),
});
export type IndexTicketRow = z.infer<typeof indexTicketRowSchema>;

/** One entity directory's (or, since C5, single tracked file's — see
 * `computeContentFingerprint`'s `config.yaml` entry) cheap staleness
 * signature — see the module doc's "Content staleness". `digest` is a
 * sha256 hex digest over every entity file's own `(filename, mtimeMs,
 * size)` tuple (or, for a single file, just its own `(mtimeMs, size)`),
 * computed from `readdir`/`stat` alone (never file content).
 */
export const dirFingerprintSchema = z.object({
  count: z.number().int().min(0),
  digest: z.string(),
});
export type DirFingerprint = z.infer<typeof dirFingerprintSchema>;

/** Keyed by logical directory name — just `"tickets"` today; a map (not a
 * fixed `{tickets: ...}` shape) so a later work item that makes the
 * index's content depend on `sessions/`/`events/` too can add a key here
 * without reshaping anything else. */
export const contentFingerprintSchema = z.record(z.string(), dirFingerprintSchema);
export type ContentFingerprint = z.infer<typeof contentFingerprintSchema>;

/** One ticket file `buildIndex` could not read — path, id, and the exact
 * high-quality error `readTicket` would have thrown, captured instead of
 * propagated. See the module doc's "Fault tolerance". */
export const ticketReadProblemSchema = z.object({
  id: ticketIdSchema,
  path: z.string(),
  message: z.string(),
});
export type TicketReadProblem = z.infer<typeof ticketReadProblemSchema>;

export const dbIndexSchema = z.object({
  schema_version: z.literal(INDEX_SCHEMA_VERSION),
  built_at: isoTimestampSchema,
  /** Staleness signature of the entity files this index was built from — see "Content staleness" above. */
  fingerprint: contentFingerprintSchema,
  tickets: z.array(indexTicketRowSchema),
  /** slug -> ticket id, for O(1) exact-slug ref resolution (refs.ts). */
  slugs: z.record(z.string(), ticketIdSchema),
  /** Ticket files skipped while building this index — see "Fault
   * tolerance" above. Empty in the overwhelming common case; never
   * causes `buildIndex` itself to throw. */
  problems: z.array(ticketReadProblemSchema),
});
export type DbIndex = z.infer<typeof dbIndexSchema>;

/**
 * B4: ticket states that no longer block anything (D5's "blocked" derived
 * overlay). A blocker that has reached one of these states is CLOSED and
 * stops counting as a "live" blocker for whatever it names in its own
 * `blocks` array — this is the exact "live" in "live blocker" throughout
 * design.md §2 and this work item's brief. Matches `src/tickets/state.ts`'s
 * own treatment of `done`/`dropped` as terminal (`RAW_STATE_TRANSITIONS`)
 * and `sessions/context-pack.ts`'s pre-existing ad hoc live-blocker filter
 * (`t.state !== "done" && t.state !== "dropped"`) — this is now the one
 * place that rule lives, reused by both `buildIndex` below and B4's
 * done-cascade (`src/tickets/cascade.ts`), which recomputes
 * {@link computeBlockedCounts} fresh against a freshly re-read ticket list
 * rather than trusting any persisted counter (see that module's doc for
 * why recompute-from-truth, not a mutated counter, is this work item's
 * chosen design).
 */
const CLOSED_TICKET_STATES: ReadonlySet<TicketState> = new Set(["done", "dropped"]);

/** Is a ticket in `state` still capable of blocking something? See {@link CLOSED_TICKET_STATES}. */
export function isLiveBlockerState(state: TicketState): boolean {
  return !CLOSED_TICKET_STATES.has(state);
}

/**
 * B4: live blocked-by count for every ticket in `tickets` — for each
 * ticket, how many OTHER tickets currently in a non-`done`/`dropped` state
 * name it in their own `blocks` array. Pure, synchronous, no I/O. Always
 * has an entry (possibly `0`) for every id in `tickets`, so a caller may
 * `.get(id) ?? 0` purely defensively — every real id IS present.
 *
 * This is the ONE place `blocked_count` is computed: `buildIndex` calls it
 * over the full ticket set below, and B4's done-cascade
 * (`src/tickets/cascade.ts`) calls it again over a freshly re-read ticket
 * set after a closure, instead of decrementing a number stored anywhere
 * (D5: `blocked` is a derived overlay, never asserted — there is nowhere
 * on a `Ticket` to hold a running counter even if this wanted to).
 */
export function computeBlockedCounts(tickets: readonly Ticket[]): Map<TicketId, number> {
  const counts = new Map<TicketId, number>();
  for (const ticket of tickets) counts.set(ticket.id, 0);
  for (const blocker of tickets) {
    if (!isLiveBlockerState(blocker.state)) continue;
    for (const edge of outgoingEdges(blocker)) {
      if (edge.kind !== "blocks") continue;
      if (!isTicketId(edge.to)) continue; // "blocks" edges are always local (edge.ts) — defensive only
      if (!counts.has(edge.to)) continue; // target absent from this ticket set — shouldn't happen for a consistent db
      counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * B4: design.md §2's `ready` verdict for a single ticket, verbatim —
 * `open ∧ no live blockers ∧ no active session`. Pure; the one place this
 * predicate is implemented, so `buildIndex`'s `ready` column and any other
 * caller that needs to ask "would this ticket be ready" (e.g. B4's
 * done-cascade, deciding whether a newly-unblocked ticket deserves a
 * `ticket.ready` event) always agree.
 */
export function computeReady(
  state: TicketState,
  liveBlockedCount: number,
  activeSession: SessionId | null,
): boolean {
  return state === "open" && liveBlockedCount === 0 && activeSession === null;
}

/** {@link deriveEffectiveOverlay}'s result — the two fields
 * ticket_01KY9RWFM80BKNE2CDX85QMKGS makes derived, not stored-verbatim. */
export interface EffectiveOverlay {
  latest_note: string | null;
  last_activity_at: string;
}

/** The minimal ticket-shaped input {@link deriveEffectiveOverlay} needs. */
export interface EffectiveOverlaySource {
  latest_note: string | null;
  last_activity_at: string;
}

/**
 * ticket_01KY9RWFM80BKNE2CDX85QMKGS: fold a ticket's stored baseline
 * together with every `payload.progress`-carrying event for that same
 * ticket, keeping whichever note is most recent — this is the ONE place
 * that combination happens; `buildIndex` below calls it per ticket, over
 * every event already grouped by `entity.id`.
 *
 * `events` MUST already be scoped to this one ticket (`buildIndex` groups
 * every event by `entity.id` once, up front, rather than filtering per
 * row) — a non-`"ticket"`-kind entry is skipped defensively, but this
 * function never checks `entity.id` itself. Order MUST be cursor
 * (ascending id / chronological), exactly what {@link listEventsTolerant}/
 * {@link listEvents} already return: since two events can (rarely, under
 * real concurrency) share the same millisecond-resolution `at`, iterating
 * in id order and using `>=` (not `>`) to decide "this event is newer"
 * means ties resolve toward whichever event has the greater id — full
 * determinism, without needing the id itself as a second sort key.
 *
 * A LOCKED `update --progress` (progress alongside a real field change)
 * mints its accompanying event from the exact same clock reading used to
 * build the ticket it writes (`src/cli/commands/update.ts`), so that
 * event's `at` is never strictly greater than the ticket's own
 * `last_activity_at` — the `>=` comparison below can re-select it, but
 * only ever with content identical to the stored baseline it's tied
 * with, so the effective result is byte-for-byte the same either way.
 * Only a genuinely lock-free progress event (whose `at` is strictly
 * later, having never touched the ticket file's own baseline at all) can
 * actually move the result.
 */
export function deriveEffectiveOverlay(
  ticket: EffectiveOverlaySource,
  events: readonly Event[],
): EffectiveOverlay {
  let latestNote = ticket.latest_note;
  let lastActivityAt = ticket.last_activity_at;
  for (const event of events) {
    if (event.entity.kind !== "ticket") continue;
    const progress = event.payload.progress;
    if (typeof progress !== "string") continue;
    if (event.at >= lastActivityAt) {
      lastActivityAt = event.at;
      latestNote = progress;
    }
  }
  return { latest_note: latestNote, last_activity_at: lastActivityAt };
}

function pushInto<K>(map: Map<K, TicketId[]>, key: K, value: TicketId): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

interface StatTuple {
  name: string;
  mtimeMs: number;
  size: number;
}

async function fingerprintTicketsDir(dir: string): Promise<DirFingerprint> {
  const names = await readDirSafe(dir);
  const entityNames = names.filter((name) => {
    if (!name.endsWith(".jsonc")) return false;
    return isTicketId(name.slice(0, -".jsonc".length));
  });

  const stats = await Promise.all(
    entityNames.map(async (name): Promise<StatTuple | null> => {
      try {
        const st = await stat(join(dir, name));
        return { name, mtimeMs: st.mtimeMs, size: st.size };
      } catch (err) {
        // Deleted between readdir and stat — a benign race with a
        // concurrent write, not an error; just excluded below.
        if (isEnoent(err)) return null;
        throw err;
      }
    }),
  );

  const present = stats.filter((s): s is StatTuple => s !== null);
  // Sort by filename — readdir order isn't guaranteed, and the digest
  // must be a pure function of directory *content*, not listing order.
  present.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const hash = createHash("sha256");
  for (const entry of present) {
    hash.update(entry.name);
    hash.update(" ");
    hash.update(String(entry.mtimeMs));
    hash.update(" ");
    hash.update(String(entry.size));
    hash.update("\n");
  }

  return { count: present.length, digest: hash.digest("hex") };
}

/**
 * C5: `config.yaml`'s own `(mtimeMs, size)` fingerprint — the single-file
 * analogue of {@link fingerprintTicketsDir}, shaped the same
 * (`DirFingerprint`) so it fits `ContentFingerprint`'s existing
 * `Record<string, DirFingerprint>` shape with no schema change. `count` is
 * `0`/`1` for absent/present, so a config.yaml being created or deleted
 * also changes the fingerprint, not just an edit to an existing one.
 */
async function fingerprintConfigFile(configPath: string): Promise<DirFingerprint> {
  try {
    const st = await stat(configPath);
    const hash = createHash("sha256");
    hash.update(String(st.mtimeMs));
    hash.update(" ");
    hash.update(String(st.size));
    return { count: 1, digest: hash.digest("hex") };
  } catch (err) {
    if (isEnoent(err)) return { count: 0, digest: "absent" };
    throw err;
  }
}

/**
 * ticket_01KY9RWFM80BKNE2CDX85QMKGS: `events/`'s own fingerprint — cheaper
 * than {@link fingerprintTicketsDir}'s (zero `stat` calls, `readdir` only)
 * because it can be: events are immutable and strictly append-only
 * (events.ts's module doc — no `updateEvent`, no `deleteEvent`), so
 * `{count, digest: <max event id>}` is already a complete signature of
 * "every event id currently on disk" — ids are ULIDs, so the lexically
 * greatest one is also the most recently appended, and any append at all
 * changes both `count` and `digest`. This is what lets `loadIndex()`
 * notice a lock-free `update --progress` event even though appending one
 * never touches `tickets/` or `config.yaml`.
 */
async function fingerprintEventsDir(dir: string): Promise<DirFingerprint> {
  const names = await readDirSafe(dir);
  const ids = names
    .filter((name) => name.endsWith(".jsonc"))
    .map((name) => name.slice(0, -".jsonc".length))
    .filter(isEventId)
    .sort();
  const last = ids[ids.length - 1];
  return { count: ids.length, digest: last ?? "empty" };
}

/**
 * Cheap staleness signal for `loadIndex()`'s auto-heal — `readdir`/`stat`
 * only, no file content read or parsed. See the module doc's "Content
 * staleness" section for the full rationale and the known
 * mtime-granularity limitation. C5: also fingerprints `config.yaml`
 * itself (key `"config"`) — `stale_at`/`review_stale_at` are computed
 * from its `defaults.*` thresholds, so a hand-edit to config.yaml must
 * invalidate the index exactly like a ticket-file edit does.
 * ticket_01KY9RWFM80BKNE2CDX85QMKGS: also fingerprints `events/` (key
 * `"events"`, {@link fingerprintEventsDir}) — see this module's doc
 * section above.
 */
export async function computeContentFingerprint(paths: RepoPaths): Promise<ContentFingerprint> {
  const configPath = join(paths.slopDir, "config.yaml");
  const [tickets, config, events] = await Promise.all([
    fingerprintTicketsDir(paths.ticketsDir),
    fingerprintConfigFile(configPath),
    fingerprintEventsDir(paths.eventsDir),
  ]);
  return { tickets, config, events };
}

function fingerprintsEqual(a: ContentFingerprint, b: ContentFingerprint): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const fa = a[key];
    const fb = b[key];
    if (!fa || !fb) return false;
    if (fa.count !== fb.count || fa.digest !== fb.digest) return false;
  }
  return true;
}

/**
 * Render `problems` as a human-actionable, multi-line report. Reused by
 * both {@link loadIndex}'s stderr warning and `slop reindex`'s own report
 * (src/cli/commands/reindex.ts), so the message quality `readEntityFile`
 * already provides (exact path, 1-based line:column, specific parse code
 * / zod path) is preserved everywhere problems surface, not re-derived
 * per call site.
 */
export function formatIndexProblems(problems: TicketReadProblem[]): string {
  const header = `${problems.length} ticket file(s) could not be read and were skipped while building the index:`;
  const body = problems.map((p) => {
    const indented = p.message
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    return `  - ${p.path}\n${indented}`;
  });
  return [header, ...body].join("\n");
}

function warnAboutIndexProblems(problems: TicketReadProblem[]): void {
  process.stderr.write(`warning: ${formatIndexProblems(problems)}\n`);
}

/** duration-huge-stale-after-overflows: see `buildIndex`'s call sites. */
function warnAboutUnrepresentableDuration(field: string, configured: string, ms: number): void {
  if (isRepresentableDurationMs(ms)) return;
  process.stderr.write(
    `warning: config.yaml's defaults.${field} ("${configured}") is too large to represent as a date offset; ` +
      `staleness is disabled for it (the deadline is always null) until it's set to something smaller.\n`,
  );
}

/** Build the index from scratch by scanning every ticket on disk. Pure
 * function of the tickets directory's contents (plus `clock` for the
 * `built_at` stamp) — no reads of any previous index. Never throws on a
 * corrupt/unreadable ticket file (see the module doc's "Fault
 * tolerance") — those are collected into the returned index's `problems`
 * instead.
 *
 * The fingerprint is captured *before* reading/validating every ticket,
 * not after: if a concurrent write lands in between, this ordering means
 * the recorded fingerprint undershoots the true current state, so the
 * *next* `loadIndex()` call sees a mismatch and rebuilds again (safe —
 * an extra rebuild). The reverse ordering could let a fingerprint
 * overshoot what `rows` actually reflects, which would let a genuinely
 * stale index pass as fresh — the one outcome this mechanism exists to
 * prevent. The ticket read and the (separate, C5) config-defaults read
 * below happen afterward, and may run concurrently with each other —
 * same "undershoot is safe" reasoning covers any race between the two:
 * worst case, the fingerprint reflects a config.yaml a moment older than
 * the thresholds just used, and the very next `loadIndex()` call's own
 * fresh fingerprint catches the difference and rebuilds again. */
export async function buildIndex(paths: RepoPaths, clock: Clock = systemClock): Promise<DbIndex> {
  const fingerprint = await computeContentFingerprint(paths);
  const [{ tickets, problems }, configDefaults, events] = await Promise.all([
    listTicketsTolerant(paths),
    // C5: tolerant — never throws, falls back to schema defaults (60m/24h)
    // when config.yaml is missing/unparseable (see repo/config.ts).
    loadConfigDefaultsTolerant(paths),
    // ticket_01KY9RWFM80BKNE2CDX85QMKGS: fault-tolerant, same rationale as
    // listTicketsTolerant above — one damaged event file must not take
    // the whole index build down.
    listEventsTolerant(paths),
  ]);
  const staleAfterMs = parseDurationMs(configDefaults.stale_after);
  const reviewStaleAfterMs = parseDurationMs(configDefaults.review_stale_after);
  // duration-huge-stale-after-overflows: an absurdly large stale_after/
  // review_stale_after (config.yaml has no schema-level magnitude cap —
  // core/entities/config.ts) overflows what a Date can represent;
  // staleness.ts's computeStaleAt/computeReviewStaleAt already handle this
  // by returning null (staleness disabled) instead of throwing, but that
  // must not be silent — warn once per build so a repo owner who typoed a
  // few too many digits (rather than deliberately meaning "never") finds
  // out, same "loud, never silent" spirit as this module's ticket-problems
  // warning above.
  warnAboutUnrepresentableDuration("stale_after", configDefaults.stale_after, staleAfterMs);
  warnAboutUnrepresentableDuration(
    "review_stale_after",
    configDefaults.review_stale_after,
    reviewStaleAfterMs,
  );

  // ticket_01KY9RWFM80BKNE2CDX85QMKGS: group once, up front — O(events),
  // not O(tickets × events) — then {@link deriveEffectiveOverlay} looks up
  // each ticket's own (already cursor-ordered) slice in O(1).
  const eventsByTicket = new Map<TicketId, Event[]>();
  for (const event of events) {
    if (event.entity.kind !== "ticket" || !isTicketId(event.entity.id)) continue;
    const list = eventsByTicket.get(event.entity.id);
    if (list) list.push(event);
    else eventsByTicket.set(event.entity.id, [event]);
  }

  const blockedBy = new Map<TicketId, TicketId[]>();
  const relatedFrom = new Map<TicketId, TicketId[]>();
  const discovered = new Map<TicketId, TicketId[]>();
  for (const ticket of tickets) {
    for (const edge of outgoingEdges(ticket)) {
      if (!isTicketId(edge.to)) continue; // only `parent` edges may be external (edge.ts); irrelevant here
      if (edge.kind === "blocks") pushInto(blockedBy, edge.to, edge.from);
      else if (edge.kind === "relates-to") pushInto(relatedFrom, edge.to, edge.from);
      else if (edge.kind === "discovered-from") pushInto(discovered, edge.to, edge.from);
    }
  }

  // B4: computed once over the full ticket set, then read per-row below —
  // see computeBlockedCounts's doc for why this (not a stored/decremented
  // counter) is the design.
  const blockedCounts = computeBlockedCounts(tickets);

  const rows: IndexTicketRow[] = tickets
    .map((ticket: Ticket): IndexTicketRow => {
      const liveBlockedCount = blockedCounts.get(ticket.id) ?? 0;
      // ticket_01KY9RWFM80BKNE2CDX85QMKGS: the effective overlay — see
      // this module's doc section and deriveEffectiveOverlay's own doc.
      // `stale_at`/`review_stale_at` below are computed against the
      // EFFECTIVE last_activity_at too: a lock-free progress note is
      // activity, and must reset the staleness clock exactly like a
      // locked one always has.
      const overlay = deriveEffectiveOverlay(ticket, eventsByTicket.get(ticket.id) ?? []);
      return {
        id: ticket.id,
        slug: ticket.slug,
        name: ticket.name,
        state: ticket.state,
        priority: ticket.priority,
        parent: ticket.parent ?? null,
        root_id: ticket.root_id,
        path: ticket.path,
        labels: ticket.labels,
        latest_note: overlay.latest_note,
        last_activity_at: overlay.last_activity_at,
        active_session: ticket.active_session,
        blocked_by: blockedBy.get(ticket.id) ?? [],
        related_from: relatedFrom.get(ticket.id) ?? [],
        discovered: discovered.get(ticket.id) ?? [],
        blocked_count: liveBlockedCount,
        ready: computeReady(ticket.state, liveBlockedCount, ticket.active_session),
        // C5: content-derived deadlines, not booleans — see this module's
        // "C5" doc section. Pure functions of the ticket's own state +
        // last_activity_at/review.requested_at + the configured
        // thresholds; the live boolean is computed at read time by
        // callers (ready --resumable, status), never here.
        stale_at: computeStaleAt(
          { state: ticket.state, last_activity_at: overlay.last_activity_at },
          staleAfterMs,
        ),
        review_stale_at: computeReviewStaleAt(
          {
            state: ticket.state,
            review: ticket.review,
            last_activity_at: overlay.last_activity_at,
          },
          reviewStaleAfterMs,
        ),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const slugs: Record<string, TicketId> = {};
  for (const ticket of tickets) {
    // Slugs are unique by construction (B1's nextAvailableSlug collision
    // suffix); last-writer-wins here is purely defensive against a
    // hand-edited duplicate, not an expected case.
    slugs[ticket.slug] = ticket.id;
  }

  return {
    schema_version: INDEX_SCHEMA_VERSION,
    built_at: clock.now().toISOString(),
    fingerprint,
    tickets: rows,
    slugs,
    problems,
  };
}

export async function writeIndex(paths: RepoPaths, index: DbIndex): Promise<void> {
  await atomicWriteFile(paths.indexFile, writeCanonical(index));
}

/**
 * `buildIndex` + `writeIndex` in one call — exactly what `slop reindex`
 * does (src/cli/commands/reindex.ts), and the manual escape hatch for
 * the rare case the cheap fingerprint-based staleness check in
 * `loadIndex()` can't see (the millisecond-granularity limitation
 * documented on {@link computeContentFingerprint}). Fault-tolerant, same
 * as `buildIndex` — check the returned index's `problems` rather than
 * expecting a throw.
 */
export async function rebuildIndex(paths: RepoPaths, clock: Clock = systemClock): Promise<DbIndex> {
  const index = await buildIndex(paths, clock);
  await writeIndex(paths, index);
  return index;
}

export type IndexLoadReason =
  | "fresh"
  | "missing"
  | "parse_error"
  | "stale_schema_version"
  | "invalid_schema"
  | "stale_content";

export interface LoadIndexResult {
  index: DbIndex;
  /** `true` if this call had to rebuild (and rewrite) the index. */
  rebuilt: boolean;
  reason: IndexLoadReason;
}

type ReadIndexResult =
  | { ok: true; index: DbIndex }
  | { ok: false; reason: Exclude<IndexLoadReason, "fresh"> };

async function tryReadValidIndex(paths: RepoPaths): Promise<ReadIndexResult> {
  let raw: string;
  try {
    raw = await readFile(paths.indexFile, "utf8");
  } catch (err) {
    if (isEnoent(err)) return { ok: false, reason: "missing" };
    throw err;
  }

  const { value, errors } = parseJsonc<unknown>(raw);
  if (errors.length > 0) return { ok: false, reason: "parse_error" };

  const parsed = dbIndexSchema.safeParse(value);
  if (!parsed.success) {
    const versionField = (value as { schema_version?: unknown } | null)?.schema_version;
    if (versionField !== INDEX_SCHEMA_VERSION) {
      return { ok: false, reason: "stale_schema_version" };
    }
    return { ok: false, reason: "invalid_schema" };
  }

  // Schema-valid — now the cheap content-staleness check (readdir+stat
  // only, see the module doc's "Content staleness").
  const currentFingerprint = await computeContentFingerprint(paths);
  if (!fingerprintsEqual(parsed.data.fingerprint, currentFingerprint)) {
    return { ok: false, reason: "stale_content" };
  }

  return { ok: true, index: parsed.data };
}

/**
 * The one function every read path that needs the index should call.
 * Returns the current, valid index — transparently rebuilding (and
 * persisting the rebuild) if what's on disk is missing, unparseable, has
 * a stale schema version, fails validation, or is stale relative to the
 * entity files it was built from (content fingerprint mismatch — catches
 * `git merge`/`git pull`/`$EDITOR` changes, not just a deleted index).
 *
 * Never throws for any of those reasons — including when one or more
 * ticket files are unreadable: those are recorded in the returned
 * index's `problems` array and warned about on stderr (never silently
 * dropped) rather than aborting the whole build (adversarial-review
 * Finding 3; see the module doc's "Fault tolerance").
 */
export async function loadIndex(
  paths: RepoPaths,
  clock: Clock = systemClock,
): Promise<LoadIndexResult> {
  const existing = await tryReadValidIndex(paths);
  let result: LoadIndexResult;
  if (existing.ok) {
    result = { index: existing.index, rebuilt: false, reason: "fresh" };
  } else {
    const index = await buildIndex(paths, clock);
    await writeIndex(paths, index);
    result = { index, rebuilt: true, reason: existing.reason };
  }

  // Never silent (Finding 3): warn on EVERY call that returns an index
  // carrying problems, not just the one that triggered a rebuild — a
  // "fresh" (non-rebuilt) load can still be serving a persisted problems
  // list from an earlier build, and that must stay loud until it's fixed.
  if (result.index.problems.length > 0) {
    warnAboutIndexProblems(result.index.problems);
  }

  return result;
}
