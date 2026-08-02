/**
 * The remote storage driver (G2, t-an2d7) — a stub. Selected the same way
 * {@link ../storage/flatfile.js!FlatfileBackend} is (`.slop/config.yaml`'s
 * `backend:` key, docs/configuration.md), when `backend.kind === "remote"`.
 *
 * There is no real remote implementation yet — that's future work, once an
 * actual server (e.g. a Cloudflare worker) exists to talk to. Every method
 * on this class fails immediately with one clear, consistent error
 * (never a crash, never a hang, never a partial/ambiguous result) naming
 * docs/storage-backends.md, which specifies the exact JSON-over-HTTP wire
 * contract a real implementation must speak — mapped 1:1 to
 * {@link StorageBackend}, so building a real driver later is "implement
 * this class's methods against that doc," not "redesign the interface."
 *
 * Configuring `backend: {kind: remote, url: ...}` today is intentionally
 * still useful even though nothing works yet: it lets `.slop/config.yaml`
 * be written and committed in advance (documenting the URL, exercising
 * config validation, keeping the repo layer's abstraction boundary
 * honest) without anything silently falling back to the flatfile db —
 * every call surfaces the same unambiguous "not implemented" error rather
 * than a confusing partial success against the wrong store.
 */
import { EXIT_CODES } from "../core/exit-codes.js";
import { SlopError } from "../core/errors.js";
import type { DbIndex, LoadIndexResult } from "../core/db-index.js";
import type {
  EventShardMigrationResult,
  StorageBackend,
  StorageTxScope,
} from "../core/storage-contract.js";

/** {@link RemoteBackend}'s constructor input — the normalized `{kind:
 * "remote", url?}` half of `BackendSelection` (core/entities/config.ts). */
export interface RemoteBackendOptions {
  /** `backend.url` from config.yaml, if given — surfaced in every error
   * message so "not implemented" also tells you which endpoint it would
   * have called. Absent when config.yaml wrote bare `backend: remote`. */
  url?: string;
}

/**
 * One error, one shape, everywhere: `GENERIC_ERROR` (exit 1) — never a
 * crash, never a code path that hangs or half-completes. Naming `method`
 * so the error is specific about which capability was attempted (helpful
 * when a command fails several storage calls deep), and the configured
 * `url` (or "no url configured" when `backend: remote` was written bare)
 * so a user immediately sees what config.yaml actually says.
 */
function notImplemented(method: string, url: string | undefined): never {
  const target = url !== undefined ? `configured remote at ${url}` : "no url configured";
  throw new SlopError(
    `remote backend not implemented — see docs/storage-backends.md ` +
      `(attempted "${method}" against the ${target})`,
    EXIT_CODES.GENERIC_ERROR,
  );
}

export class RemoteBackend implements StorageBackend {
  readonly kind = "remote" as const;
  private readonly url: string | undefined;

  constructor(options: RemoteBackendOptions = {}) {
    this.url = options.url;
  }

  private fail(method: string): never {
    return notImplemented(method, this.url);
  }

  // --- tickets ---------------------------------------------------------

  readTicket(): Promise<never> {
    return this.fail("readTicket");
  }
  listTickets(): Promise<never> {
    return this.fail("listTickets");
  }
  listTicketsTolerant(): Promise<never> {
    return this.fail("listTicketsTolerant");
  }
  createTicket(): Promise<never> {
    return this.fail("createTicket");
  }
  updateTicket(): Promise<never> {
    return this.fail("updateTicket");
  }

  // --- sessions --------------------------------------------------------

  readSession(): Promise<never> {
    return this.fail("readSession");
  }
  listSessions(): Promise<never> {
    return this.fail("listSessions");
  }
  listSessionsTolerant(): Promise<never> {
    return this.fail("listSessionsTolerant");
  }
  createSession(): Promise<never> {
    return this.fail("createSession");
  }
  updateSession(): Promise<never> {
    return this.fail("updateSession");
  }

  // --- events ------------------------------------------------------------

  readEvent(): Promise<never> {
    return this.fail("readEvent");
  }
  appendEvent(): Promise<never> {
    return this.fail("appendEvent");
  }
  queryEvents(): Promise<never> {
    return this.fail("queryEvents");
  }
  listEvents(): Promise<never> {
    return this.fail("listEvents");
  }
  listEventsTolerant(): Promise<never> {
    return this.fail("listEventsTolerant");
  }
  listLooseEvents(): Promise<never> {
    return this.fail("listLooseEvents");
  }
  compactTicketEvents(): Promise<never> {
    return this.fail("compactTicketEvents");
  }
  createEventPollCursor(): Promise<never> {
    return this.fail("createEventPollCursor");
  }
  readEventPollCursor(): Promise<never> {
    return this.fail("readEventPollCursor");
  }
  advanceEventPollCursor(): Promise<never> {
    return this.fail("advanceEventPollCursor");
  }
  deleteEventPollCursor(): Promise<never> {
    return this.fail("deleteEventPollCursor");
  }

  // --- ref resolution ------------------------------------------------------

  resolveTicketRef(): Promise<never> {
    return this.fail("resolveTicketRef");
  }
  resolveTicketRefs(): Promise<never> {
    return this.fail("resolveTicketRefs");
  }

  // --- derived index ---------------------------------------------------

  loadIndex(): Promise<LoadIndexResult> {
    return this.fail("loadIndex");
  }
  rebuildIndex(): Promise<DbIndex> {
    return this.fail("rebuildIndex");
  }

  // --- transactions ------------------------------------------------------

  transact<T>(_fn: (tx: StorageTxScope) => Promise<T>): Promise<T> {
    return this.fail("transact");
  }

  // --- maintenance -------------------------------------------------------

  sweepTempFiles(): Promise<never> {
    return this.fail("sweepTempFiles");
  }
  migrateEventShards(): Promise<EventShardMigrationResult> {
    return this.fail("migrateEventShards");
  }

  // No `localTicketFilePath`/`localSessionFilePath` — a remote backend has
  // no locally-editable file for `slop edit` to open; the interface marks
  // both optional for exactly this case (see StorageBackend's doc comment).
}
