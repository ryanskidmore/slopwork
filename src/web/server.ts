/**
 * Wires the six §4.4 views onto Bun's native router. Read-only by
 * construction (design.md §4.6): every route below only ever registers a
 * `GET` handler — there is no other verb registered anywhere, on any
 * route, so nothing here can ever mutate. The `fetch` fallback (which Bun
 * calls both for genuinely unmatched paths *and* for a defined route hit
 * with a method it didn't register — verified against Bun 1.3.11) turns
 * that structural fact into an explicit, testable 405 for every
 * POST/PUT/DELETE/PATCH request, to any path, known or not.
 */
import { type Clock, systemClock } from "../core/index.js";
import type { WebDataSource } from "./data-source.js";
import { handleReviewPanel } from "./views/review.js";
import { handleStalePanel } from "./views/stale.js";
import { handleTicketDetail } from "./views/ticket-detail.js";
import { handleTicketList } from "./views/tickets.js";
import { handleTranscriptView } from "./views/transcript-view.js";
import { handleTreeView } from "./views/tree.js";
// Static assets, embedded into the compiled binary at build time (`bun build --compile`
// bundles every statically-imported file reachable from the entrypoint — verified directly,
// see this work item's report). Nothing here is fetched from a CDN or read from disk at
// runtime, so `slop web` works fully offline from `dist/slop`.
import appJs from "./assets/app.js" with { type: "text" };
import styleCss from "./assets/style.css" with { type: "text" };

const READ_METHODS = new Set(["GET", "HEAD"]);

export interface WebServerOptions {
  port: number;
  /** @default "127.0.0.1" — see createWebServer's doc: this must never be reachable off-machine. */
  hostname?: string;
  /**
   * @default systemClock — the real clock, used by the actual `slop web`
   * CLI command. Tests pin this to a fixed instant (src/core/clock.ts's
   * `fixedClock`, same seam C5 uses) so `blocked`/`stale` derivation
   * (src/web/overlays.ts) against the committed fixture db is
   * deterministic regardless of when the test suite actually runs — see
   * tests/fixtures/web-db-meta.ts.
   */
  clock?: Clock;
}

/**
 * Start the `slop web` HTTP server. Binds to localhost only by default —
 * this serves an unauthenticated read-only view of a private repo's
 * contents (design.md D5 architecture requirement) and must not be
 * reachable from the network.
 */
export function createWebServer(
  dataSource: WebDataSource,
  options: WebServerOptions,
): ReturnType<typeof Bun.serve> {
  const clock = options.clock ?? systemClock;
  const now = () => clock.now().getTime();
  return Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    routes: {
      "/": {
        GET: () => new Response(null, { status: 302, headers: { location: "/tickets" } }),
      },
      "/assets/style.css": {
        GET: () => new Response(styleCss, { headers: { "content-type": "text/css; charset=utf-8" } }),
      },
      "/assets/app.js": {
        GET: () =>
          new Response(appJs, { headers: { "content-type": "text/javascript; charset=utf-8" } }),
      },
      "/tickets": {
        GET: (req) => handleTicketList(req, dataSource, now()),
      },
      "/tree": {
        GET: (req) => handleTreeView(req, dataSource),
      },
      "/review": {
        GET: (req) => handleReviewPanel(req, dataSource, now()),
      },
      "/stale": {
        GET: (req) => handleStalePanel(req, dataSource, now()),
      },
      "/tickets/:ref": {
        GET: (req) => handleTicketDetail(req, dataSource, now()),
      },
      "/tickets/:ref/sessions/:sessionId/transcript": {
        GET: (req) => handleTranscriptView(req, dataSource),
      },
    },
    fetch(req) {
      if (!READ_METHODS.has(req.method)) {
        return new Response("Method Not Allowed\n", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      return new Response("Not Found\n", { status: 404 });
    },
  });
}

/** Thrown by {@link startWebServer} when the requested port is already bound, so the CLI can print a clear message instead of a raw stack trace. */
export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`port ${port} is already in use`);
    this.name = "PortInUseError";
  }
}

function isAddrInUseError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "EADDRINUSE"
  );
}

/** {@link createWebServer}, but turning Bun's synchronous EADDRINUSE throw into a typed, catchable error. */
export function startWebServer(
  dataSource: WebDataSource,
  options: WebServerOptions,
): ReturnType<typeof Bun.serve> {
  try {
    return createWebServer(dataSource, options);
  } catch (err) {
    if (isAddrInUseError(err)) {
      throw new PortInUseError(options.port);
    }
    throw err;
  }
}
