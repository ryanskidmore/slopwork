/**
 * Flatfile repo layer.
 *
 * A3 lands here: atomic writes (tmp+rename), `.slop/db/.lock` for
 * multi-file transactions, entity CRUD, ref resolution (full id / short
 * prefix / slug), index build + auto-heal, `reindex`.
 *
 * A4 (event writer: emit-on-mutation hook, ULID cursor ordering) builds
 * on `events.ts`'s `createEvent`/`listEvents` primitives, landing its own
 * higher-level "emit on every mutation" wiring separately.
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
