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
 * per entity directory the index's content depends on (today: just
 * `tickets/`), the file count and the max mtime across those files, in
 * milliseconds (see {@link computeContentFingerprint}). `loadIndex()`
 * recomputes this fingerprint on every call via `readdir` + `stat` only —
 * no file is parsed or its content read — and rebuilds if it differs from
 * the one recorded in the index, exactly like the missing/unparseable/
 * stale-schema-version cases (`reason: "stale_content"`). This is cheap:
 * see this work item's report for a measured number on ~1k tickets, kept
 * well inside D4's "< 1s on 1k tickets" budget.
 *
 * KNOWN LIMITATION: mtime has millisecond granularity (coarser on some
 * filesystems). A write landing within the same millisecond as the
 * index's last build could theoretically be missed by this check.
 * Accepted for v0 — `slop reindex` is the explicit manual escape hatch,
 * and the *next* write that actually changes the file count or advances
 * `max_mtime_ms` past that millisecond is caught normally.
 *
 * Shape: per-ticket summary rows, a slug→id map, and reverse edges
 * (edges are stored only on the source ticket — DECISIONS.md — so "who
 * blocks me" etc. has to be derived by scanning every ticket's outgoing
 * edges and inverting).
 *
 * B4's and C5's room to grow, without a schema-version bump: every
 * {@link IndexTicketRow} already carries `blocked_count`/`ready` (B4:
 * "Derivations: blocked_count in index, ready query ... done-cascade")
 * and `stale`/`review_stale` (C5: "Staleness: stale_after /
 * review_stale_after computed in index") fields, typed as `<T> | null`.
 * A3 always writes `null` for all four here — populating them is B4's
 * and C5's job respectively — but the fields exist structurally now, so
 * landing that work is filling in a value, not reshaping the index (and
 * therefore doesn't need `INDEX_SCHEMA_VERSION` bumped).
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import {
  isTicketId,
  labelSchema,
  outgoingEdges,
  parentRefSchema,
  prioritySchema,
  sessionIdSchema,
  ticketIdSchema,
  ticketStateSchema,
} from "../core/index.js";
import type { Ticket, TicketId } from "../core/index.js";
import { isoTimestampSchema } from "../core/timestamp.js";
import { slugSchema } from "../core/slug.js";
import { parseJsonc, writeCanonical } from "../core/jsonc.js";
import { atomicWriteFile } from "./atomic-write.js";
import { isEnoent, readDirSafe } from "./fs-utils.js";
import type { RepoPaths } from "./paths.js";
import { listTickets } from "./tickets.js";

export const INDEX_SCHEMA_VERSION = 1;

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

  // --- C5 slots in here: `stale_after`/`review_stale_after` computed
  // against `last_activity_at` (clock-injected per C5's own acceptance
  // criterion). A3 always writes `null`. ---
  stale: z.boolean().nullable(),
  review_stale: z.boolean().nullable(),
});
export type IndexTicketRow = z.infer<typeof indexTicketRowSchema>;

/** One entity directory's cheap staleness signature — see the module doc's
 * "Content staleness". `max_mtime_ms` is deliberately NOT `.int()`:
 * `fs.Stats#mtimeMs` on Linux carries sub-millisecond precision (a
 * fractional value from dividing a nanosecond-resolution timestamp), so
 * an integer-only schema would make a freshly built index fail its own
 * re-validation on the very next read almost every time. */
export const dirFingerprintSchema = z.object({
  count: z.number().int().min(0),
  max_mtime_ms: z.number().min(0),
});
export type DirFingerprint = z.infer<typeof dirFingerprintSchema>;

/** Keyed by logical directory name — just `"tickets"` today; a map (not a
 * fixed `{tickets: ...}` shape) so a later work item that makes the
 * index's content depend on `sessions/`/`events/` too can add a key here
 * without reshaping anything else. */
export const contentFingerprintSchema = z.record(z.string(), dirFingerprintSchema);
export type ContentFingerprint = z.infer<typeof contentFingerprintSchema>;

export const dbIndexSchema = z.object({
  schema_version: z.literal(INDEX_SCHEMA_VERSION),
  built_at: isoTimestampSchema,
  /** Staleness signature of the entity files this index was built from — see "Content staleness" above. */
  fingerprint: contentFingerprintSchema,
  tickets: z.array(indexTicketRowSchema),
  /** slug -> ticket id, for O(1) exact-slug ref resolution (refs.ts). */
  slugs: z.record(z.string(), ticketIdSchema),
});
export type DbIndex = z.infer<typeof dbIndexSchema>;

function pushInto<K>(map: Map<K, TicketId[]>, key: K, value: TicketId): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

