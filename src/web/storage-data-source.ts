/**
 * {@link StorageDataSource}: the real {@link WebDataSource} adapter (G2,
 * t-y2j03) — `src/cli/commands/web.ts` constructs one via
 * `openStorage(paths)` (`src/storage/index.ts`) and points it at whatever
 * `.slop` directory it discovered, replacing `FixtureDataSource` for the
 * real-repo case (that class remains what its name says: a fixture-backed
 * `WebDataSource` for tests, see its own doc comment).
 *
 * Every ticket/session/event read goes through the injected
 * {@link StorageBackend} — never `src/repo/*` directly, matching G2's
 * "the web data source goes through the interface only" mandate. This is
 * what makes `slop web` config-selectable (`backend: {kind: remote, ...}`
 * in `.slop/config.yaml` serves the web UI from the same remote store a
 * mutating CLI command would use — today that just means a clear
 * "not implemented" error surfaces from the affected view instead of a
 * silent flatfile read) and what resolves
 * ticket_01KYAVM4GJVG34MC95VDNT7JVQ (the web server's per-request full
 * directory rescan): the flatfile driver's own in-process read cache
 * (`src/storage/flatfile.ts`'s module doc) now sits underneath every view
 * this class serves, for free — a repeat request against an unchanged db
 * pays one cheap fingerprint check instead of re-reading every
 * ticket/session/event file again.
 *
 * `getConfig()` is the one method that does NOT go through `backend` —
 * see {@link readSlopConfigTolerant}'s own doc for why config.yaml is
 * read directly regardless of which backend is configured.
 */
import type { Session, Ticket, TicketId } from "../core/index.js";
import type { StorageBackend } from "../storage/backend.js";
import type { ConfigResult, WebDataSource } from "./data-source.js";
import { readSlopConfigTolerant } from "./data-source.js";
import { matchTicketByRef } from "./overlays.js";

export class StorageDataSource implements WebDataSource {
  constructor(
    private readonly backend: StorageBackend,
    /** Root of the `.slop` directory (design.md §3) — used ONLY to locate `config.yaml`; every other read goes through `backend`. */
    private readonly slopRoot: string,
  ) {}

  async getConfig(): Promise<ConfigResult> {
    return readSlopConfigTolerant(this.slopRoot);
  }

  async listTickets(): Promise<Ticket[]> {
    const { tickets } = await this.backend.listTicketsTolerant();
    return tickets;
  }

  async findTicketByRef(ref: string): Promise<Ticket | null> {
    // web-every-request-full-rescans: the matching rule itself lives in
    // overlays.ts's matchTicketByRef (also used directly by
    // handleTicketDetail, which already has to fetch the full ticket list
    // anyway) so there's exactly one implementation of "which id does this
    // ref mean", not two independently-drifting ones.
    return matchTicketByRef(await this.listTickets(), ref);
  }

  async listSessionsForTicket(ticketId: TicketId): Promise<Session[]> {
    const { sessions } = await this.backend.listSessionsTolerant();
    return sessions
      .filter((s) => s.ticket === ticketId)
      .sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  async listEventsForTicket(ticketId: TicketId, knownSessions?: readonly Session[]) {
    // web-every-request-full-rescans: a caller that already fetched this
    // ticket's sessions (handleTicketDetail does, for its own "Sessions"
    // section) can pass them in via `knownSessions` to skip re-scanning the
    // sessions directory a second time in the same request.
    const [eventResult, sessions] = await Promise.all([
      this.backend.listEventsTolerant(),
      knownSessions ? Promise.resolve(knownSessions) : this.listSessionsForTicket(ticketId),
    ]);
    const sessionIds = new Set<string>(sessions.map((s) => s.id));
    const relevant = eventResult.events.filter(
      (e) =>
        (e.entity.kind === "ticket" && e.entity.id === ticketId) ||
        (e.entity.kind === "session" && sessionIds.has(e.entity.id)),
    );
    // Event ids are ULIDs (D6): lexicographic order is chronological order.
    return {
      events: relevant.sort((a, b) => a.id.localeCompare(b.id)),
      problems: eventResult.problems,
    };
  }

  async listEvents() {
    return this.backend.listEventsTolerant();
  }
}
