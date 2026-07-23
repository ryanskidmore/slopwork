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
 *  - A later work item's real-repo-layer adapter. See the class doc on
 *    FixtureDataSource for exactly what that adapter should and should not
 *    reuse from the repo layer.
 */
import type { Config, Event, Session, SessionId, Ticket, TicketId } from "../core/index.js";

/**
 * A readable handle on one transcript file, opened but not yet parsed.
 * Kept as a *streaming* seam — {@link lines} yields raw JSONL lines lazily
 * — so a multi-megabyte transcript never has to be pulled fully into
 * memory just to render one page of it (see src/web/transcript.ts, which
 * is the only consumer and stops iterating as soon as it has enough
 * records for the requested page).
 */
export interface TranscriptHandle {
  /** Where this transcript came from, for display/debugging only — never parsed. */
  readonly ref: string;
  /** Raw lines, in file order, not yet JSON-parsed. Never throws; a line that fails to decode should still be yielded so the caller can decide whether to skip it. */
  lines(): AsyncIterable<string>;
}

/**
 * The read operations every §4.4 view needs. Nothing here writes, matching
 * design.md §4.6: "web mutations are explicitly out of scope" for v0.
 */
export interface WebDataSource {
  /** `.slop/config.yaml`, validated against configSchema. */
  getConfig(): Promise<Config>;

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

  /** A single session by its full id, or `null`. */
  getSessionById(id: SessionId): Promise<Session | null>;

  /**
   * The events that belong on a ticket's updates timeline: events whose
   * `entity` is that ticket directly, plus events whose `entity` is one of
   * that ticket's sessions (session.started/stopped/ended, plan.*, …ā€”
   * see event.ts's EVENT_VERBS doc comments for why those are keyed to the
   * session, not the ticket). Returned oldest-first (event id order, which
   * is chronological per D6); callers reverse if they want newest-first.
   */
  listEventsForTicket(ticketId: TicketId): Promise<Event[]>;

  /**
   * Open a transcript by a session's `transcript_ref`. `null` if the ref
   * doesn't resolve to a readable file (matches D16/S2: a missing
   * transcript is an expected, non-fatal case everywhere else in this
   * project, and the viewer must degrade the same way).
   */
  openTranscript(transcriptRef: string): Promise<TranscriptHandle | null>;
}
