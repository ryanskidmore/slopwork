/**
 * Flatfile repo layer.
 *
 * Landing here in later work items:
 *  - A3: atomic writes (tmp+rename), `.slop/db/.lock` for multi-file
 *    transactions, entity CRUD, ref resolution (full id / short prefix /
 *    slug), index build + auto-heal, `reindex`.
 *  - A4: event writer (emit-on-mutation hook, ULID cursor ordering).
 *
 * A1 only establishes the module — nothing here yet.
 */
export {};
