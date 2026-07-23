/**
 * Flatfile repo layer.
 *
 * A3 lands here: atomic writes (tmp+rename), `.slop/db/.lock` for
 * multi-file transactions, entity CRUD, ref resolution (full id / short
 * prefix / slug), index build + auto-heal, `reindex`.
 *
 * A4 (event writer) lands the emit-on-mutation hook (`events.ts`'s
 * `EventContext`/`MutationEventSpec`/`withMutationEvent`), which
 * `tickets.ts`'s `createTicket`/`updateTicket` and `sessions.ts`'s
 * `createSession`/`updateSession` are built on — every call through those
 * four functions requires an actor/session context and a verb, and emits
 * exactly one event. Also lands the ULID cursor query (`events.ts`'s
 * `queryEvents`) that D3's `slop events --since` builds on.
 */
export * from "./atomic-write.js";
export * from "./db-index.js";
export * from "./entity-file.js";
export * from "./events.js";
export * from "./fs-utils.js";
export * from "./lock.js";
export * from "./paths.js";
export * from "./refs.js";
export * from "./sessions.js";
export * from "./tickets.js";
