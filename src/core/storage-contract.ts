/**
 * Storage port and shared read/write DTOs.
 *
 * Domain services depend on this interface; flatfile and remote drivers
 * implement it. The contract therefore lives in core, above every adapter.
 */
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { DbIndex, EventReadProblem, LoadIndexResult, TicketReadProblem } from "./db-index.js";
import { EXIT_CODES } from "./exit-codes.js";
import { SlopError } from "./errors.js";
import type { Actor } from "./entities/actor.js";
import type { Event, EventEntity, EventVerb } from "./entities/event.js";
import type { Session } from "./entities/session.js";
import type { Ticket } from "./entities/ticket.js";
import { eventIdSchema } from "./ids.js";
import type { EventId, SessionId, TicketId } from "./ids.js";
import type { JsoncPatchEntry } from "./jsonc.js";

export interface EventContext {
  actor: Actor;
  /** The session this mutation happens under, or `null` outside any session. */
  session: SessionId | null;
}

/**
 * Event context for work performed on a ticket. The caller chooses the
 * ticket snapshot deliberately: lock-free event-only commands use the
 * snapshot they resolved before appending, while read-modify-write commands
 * pass the fresh snapshot read inside their transaction. Pure — no I/O, no
 * driver dependency — so CLI composition can build an `EventContext` before
 * a backend is even selected, without crossing into repo-owned data access.
 */
export function ticketEventContext(
  actor: Actor,
  ticket: Pick<Ticket, "active_session">,
): EventContext {
  return { actor, session: ticket.active_session };
}

export interface MutationEventSpec {
  verb: EventVerb;
  payload?: Record<string, unknown>;
}

export interface EventQuery {
  /** Exclusive ULID cursor. */
  since?: EventId;
  /** Limit results to events directly attached to this ticket. */
  ticket?: TicketId;
  /** Applied after filtering while preserving ULID order. */
  limit?: number;
}

export interface SessionReadProblem {
  id: SessionId;
  path: string;
  message: string;
}

export interface ListSessionsTolerantResult {
  sessions: Session[];
  problems: SessionReadProblem[];
}

export interface ListTicketsTolerantResult {
  tickets: Ticket[];
  problems: TicketReadProblem[];
}

export interface ListEventsTolerantResult {
  events: Event[];
  problems: EventReadProblem[];
}

/**
 * Merge-safe event polling cursor (t-r0hnj): an opaque token over a
 * durable, versioned set of event ids already returned to one consumer —
 * replaces a scalar ULID watermark, which can permanently miss an event
 * that merges in later from another clone with an older clock.
 */
export const EVENT_POLL_CURSOR_VERSION = 1 as const;
export const eventPollCursorSchema = z
  .string()
  .regex(/^cursor_v1_[0-9a-f]{32}$/, "expected cursor_v1_<32 lowercase hex characters>")
  .brand<"EventPollCursor">();
export type EventPollCursor = z.infer<typeof eventPollCursorSchema>;

export const eventPollCursorStateSchema = z
  .object({
    version: z.literal(EVENT_POLL_CURSOR_VERSION),
    cursor: eventPollCursorSchema,
    seen: z.array(eventIdSchema),
  })
  .superRefine((state, ctx) => {
    if (new Set(state.seen).size !== state.seen.length) {
      ctx.addIssue({ code: "custom", path: ["seen"], message: "event ids must be unique" });
    }
    for (let i = 1; i < state.seen.length; i++) {
      if ((state.seen[i - 1] ?? "") >= (state.seen[i] ?? "")) {
        ctx.addIssue({ code: "custom", path: ["seen"], message: "event ids must be sorted" });
        break;
      }
    }
  });
export type EventPollCursorState = z.infer<typeof eventPollCursorStateSchema>;

export function parseEventPollCursor(raw: string): EventPollCursor {
  const parsed = eventPollCursorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SlopError(
      `invalid event polling cursor "${raw}"; expected cursor_v1_<32 lowercase hex characters>`,
      EXIT_CODES.USAGE_ERROR,
    );
  }
  return parsed.data;
}

/** Opaque compile-time marker proving a callback runs inside a transaction. */
export interface StorageTxScope {
  readonly kind: "storage-transaction";
}

export interface EventShardMigrationResult {
  moved: number;
  shards: string[];
}

/**
 * `compactTicketEvents`'s result (t-7eq5s) — one ticket's worth of
 * event-archive compaction, whether triggered by `done`/`drop`'s own
 * terminal transition or `slop reindex --compact`'s retroactive sweep.
 */
