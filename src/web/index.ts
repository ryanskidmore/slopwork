/**
 * Read-only local web explorer (`slop web`, design.md §4.4; rewritten as a
 * React + Tailwind + shadcn/ui SPA by rewrite-slop-web-as-a): ticket
 * list/filters, tree view (external parents as badges), ticket detail
 * (spec/timeline/sessions/plans — the "audit spine"),
 * review panel, stale/resumable panel. Read-only for v0 — mutations arrive
 * with F9 (design.md §4.6).
 *
 * The SPA (src/web/frontend/) talks to a read-only JSON API (src/web/api/)
 * built on the same data-source seam as before; server.ts serves both the
 * compiled SPA bundle and the API from one `Bun.serve` instance.
 *
 * `src/cli/commands/web.ts` is the only consumer of this module from the
 * CLI side; it discovers the `.slop` directory to serve, opens a
 * {@link StorageBackend} for it (G2), and drives {@link startWebServer}
 * with a {@link StorageDataSource}. See src/web/data-source.ts's doc
 * comment for the data-source seam this is built on.
 */
export type { WebDataSource } from "./data-source.js";
export { FixtureDataSource } from "./fixture-data-source.js";
export { StorageDataSource } from "./storage-data-source.js";
export {
  createWebServer,
  PortInUseError,
  startWebServer,
  type WebServerOptions,
} from "./server.js";
