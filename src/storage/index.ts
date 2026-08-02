/**
 * The storage layer (G2). Commands and the web data source import ONLY
 * from this barrel (or `./backend.js` directly for types) — never from
 * `../repo/*` or a driver module directly. See `backend.ts`'s module doc
 * for the interface design and `open.ts`'s for backend selection.
 */
export * from "./backend.js";
export * from "./open.js";
export { FlatfileBackend } from "./flatfile.js";
export type { FlatfileBackendOptions } from "./flatfile.js";
export { RemoteBackend } from "./remote.js";
export type { RemoteBackendOptions } from "./remote.js";