async function fingerprintTicketsDir(dir: string): Promise<DirFingerprint> {
  const names = await readDirSafe(dir);
  const entityNames = names.filter((name) => {
    if (!name.endsWith(".jsonc")) return false;
    return isTicketId(name.slice(0, -".jsonc".length));
  });
  if (entityNames.length === 0) return { count: 0, max_mtime_ms: 0 };

  const stats = await Promise.all(
    entityNames.map(async (name) => {
      try {
        return await stat(join(dir, name));
      } catch (err) {
        // Deleted between readdir and stat — a benign race with a
        // concurrent write, not an error; just excluded below.
        if (isEnoent(err)) return null;
        throw err;
      }
    }),
  );

  let count = 0;
  let maxMtimeMs = 0;
  for (const s of stats) {
    if (s === null) continue;
    count++;
    if (s.mtimeMs > maxMtimeMs) maxMtimeMs = s.mtimeMs;
  }
  return { count, max_mtime_ms: maxMtimeMs };
}

/**
 * Cheap staleness signal for `loadIndex()`'s auto-heal — `readdir` +
 * `stat` only, no file content read or parsed. See the module doc's
 * "Content staleness" section for the full rationale and the known
 * mtime-granularity limitation.
 */
export async function computeContentFingerprint(paths: RepoPaths): Promise<ContentFingerprint> {
  return { tickets: await fingerprintTicketsDir(paths.ticketsDir) };
}

function fingerprintsEqual(a: ContentFingerprint, b: ContentFingerprint): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const fa = a[key];
    const fb = b[key];
    if (!fa || !fb) return false;
    if (fa.count !== fb.count || fa.max_mtime_ms !== fb.max_mtime_ms) return false;
  }
  return true;
}

/** Build the index from scratch by scanning every ticket on disk. Pure
 * function of the tickets directory's contents (plus `clock` for the
 * `built_at` stamp) — no reads of any previous index.
 *
 * The fingerprint is captured *before* reading/validating every ticket,
 * not after: if a concurrent write lands in between, this ordering means
 * the recorded fingerprint undershoots the true current state, so the
 * *next* `loadIndex()` call sees a mismatch and rebuilds again (safe —
 * an extra rebuild). The reverse ordering could let a fingerprint
 * overshoot what `rows` actually reflects, which would let a genuinely
 * stale index pass as fresh — the one outcome this mechanism exists to
 * prevent. */
export async function buildIndex(paths: RepoPaths, clock: Clock = systemClock): Promise<DbIndex> {
  const fingerprint = await computeContentFingerprint(paths);
  const tickets = await listTickets(paths);

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

  const rows: IndexTicketRow[] = tickets
    .map(
      (ticket: Ticket): IndexTicketRow => ({
        id: ticket.id,
        slug: ticket.slug,
        name: ticket.name,
        state: ticket.state,
        priority: ticket.priority,
        parent: ticket.parent ?? null,
        root_id: ticket.root_id,
        path: ticket.path,
        labels: ticket.labels,
        last_activity_at: ticket.last_activity_at,
        active_session: ticket.active_session,
        blocked_by: blockedBy.get(ticket.id) ?? [],
        related_from: relatedFrom.get(ticket.id) ?? [],
        discovered: discovered.get(ticket.id) ?? [],
        blocked_count: null,
        ready: null,
        stale: null,
        review_stale: null,
      }),
    )
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
  };
}

export async function writeIndex(paths: RepoPaths, index: DbIndex): Promise<void> {
  await atomicWriteFile(paths.indexFile, writeCanonical(index));
}

/**
 * `buildIndex` + `writeIndex` in one call — exactly what `slop reindex`
 * does (src/cli/commands/reindex.ts), and the manual escape hatch for
 * the rare case the cheap mtime-based staleness check in `loadIndex()`
 * can't see (the millisecond-granularity limitation documented on
 * {@link computeContentFingerprint}).
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

type ReadIndexResult = { ok: true; index: DbIndex } | { ok: false; reason: Exclude<IndexLoadReason, "fresh"> };

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
 * Never throws for any of those reasons; only a genuine failure to
 * *build* the index (e.g. a corrupt ticket file — see tickets.ts's
 * listTickets) propagates.
 */
export async function loadIndex(paths: RepoPaths, clock: Clock = systemClock): Promise<LoadIndexResult> {
  const existing = await tryReadValidIndex(paths);
  if (existing.ok) {
    return { index: existing.index, rebuilt: false, reason: "fresh" };
  }
  const index = await buildIndex(paths, clock);
  await writeIndex(paths, index);
  return { index, rebuilt: true, reason: existing.reason };
}