export interface EventCompactionResult {
  ticket: TicketId;
  /** Loose events newly folded into the archive by THIS call — `0` when
   * there was nothing left to compact. */
  archived: number;
  /** The archive's total event count after this call. */
  archiveTotal: number;
  /** `events/YYYY-MM` shard directories removed because they were left
   * with zero remaining loose files — a flatfile-only concept; a remote
   * backend has nothing analogous to report here and should return `[]`. */
  shardsRemoved: string[];
}

export interface StorageBackend {
  readonly kind: "flatfile" | "remote";

  readTicket(id: TicketId): Promise<Ticket>;
  listTickets(): Promise<Ticket[]>;
  listTicketsTolerant(): Promise<ListTicketsTolerantResult>;
  createTicket(
    ticket: Ticket,
    ctx: EventContext,
    event: MutationEventSpec,
    clock?: Clock,
  ): Promise<Event>;
  updateTicket(
    id: TicketId,
    patch: JsoncPatchEntry[],
    expectedAfter: Ticket,
    ctx: EventContext,
    event: MutationEventSpec,
    clock?: Clock,
  ): Promise<Event>;

  readSession(id: SessionId): Promise<Session>;
  listSessions(): Promise<Session[]>;
  listSessionsTolerant(): Promise<ListSessionsTolerantResult>;
  createSession(
    session: Session,
    ctx: EventContext,
    event: MutationEventSpec,
    clock?: Clock,
  ): Promise<Event>;
  updateSession(
    id: SessionId,
    patch: JsoncPatchEntry[],
    expectedAfter: Session,
    ctx: EventContext,
    event: MutationEventSpec,
    clock?: Clock,
  ): Promise<Event>;

  readEvent(id: EventId): Promise<Event>;
  appendEvent(
    ctx: EventContext,
    entity: EventEntity,
    spec: MutationEventSpec,
    clock?: Clock,
  ): Promise<Event>;
  queryEvents(query?: EventQuery): Promise<Event[]>;
  /** Every event in the db — full historical fidelity, archived or not
   * (t-7eq5s). Search/elicitations-inbox/web-bulk-overlay reads, and
   * `slop reindex --strict`, want this. */
  listEvents(): Promise<Event[]>;
  /** Every readable event plus structured diagnostics for every skipped
   * file — archive-inclusive, same as {@link listEvents}. */
  listEventsTolerant(): Promise<ListEventsTolerantResult>;
  /**
   * Every event currently sitting LOOSE (flat or sharded) — excludes
   * anything already folded into a per-ticket archive (t-7eq5s). Cheap,
   * and never scales with closed/archived-ticket history: the ONE read the
   * done-cascade's `ticket.ready` dedup check (`src/tickets/cascade.ts`)
   * needs, since its candidates are always currently-open tickets whose
   * events are, by construction, never archived. A remote backend with no
   * loose/archived distinction of its own may simply alias this to
   * {@link listEvents}.
   */
  listLooseEvents(): Promise<Event[]>;
  /** Fold every currently-loose event belonging to `id` into its per
   * -ticket archive and remove the now-redundant loose files (t-7eq5s).
   * Idempotent — safe to call on an already-fully-compacted ticket (a
   * no-op, `archived: 0`) or repeatedly to fold in residual cross-clone
   * events. Callers must only ever invoke this for an already-closed
   * (`done`/`dropped`) ticket. */
  compactTicketEvents(id: TicketId): Promise<EventCompactionResult>;
  /** Create a constant-size opaque handle backed by an empty exact seen-id set. */
  createEventPollCursor(): Promise<EventPollCursor>;
  /** Read and validate the durable state behind an opaque polling cursor. */
  readEventPollCursor(cursor: EventPollCursor): Promise<EventPollCursorState>;
  /** Atomically union only event ids actually returned to the consumer. */
  advanceEventPollCursor(
    cursor: EventPollCursor,
    returned: readonly EventId[],
  ): Promise<EventPollCursorState>;
  /** Delete local/server-side state once a polling consumer is retired. */
  deleteEventPollCursor(cursor: EventPollCursor): Promise<void>;

  resolveTicketRef(ref: string): Promise<Ticket>;
  resolveTicketRefs(refs: string[]): Promise<Ticket[]>;

  loadIndex(clock?: Clock): Promise<LoadIndexResult>;
  rebuildIndex(clock?: Clock): Promise<DbIndex>;

  transact<T>(fn: (tx: StorageTxScope) => Promise<T>): Promise<T>;

  sweepTempFiles(): Promise<string[]>;
  migrateEventShards(): Promise<EventShardMigrationResult>;

  localTicketFilePath?(id: TicketId): string;
  localSessionFilePath?(id: SessionId): string;
}
