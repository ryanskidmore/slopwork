/**
 * Read-only local web explorer (`slop web`, design.md §4.4, work item D5):
 * ticket list/filters, tree view (external parents as badges), ticket
 * detail (spec/timeline/sessions/plans), transcript viewer, review panel,
 * stale/resumable panel. Read-only for v0 — mutations arrive with F9
 * (design.md §4.6).
 *
 * `src/cli/commands/web.ts` is the only consumer of this module from the
 * CLI side; it discovers the `.slop` directory to serve and drives
 * {@link startWebServer}. See src/web/fixture-data-source.ts's doc comment
 * for the data-source seam this is built on, and this work item's report
 * for what a later "wire the real repo layer" work item should change.
 */
export type { TranscriptHandle, WebDataSource } from "./data-source.js";
export { FixtureDataSource } from "./fixture-data-source.js";
export { PortInUseError, createWebServer, startWebServer, type WebServerOptions } from "./server.js";
