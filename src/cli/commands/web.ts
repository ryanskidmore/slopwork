import type { Command } from "commander";
import { EXIT_CODES, resolveFakeClock } from "../../core/index.js";
import { repoPaths, requireRepoRoot } from "../../repo/index.js";
import { openStorage } from "../../storage/index.js";
import { PortInUseError, StorageDataSource, startWebServer } from "../../web/index.js";
import { SlopError } from "../errors.js";
import { parseIntegerOption } from "./shared.js";

/**
 * `slop web`'s staleness derivation (src/web/overlays.ts) is a function of
 * wall-clock "now", which is exactly right for real usage and exactly
 * wrong for a deterministic test against a fixture db with fixed
 * timestamps (tests/fixtures/web-db-meta.ts explains why).
 * `core/clock.ts`'s {@link resolveFakeClock} — the one shared
 * `SLOP_FAKE_NOW` clock seam every clock-injecting command honors (G5,
 * t-uy8vo; this file's override used to be its own separately-named
 * `SLOP_WEB_FAKE_NOW`) — pins the server's clock instead of the real one
 * when set to a parseable date; absent in every real invocation, so real
 * usage always gets the system clock.
 */

/**
 * `--port <n>` — bound-checked to the valid TCP port range, 0-65535 (0
 * keeps its documented "pick a free port" meaning, see startWebServer /
 * PortInUseError below). An out-of-range value (`--port 99999`, `--port
 * -1`) is a usage mistake, not a runtime failure, so it's rejected the
 * same `SlopError(..., EXIT_CODES.USAGE_ERROR)` way `parseIntegerOption`
 * already rejects a non-integer `--port` value.
 */
function parsePort(value: string): number {
  const parsed = parseIntegerOption("--port")(value);
  if (parsed < 0 || parsed > 65535) {
    throw new SlopError(
      `--port must be between 0 and 65535, got "${value}"`,
      EXIT_CODES.USAGE_ERROR,
    );
  }
  return parsed;
}

/** `slop web` — design.md §4.4; work item D5. */
export function registerWebCommand(program: Command): void {
  program
    .command("web")
    .description(
      "Serve the read-only local web explorer: ticket list/filters, tree view, " +
        "ticket detail, review panel, questions panel, stale panel.",
    )
    .option("--port <n>", "port to listen on (0 = pick a free port)", parsePort, 4553)
    .action(async (opts: { port: number }) => {
      // Shared repo-root discovery (src/repo/paths.ts) — the same walk-up
      // every other command uses, and the same exit code: NOT_FOUND (4).
      // `slop web` used to run its own local copy of this walk and throw
      // a bare SlopError (defaulting to GENERIC_ERROR, exit 1) instead —
      // exit-code-4-is-overloaded unified the two so "not a slopwork repo"
      // means the same thing (message + exit code) everywhere.
      const root = requireRepoRoot(process.cwd());
      const paths = repoPaths(root);
      const slopRoot = paths.slopDir;

      // G2: the data source goes through StorageBackend now — config's
      // `backend:` key (docs/configuration.md) selects flatfile (default,
      // the flatfile driver's own in-process read cache resolves
      // ticket_01KYAVM4GJVG34MC95VDNT7JVQ) or remote, same as every other
      // command. See src/web/storage-data-source.ts's doc comment.
      const backend = await openStorage(paths);
      const dataSource = new StorageDataSource(backend, slopRoot);

      let server: ReturnType<typeof startWebServer>;
      try {
        server = startWebServer(dataSource, { port: opts.port, clock: resolveFakeClock() });
      } catch (err) {
        if (err instanceof PortInUseError) {
          throw new SlopError(
            `port ${err.port} is already in use — pass a different --port, or --port 0 to pick a free one.`,
          );
        }
        throw err;
      }

      process.stdout.write(`slop web serving ${slopRoot}\n`);
      process.stdout.write(`  ${server.url}\n`);

      const shutdown = () => {
        void server.stop(true).finally(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
}
