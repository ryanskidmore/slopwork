/**
 * The data-source seam for `slop web` (design.md §4.4, work item D5).
 *
 * Every view in src/web/views/ talks to a {@link WebDataSource} and knows
 * nothing else about where the data actually comes from. Two things read
 * this interface's contract closely:
 *
 *  - {@link ../fixture-data-source.js!FixtureDataSource} (this work item):
 *    reads a `.slop`-shaped directory straight off disk with plain `fs`
 *    calls, validating everything against the A2 zod schemas. It does not
 *    lock, does not write, and recomputes derived overlays (blocked/stale,
 *    design.md D5) in memory on every call rather than trusting a
 *    persisted `index.jsonc` — all fine for a read-only viewer at v0
 *    scale, and exactly why this work item does not need to wait on A3.
 *
 *  - {@link ../storage-data-source.js!StorageDataSource} (G2): the real
 *    adapter, backed by a {@link ../../storage/backend.js!StorageBackend}
 *    (`slop web`'s actual data source since G2 — see that class's doc for
 *    exactly what it reuses from `FixtureDataSource` vs. the storage
 *    layer).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, Event, Session, Ticket, TicketId } from "../core/index.js";
import { configSchema, parseConfigYamlText } from "../core/index.js";

/**
 * {@link WebDataSource.getConfig}'s return shape — web-corrupt-or-missing-config:
 * `config.yaml` is a git-mergeable, collaborator-editable file, so ENOENT
 * (never written yet) and a bad merge/hand-edit (invalid YAML, or YAML that
 * fails `configSchema`) are both realistic, not just theoretical. Every
 * §4.4 view calls `getConfig()`, so a throw there used to take the ENTIRE
 * web UI down with an opaque 500 on every single page — the same class of
 * fragility `readJsoncDir` (fixture-data-source.ts) already fixed for the
 * tickets/sessions/events listings. `getConfig()` now never throws: `warning`
 * is non-null (and `config` is a synthesized default) whenever the real
 * file couldn't be read/parsed/validated, so callers can render the rest of
 * the page normally and just surface `warning` to the human instead of
 * 500ing.
 */
export interface ConfigResult {
  /** The real parsed+validated config.yaml, or a synthesized default when `warning` is set. */
  config: Config;
  /** Human-readable explanation of what went wrong reading config.yaml, or `null` when it loaded cleanly. */
  warning: string | null;
}

/**
 * `project` has no schema default (design.md §3: it's required, prompted at
 * `init`) — so a synthesized fallback {@link Config} needs an explicit
 * stand-in. Deliberately visible/unusual rather than something that could
 * pass for a real project name, since {@link readSlopConfigTolerant} only
 * ever returns this alongside a non-null `warning` the caller is expected
 * to surface too.
 */
const FALLBACK_PROJECT_LABEL = "(unknown — config.yaml unavailable)";

/**
 * web-corrupt-or-missing-config: the ONE tolerant `.slop/config.yaml`
 * reader every {@link WebDataSource} implementation's `getConfig()` uses —
 * `FixtureDataSource` and {@link ../storage-data-source.js!StorageDataSource}
 * both call this rather than each re-implementing the same "never throws"
 * contract. Config.yaml is deliberately NOT read through
 * {@link ../storage/backend.js!StorageBackend}: it's what SELECTS a
 * backend in the first place (a repo needs `backend:` read locally before
 * it can even construct a remote client), and it's a single small local
 * file regardless of which backend is configured — there is nothing about
 * reading it that a remote backend would do any differently.
 *
 * Never throws: `config.yaml` missing (ENOENT), unreadable, invalid YAML,
 * or schema-invalid all degrade to the same outcome — a synthesized
 * default {@link Config} plus a non-null `warning` — instead of taking
 * every §4.4 view down with a 500 (they all call `getConfig()`). Logged to
 * stderr too (matches `fixture-data-source.ts`'s `warnSkippedFiles`
 * convention for the tickets/sessions/events listings) so a real `slop
 * web` operator sees it even if they don't have the browser open.
 */
export async function readSlopConfigTolerant(slopRoot: string): Promise<ConfigResult> {
  const path = join(slopRoot, "config.yaml");
  try {
    const text = await readFile(path, "utf8");
    const parsed = parseConfigYamlText(text);
    return { config: configSchema.parse(parsed), warning: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const warning = `config.yaml could not be read — showing defaults (${message})`;
    process.stderr.write(`slop web: ${path}: ${message}\n`);
    return { config: configSchema.parse({ project: FALLBACK_PROJECT_LABEL }), warning };
  }
}

/**
 * The read operations every §4.4 view needs. Nothing here writes, matching
 * design.md §4.6: "web mutations are explicitly out of scope" for v0.
 */
export interface WebDataSource {
  /** `.slop/config.yaml`, validated against configSchema — never throws, see {@link ConfigResult}. */
  getConfig(): Promise<ConfigResult>;

  /** Every ticket in the db (every state, including draft/dropped) — views filter/sort/paginate in memory. */
  listTickets(): Promise<Ticket[]>;

  /**
   * Resolve a user- or link-supplied ref to exactly one ticket: an exact
   * id, an exact slug, or an unambiguous short id-prefix (D6/D12 — see
   * core/ids.ts `idMatchesRef`, reused here rather than reimplemented).
   * `null` for zero matches *or* more than one (ambiguous) — v0 web never
   * needs to distinguish the two since every internal link already uses a
   * full id.
   */
  findTicketByRef(ref: string): Promise<Ticket | null>;

  /** A ticket's sessions, oldest-first by `started_at`. */
  listSessionsForTicket(ticketId: TicketId): Promise<Session[]>;

  /**
   * The events that belong on a ticket's updates timeline: events whose
   * `entity` is that ticket directly, plus events whose `entity` is one of
   * that ticket's sessions (session.started/stopped/ended, plan.*, …ā€”
   * see event.ts's EVENT_VERBS doc comments for why those are keyed to the
   * session, not the ticket). Returned oldest-first (event id order, which
   * is chronological per D6); callers reverse if they want newest-first.
   *
   * `knownSessions` (web-every-request-full-rescans): this method needs
   * `ticketId`'s sessions to know which `entity.kind === "session"` events
   * belong to it — pass the caller's own already-fetched sessions (e.g.
   * `handleTicketDetail` already calls {@link listSessionsForTicket} for
   * its own "Sessions" section) to skip re-scanning the sessions directory
   * a second time in the same request. Omit it to have this method fetch
   * them itself, unchanged from before.
   */
  listEventsForTicket(ticketId: TicketId, knownSessions?: readonly Session[]): Promise<Event[]>;

  /**
   * ticket_01KY9S0172V8AYCYV9KWS6RC9P: every event in the db, unfiltered.
   * The one bulk read {@link ../overlays.js!deriveEffectiveTickets} needs to
   * compute EVERY ticket's effective `latest_note`/`last_activity_at`
   * (src/repo/db-index.ts's `deriveEffectiveOverlay`) in a single O(tickets
   * + events) pass — the same grouping strategy `buildIndex` uses — rather
   * than a separate {@link listEventsForTicket} call (itself already a full
   * directory scan, per that method's implementation) per ticket, which
   * would turn an N-ticket list/tree/stale view into an O(tickets × events)
   * read. Any view that needs `slop show`-consistent effective ticket
   * fields across more than one ticket at a time should call this once,
   * not loop {@link listEventsForTicket}. Order is unspecified — callers
   * that need chronological order sort themselves (this is a bulk read for
   * grouping-by-ticket, not a timeline).
   */
  listEvents(): Promise<Event[]>;
}
