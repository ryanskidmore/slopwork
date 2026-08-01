import type { Command } from "commander";
import { type Clock, EXIT_CODES, fixedClock } from "../../core/index.js";
import { repoPaths, requireRepoRoot } from "../../repo/index.js";
import { FixtureDataSource, PortInUseError, startWebServer } from "../../web/index.js";
import { SlopError } from "../errors.js";
import { parseIntegerOption } from "./shared.js";

/**
 * Testing-only clock override. `slop web`'s staleness derivation
 * (src/web/overlays.ts) is a function of wall-clock "now", which is
 * exactly right for real usage and exactly wrong for a deterministic test
 * against a fixture db with fixed timestamps (tests/fixtures/web-db-meta.ts
 * explains why). `SLOP_WEB_FAKE_NOW`, if set to a parseable date, pins the
 * server's clock instead of using the real one — read only here, never
 * documented as a user-facing flag, and absent in every real invocation.
 */
function resolveClock(): Clock | undefined {
  const raw = process.env.SLOP_WEB_FAKE_NOW;
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return fixedClock(parsed);
}

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
        "ticket detail, review panel, stale panel.",
    )
    .option("--port <n>", "port to listen on (0 = pick a free port)", parsePort, 4553)
    .action((opts: { port: number }) => {
      // Shared repo-root discovery (src/repo/paths.ts) — the same walk-up
      // every other command uses, and the same exit code: NOT_FOUND (4).
      // `slop web` used to run its own local copy of this walk and throw
      // a bare SlopError (defaulting to GENERIC_ERROR, exit 1) instead —
      // exit-code-4-is-overloaded unified the two so "not a slopwork repo"
      // means the same thing (message + exit code) everywhere.
      const root = requireRepoRoot(process.cwd());
      const slopRoot = repoPaths(root).slopDir;

      // src/web/'s data-source seam doesn't need the real repo layer's
      // locking/atomic-write machinery for a read-only viewer (see
      // src/web/fixture-data-source.ts's doc comment) — the same
      // FixtureDataSource class this work item builds against a committed
      // fixture db is pointed here at whatever `.slop` directory was
      // discovered, which is what makes `slop web` usable today rather
      // than only against fixtures.
      const dataSource = new FixtureDataSource(slopRoot);

      let server: ReturnType<typeof startWebServer>;
      try {
        server = startWebServer(dataSource, { port: opts.port, clock: resolveClock() });
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
