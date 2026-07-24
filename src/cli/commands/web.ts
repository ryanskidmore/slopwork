import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { type Clock, fixedClock } from "../../core/index.js";
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
 * Walk upward from `startDir` looking for a `.slop` directory — the same
 * convention `.git` discovery uses. Returns the `.slop` directory's own
 * path (not its parent), or `null` if none is found before the filesystem
 * root.
 */
function findSlopRoot(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".slop");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `slop web` — design.md §4.4; work item D5. */
export function registerWebCommand(program: Command): void {
  program
    .command("web")
    .description(
      "Serve the read-only local web explorer: ticket list/filters, tree view, " +
        "ticket detail, transcript viewer, review panel, stale panel.",
    )
    .option(
      "--port <n>",
      "port to listen on (0 = pick a free port)",
      parseIntegerOption("--port"),
      4553,
    )
    .action((opts: { port: number }) => {
      const slopRoot = findSlopRoot(process.cwd());
      if (!slopRoot) {
        throw new SlopError(
          "no .slop directory found here or in any parent directory — run `slop init` first.",
        );
      }

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
