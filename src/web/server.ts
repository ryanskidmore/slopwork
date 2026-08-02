/**
 * Wires the `slop web` React SPA + its read-only JSON API onto Bun's native
 * router (rewrite-slop-web-as-a — replaces the old server-rendered-HTML
 * views with a bundled SPA fetching from `/api/*`). Read-only by
 * construction (design.md §4.6): every route below only ever registers a
 * `GET` handler — there is no other verb registered anywhere, on any
 * route, so nothing here can ever mutate. The `fetch` fallback (which Bun
 * calls both for genuinely unmatched paths *and* for a defined route hit
 * with a method it didn't register) turns that structural fact into an
 * explicit, testable 405 for every POST/PUT/DELETE/PATCH request, to any
 * path, known or not — and doubles as the SPA's client-side-routing
 * fallback: any unmatched GET/HEAD outside `/api/`/`/assets/` gets the
 * same app shell, so a deep link (`/tickets/abc123`) or a hard refresh on
 * a client-routed page works exactly like `/` does.
 */
import { type Clock, systemClock } from "../core/index.js";
// The compiled SPA bundle, embedded into the compiled binary at build time
// (`bun build --compile` bundles every statically-imported file reachable
// from the entrypoint — verified directly, see docs/web-ui.md). Nothing
// here is fetched from a CDN or read from disk at runtime, so `slop web`
// works fully offline from `dist/slop`. `scripts/build-frontend.ts`
// (`bun run build:web`) produces these two files from `src/web/frontend/`
// before this module is ever imported — see that script's doc comment and
// package.json's `pretest`/`prebuild` wiring.
import appCss from "./generated/app.css" with { type: "text" };
import appJs from "./generated/app.js" with { type: "text" };
import { handleConfig } from "./api/config.js";
import { handleQuestionsPanel } from "./api/questions.js";
import { handleReviewPanel } from "./api/review.js";
import { handleStalePanel } from "./api/stale.js";
import { handleTicketDetail } from "./api/ticket-detail.js";
import { handleTicketList } from "./api/tickets.js";
import { handleTreeView } from "./api/tree.js";
import type { WebDataSource } from "./data-source.js";

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * DNS-rebinding guard (web-add-host-header-allowlist): {@link createWebServer}
 * binds `127.0.0.1` only, but binding to loopback alone does not stop a
 * malicious external page from DNS-rebinding a hostname it controls to
 * `127.0.0.1` and having the victim's own browser issue same-origin-looking
 * requests straight at this server — nothing here previously checked the
 * `Host` header a request actually arrived with, so a DNS-rebound request
 * was served identically to a real `http://127.0.0.1:<port>/` one. `.slop/db`
 * routinely contains secrets (an API key pasted into a
 * ticket), so this is a real scrape-the-local-repo
 * vector, not just a theoretical one.
 *
 * Bun's declarative `routes` table dispatches a matched GET request
 * straight to its own handler, bypassing the top-level `fetch` fallback
 * entirely (see this file's header comment) — so the check wraps every
 * route's handler individually via {@link guardHost}, and `fetch` re-checks
 * it too for defense in depth on genuinely unmatched paths/methods (and for
 * the SPA-shell fallback, which lives entirely in `fetch`).
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
 * genuinely works, not just gets dropped from the advertised Allow list —
 * Bun strips the response body for a HEAD request automatically at the
 * protocol layer, so reusing the GET handler verbatim is correct, not
 * just convenient.
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

/** A tiny, inline SVG favicon (audit-spine motif: a diamond agent-marker and
 * a circle human-marker on a thread) — self-contained data URI, zero extra
 * requests, so even the favicon honors constraint 1's "no CDN, nothing
 * fetched at runtime" posture. Its own attributes use SINGLE quotes
 * deliberately: this whole string is embedded inside a DOUBLE-quoted
 * `href="data:image/svg+xml,...">` attribute in {@link shellHtml} below, so
 * a literal `"` here would prematurely close that attribute and corrupt the
 * page's `<head>`. */
const FAVICON_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
  "<line x1='16' y1='4' x2='16' y2='28' stroke='%2359a3a5' stroke-width='2.5'/>" +
  "<circle cx='16' cy='9' r='4.5' fill='%233d6fd1'/>" +
  "<rect x='11.5' y='18.5' width='9' height='9' rx='1.5' fill='%23c98a34' transform='rotate(45 16 23)'/>" +
  "</svg>";

function shellHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>slop web</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${FAVICON_SVG}">
<link rel="stylesheet" href="/assets/app.css">
<script>
  // Applied before first paint to avoid a flash of the wrong theme — reads
  // the same localStorage key src/web/frontend/hooks/use-theme.ts writes.
  // Deliberately inline (not a separate request): this is the one script
  // that must run before /assets/app.css/app.js even finish loading.
  (function () {
    try {
      var stored = localStorage.getItem("slop-web-theme");
      if (stored === "light" || stored === "dark") {
        document.documentElement.dataset.theme = stored;
      }
    } catch (_e) {
      /* localStorage unavailable (privacy mode, etc.) — falls back to prefers-color-scheme */
    }
  })();
</script>
</head>
<body>
<div id="root"></div>
<script type="module" src="/assets/app.js"></script>
</body>
</html>`;
}

function shellResponse(): Response {
  return new Response(shellHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
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
      "/assets/app.css": {
        ...readMethods(
          () => new Response(appCss, { headers: { "content-type": "text/css; charset=utf-8" } }),
        ),
      },
      "/assets/app.js": {
        ...readMethods(
          () =>
            new Response(appJs, {
              headers: { "content-type": "text/javascript; charset=utf-8" },
            }),
        ),
      },
      "/api/config": {
        ...readMethods((req) => handleConfig(req, dataSource)),
      },
      "/api/tickets": {
        ...readMethods((req) => handleTicketList(req, dataSource, now())),
      },
      "/api/tree": {
        ...readMethods((req) => handleTreeView(req, dataSource, now())),
      },
      "/api/review": {
        ...readMethods((req) => handleReviewPanel(req, dataSource, now())),
      },
      "/api/stale": {
        ...readMethods((req) => handleStalePanel(req, dataSource, now())),
      },
      "/api/questions": {
        ...readMethods((req) => handleQuestionsPanel(req, dataSource)),
      },
      "/api/tickets/:ref": {
        ...readMethods((req) => handleTicketDetail(req, dataSource, now())),
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
      const { pathname } = new URL(req.url);
      if (pathname.startsWith("/api/")) {
        return Response.json({ error: "Not Found" }, { status: 404 });
      }
      if (pathname.startsWith("/assets/")) {
        return new Response("Not Found\n", { status: 404 });
      }
      // Anything else is a client-routed SPA path (`/`, `/tickets`,
      // `/tickets/<id>`, a deep link, a hard refresh, or a path the SPA
      // router itself will render as a 404) — same shell either way; React
      // Router (client-side) decides what to actually show.
      return shellResponse();
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
