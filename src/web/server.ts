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
// Static assets, embedded into the compiled binary at build time (`bun build --compile`
// bundles every statically-imported file reachable from the entrypoint — verified directly,
// see this work item's report). Nothing here is fetched from a CDN or read from disk at
// runtime, so `slop web` works fully offline from `dist/slop`.
import appJs from "./assets/app.js" with { type: "text" };
import styleCss from "./assets/style.css" with { type: "text" };
import type { WebDataSource } from "./data-source.js";
import { handleReviewPanel } from "./views/review.js";
import { handleStalePanel } from "./views/stale.js";
import { handleTicketDetail } from "./views/ticket-detail.js";
import { handleTicketList } from "./views/tickets.js";
import { handleTranscriptView } from "./views/transcript-view.js";
import { handleTreeView } from "./views/tree.js";

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * DNS-rebinding guard (web-add-host-header-allowlist): {@link createWebServer}
 * binds `127.0.0.1` only, but binding to loopback alone does not stop a
 * malicious external page from DNS-rebinding a hostname it controls to
 * `127.0.0.1` and having the victim's own browser issue same-origin-looking
 * requests straight at this server — nothing here previously checked the
 * `Host` header a request actually arrived with, so a DNS-rebound request
 * was served identically to a real `http://127.0.0.1:<port>/` one. `.slop/db`
 * and its transcripts routinely contain secrets (an API key pasted into a
 * ticket, a token in a transcript), so this is a real scrape-the-local-repo
 * vector, not just a theoretical one.
 *
 * Bun's declarative `routes` table dispatches a matched GET request
 * straight to its own handler, bypassing the top-level `fetch` fallback
 * entirely (see this file's header comment) — so the check wraps every
 * route's handler individually via {@link guardHost}, and `fetch` re-checks
 * it too for defense in depth on genuinely unmatched paths/methods.
 */
const ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** `Host` header -> bare hostname, IPv6-literal-aware (`"[::1]:4553"` -> `"::1"`). `null`/empty is never allowed. */
function hostnameFromHeader(hostHeader: string | null): string | null {
  if (!hostHeader) return null;
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? null : hostHeader.slice(1, end);
  }
  // IPv4/hostname[:port] — safe to split on the first colon since neither
  // form contains one itself (unlike the IPv6-literal case handled above).
  return hostHeader.split(":")[0] ?? null;
}

function isAllowedHost(hostHeader: string | null): boolean {
  const hostname = hostnameFromHeader(hostHeader);
  return hostname !== null && ALLOWED_HOSTNAMES.has(hostname);
}

function forbiddenHostResponse(): Response {
  return new Response("Forbidden: untrusted Host header\n", { status: 403 });
}

/** Wraps a route handler so a request with a foreign/missing `Host` header never reaches it. */
function guardHost<Req extends Request>(
  handler: (req: Req) => Response | Promise<Response>,
): (req: Req) => Response | Promise<Response> {
  return (req) => (isAllowedHost(req.headers.get("host")) ? handler(req) : forbiddenHostResponse());
}

/**
 * web-head-returns-404-despite: Bun's declarative `routes` table does NOT
 * fall a `HEAD` request back onto a route's `GET` handler the way the
 * underlying HTTP spec (and this file's own `fetch` fallback's `Allow:
 * GET, HEAD`) implies — verified directly against Bun 1.3.11: a route
 * with only a `GET:` entry 404s on `HEAD`, it never reaches the `fetch`
 * fallback's "known route, wrong method" 405 branch either. A health
 * check (or curl -I, or anything else that HEADs before GETting) reading
 * that 404 has every reason to conclude the UI is dead. Every read route
 * registers the identical guarded handler under both keys so `HEAD`
 * genuinely works, not just gets dropped from the advertised Allow list.
 */
function readMethods<Req extends Request>(
  handler: (req: Req) => Response | Promise<Response>,
): {
  GET: (req: Req) => Response | Promise<Response>;
  HEAD: (req: Req) => Response | Promise<Response>;
} {
  const guarded = guardHost(handler);
  return { GET: guarded, HEAD: guarded };
}

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
    // web-second-slop-web-on: Bun's own `reusePort` docs say it defaults to
    // `false` (SO_REUSEPORT off), but on Linux a second `slop web` on an
    // already-occupied port was observed binding "successfully" anyway,
    // with requests round-robining between the two instances instead of
    // the second one hitting the EADDRINUSE handler below — reproduced
    // directly against Bun 1.3.11. Passing `reusePort: false` explicitly
    // (rather than relying on whatever Bun's actual default resolves to)
    // is the documented way to force exclusive binding, and does restore
    // the expected EADDRINUSE-throws-synchronously behavior `startWebServer`
    // below depends on.
    reusePort: false,
    // Bun.serve's `development` option controls whether an unhandled
    // exception renders as its verbose dev error page (full stack trace +
    // the server's absolute filesystem path, embedded straight into the
    // HTTP response) or a terse, generic error body. Left unset, it
    // defaults to reading `process.env.NODE_ENV` at Bun's own native
    // startup — but this is a read-only local viewer over a project's
    // `.slop/` directory, and a bug in any route should never hand back
    // the server's own source layout as a side effect. Passing the option
    // explicitly here means the behavior is controlled by THIS process's
    // own arguments, not by whatever NODE_ENV happened to be set in the
    // shell that launched `slop web` — false (terse errors) by default,
    // with `SLOP_WEB_DEBUG=1` as an explicit, undocumented opt-in escape
    // hatch back to the verbose page for local debugging.
    development: Boolean(process.env.SLOP_WEB_DEBUG),
    routes: {
      "/": {
        ...readMethods(
          () => new Response(null, { status: 302, headers: { location: "/tickets" } }),
        ),
      },
      "/assets/style.css": {
        ...readMethods(
          () => new Response(styleCss, { headers: { "content-type": "text/css; charset=utf-8" } }),
        ),
      },
      "/assets/app.js": {
        ...readMethods(
          () =>
            new Response(appJs, { headers: { "content-type": "text/javascript; charset=utf-8" } }),
        ),
      },
      "/tickets": {
        ...readMethods((req) => handleTicketList(req, dataSource, now())),
      },
      "/tree": {
        ...readMethods((req) => handleTreeView(req, dataSource, now())),
      },
      "/review": {
        ...readMethods((req) => handleReviewPanel(req, dataSource, now())),
      },
      "/stale": {
        ...readMethods((req) => handleStalePanel(req, dataSource, now())),
      },
      "/tickets/:ref": {
        ...readMethods((req) => handleTicketDetail(req, dataSource, now())),
      },
      "/tickets/:ref/sessions/:sessionId/transcript": {
        ...readMethods((req) => handleTranscriptView(req, dataSource)),
      },
    },
    fetch(req) {
      // Defense in depth for genuinely unmatched paths/methods — every
      // matched route above is already wrapped in guardHost individually.
      if (!isAllowedHost(req.headers.get("host"))) return forbiddenHostResponse();
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
