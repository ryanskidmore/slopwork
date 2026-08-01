import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Event,
  type Session,
  type Ticket,
  eventSchema,
  parseJsonc,
  sessionSchema,
  ticketSchema,
} from "../../src/core/index.js";
import type {
  ReviewResponseDTO,
  StaleResponseDTO,
  TicketDetailDTO,
  TicketListResponseDTO,
  TreeNodeDTO,
  TreeResponseDTO,
} from "../../src/web/api/types.js";
import { FIXTURE_NOW_ISO } from "../fixtures/web-db-meta.js";

// D5: `slop web`
//
// Acceptance criterion, from v0-implementation-plan.md §3:
//   "All §4.4 views against a seeded fixture db" (the plan's original
//   criterion also covered a session-log viewer, since removed from the
//   product — see tests/acceptance/G1.test.ts).
//
// rewrite-slop-web-as-a replaced the server-rendered HTML this file used to
// assert on with a read-only JSON API (src/web/api/*) consumed by a React
// SPA — every assertion below now drives `/api/*` and inspects parsed JSON
// instead of scraping HTML strings. The "renders readably"/"collapsed by
// default"/etc. DOM presentation concerns are now the SPA's job
// (src/web/frontend/), which these black-box HTTP tests structurally
// cannot exercise (there's no DOM here) — what these tests instead prove is
// that the API hands the SPA everything it needs to render that, correctly
// classified and pre-sanitized (markdown -> HTML, XSS-unsafe URLs
// neutralised) server-side, exactly as before.
//
// This file starts the real server (from source, and separately from the
// compiled binary) against the committed fixture db at
// tests/fixtures/web-db/.slop/ and drives it entirely over HTTP — no
// module in src/web/ is imported directly here. That's a deliberate
// consequence of a fact worth recording for whoever touches this next:
// Bun-only globals (`Bun.serve`, `Bun.file`, `Bun.YAML`, `Bun.markdown`,
// and `with { type: "text" }` asset imports — everything src/web/'s
// server-side code is built on) are **not available inside vitest's test
// workers**, which run as plain Node.js processes even when the vitest
// CLI itself was launched via `bun run test` (verified directly: the
// `Bun` global is `undefined` in a `*.test.ts` file, and
// `process.execPath` inside one resolves to a real `node` binary, not
// `bun`). So every assertion below is a real, black-box HTTP request
// against a real spawned `bun`/`dist/slop` process — arguably a more
// honest acceptance test than an in-process one would have been anyway.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");
const binaryPath = join(repoRoot, "dist", "slop");
const fixtureParentDir = join(repoRoot, "tests", "fixtures", "web-db");
const slopDir = join(fixtureParentDir, ".slop");

// ---------------------------------------------------------------------------
// Process/server plumbing.
// ---------------------------------------------------------------------------

interface RunningServer {
  proc: ChildProcess;
  baseUrl: string;
}

/** Spawn `cmd args…` with `cwd`, wait for it to print its listen URL on stdout, and resolve with that URL. Rejects (with captured output) if the process exits first or nothing shows up in time. */
function spawnAndWaitForUrl(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 15_000,
): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(
        new Error(
          `timed out waiting for "${cmd} ${args.join(" ")}" to print a listen URL.\nstdout: ${stdout}\nstderr: ${stderr}`,
        ),
      );
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /https?:\/\/127\.0\.0\.1:\d+\//.exec(stdout);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, baseUrl: match[0] });
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(`process exited early (code ${code}) before printing a URL.\nstderr: ${stderr}`),
      );
    });
    proc.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function stopServer(server: RunningServer | undefined): Promise<void> {
  if (!server) return;
  if (server.proc.exitCode !== null || server.proc.signalCode !== null) return;
  server.proc.kill();
  await Promise.race([once(server.proc, "exit"), new Promise((r) => setTimeout(r, 3000))]);
}

// ---------------------------------------------------------------------------
// Load + validate the fixture db directly (portable — no Bun-only APIs),
// both to build lookup tables the HTTP assertions below need (ticket ids
// are freshly generated every time the fixture is regenerated, so tests
// must resolve them by slug, never hardcode a ULID) and to satisfy the D5
// architecture requirement: "add a test asserting fixtures validate
// against the A2 schemas, so fixtures can't silently rot as schemas
// evolve."
// ---------------------------------------------------------------------------

function readJsoncEntities<T>(dir: string, schema: { parse: (input: unknown) => T }): T[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonc"));
  return files.map((file) => {
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");
    const { value, errors } = parseJsonc<unknown>(text);
    if (errors.length > 0) {
      throw new Error(`${path}: ${errors.length} JSONC parse error(s)`);
    }
    try {
      return schema.parse(value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${path}: failed schema validation — ${message}`);
    }
  });
}

const fixtureTickets: Ticket[] = readJsoncEntities(join(slopDir, "db", "tickets"), ticketSchema);
const fixtureSessions: Session[] = readJsoncEntities(
  join(slopDir, "db", "sessions"),
  sessionSchema,
);
const fixtureEvents: Event[] = readJsoncEntities(join(slopDir, "db", "events"), eventSchema);

function ticketBySlug(slug: string): Ticket {
  const found = fixtureTickets.find((t) => t.slug === slug);
  if (!found)
    throw new Error(`fixture db has no ticket with slug "${slug}" — did the generator change?`);
  return found;
}
function sessionsForTicket(ticketId: string): Session[] {
  return fixtureSessions.filter((s) => s.ticket === ticketId);
}

// ---------------------------------------------------------------------------
// Shared server, spawned from source with a pinned clock (see
// tests/fixtures/web-db-meta.ts for why "now" must be pinned).
// ---------------------------------------------------------------------------

let server: RunningServer | undefined;

async function get(path: string, init?: RequestInit): Promise<Response> {
  if (!server) throw new Error("server not started");
  return fetch(new URL(path, server.baseUrl), init);
}

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await get(path);
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  server = await spawnAndWaitForUrl("bun", [cliEntry, "web", "--port", "0"], fixtureParentDir, {
    ...process.env,
    SLOP_WEB_FAKE_NOW: FIXTURE_NOW_ISO,
  });
}, 20_000);

afterAll(async () => {
  await stopServer(server);
});

describe("D5: slop web", () => {
  describe("fixture db validates against the A2 schemas", () => {
    it("every ticket/session/event fixture file parses and validates", () => {
      // readJsoncEntities() above already threw at module load if any file
      // failed — these are the "so it shows up as a named, itemized test
      // result" assertions, not the actual check.
      expect(fixtureTickets.length).toBeGreaterThan(0);
      expect(fixtureSessions.length).toBeGreaterThan(0);
      expect(fixtureEvents.length).toBeGreaterThan(0);
    });

    it("has a config.yaml with the expected top-level keys", () => {
      // config.yaml can't be parsed portably here — Bun.YAML (like every
      // other Bun-only API) isn't available under vitest, see this file's
      // header comment. Its schema-validity is instead proven end-to-end,
      // for real, by the live server below: FixtureDataSource.getConfig()
      // runs `configSchema.parse(Bun.YAML.parse(text))` on every request,
      // and the tree/review/stale assertions further down specifically
      // check config-*derived* values (the Jira badge URL built from
      // `remotes.jira`, the stale thresholds text) rendered correctly —
      // that would be impossible if config.yaml failed validation.
      const text = readFileSync(join(slopDir, "config.yaml"), "utf8");
      for (const key of [
        "project:",
        "remotes:",
        "jira:",
        "defaults:",
        "stale_after:",
        "review_stale_after:",
      ]) {
        expect(text).toContain(key);
      }
    });
  });

  // -------------------------------------------------------------------------
  // §4.4 item 1: ticket list with filters — GET /api/tickets.
  // -------------------------------------------------------------------------
  describe("1. Ticket list with filters", () => {
    it("lists every ticket with state/priority/name/slug/labels/owner/last-activity", async () => {
      const { status, body } = await getJson<TicketListResponseDTO>("/api/tickets");
      expect(status).toBe(200);
      expect(body.total).toBe(fixtureTickets.length);
      const names = body.tickets.map((t) => t.name);
      const slugs = body.tickets.map((t) => t.slug);
      for (const t of fixtureTickets) {
        expect(names, `expected /api/tickets to list "${t.name}"`).toContain(t.name);
        expect(slugs).toContain(t.slug);
      }
      // Every row carries what a human scanning work needs (design.md §4.4 item 1).
      const first = body.tickets[0];
      expect(first).toMatchObject({
        state: expect.any(String),
        priority: expect.any(Number),
        name: expect.any(String),
        slug: expect.any(String),
        labels: expect.any(Array),
      });
    });

    it("state filter really filters", async () => {
      const { body } = await getJson<TicketListResponseDTO>("/api/tickets?state=done");
      const names = body.tickets.map((t) => t.name);
      const doneTickets = fixtureTickets.filter((t) => t.state === "done");
      const nonDoneTickets = fixtureTickets.filter((t) => t.state !== "done");
      expect(doneTickets.length).toBeGreaterThan(0);
      for (const t of doneTickets) expect(names).toContain(t.name);
      for (const t of nonDoneTickets) expect(names).not.toContain(t.name);
    });

    it("label filter really filters", async () => {
      const { body } = await getJson<TicketListResponseDTO>("/api/tickets?label=billing");
      const names = body.tickets.map((t) => t.name);
      const billing = fixtureTickets.filter((t) => t.labels.includes("billing"));
      const nonBilling = fixtureTickets.filter((t) => !t.labels.includes("billing"));
      expect(billing.length).toBeGreaterThan(0);
      for (const t of billing) expect(names).toContain(t.name);
      for (const t of nonBilling) expect(names).not.toContain(t.name);
    });

    it("priority filter really filters", async () => {
      const { body } = await getJson<TicketListResponseDTO>("/api/tickets?priority=0");
      const names = body.tickets.map((t) => t.name);
      const urgent = fixtureTickets.filter((t) => t.priority === 0);
      const nonUrgent = fixtureTickets.filter((t) => t.priority !== 0);
      expect(urgent.length).toBeGreaterThan(0);
      for (const t of urgent) expect(names).toContain(t.name);
      for (const t of nonUrgent) expect(names).not.toContain(t.name);
    });

    it("owner filter really filters (including the unowned case)", async () => {
      const { body } = await getJson<TicketListResponseDTO>("/api/tickets?owner=ryan");
      const names = body.tickets.map((t) => t.name);
      const owned = fixtureTickets.filter((t) => t.owner?.name === "ryan");
      const unowned = fixtureTickets.filter((t) => t.owner === null);
      expect(owned.length).toBeGreaterThan(0);
      expect(unowned.length).toBeGreaterThan(0);
      for (const t of owned) expect(names).toContain(t.name);
      for (const t of unowned) expect(names).not.toContain(t.name);
    });

    it("text filter really filters", async () => {
      const { body } = await getJson<TicketListResponseDTO>("/api/tickets?q=billing");
      const names = body.tickets.map((t) => t.name);
      expect(names).toContain("Migrate billing to new provider");
      expect(names).not.toContain("Fix flaky CI on windows runners");
    });

    it("filters compose (state AND label)", async () => {
      const { body } = await getJson<TicketListResponseDTO>(
        "/api/tickets?state=dropped&label=research",
      );
      const names = body.tickets.map((t) => t.name);
      expect(names).toContain("Prototype vector search for ticket search");
      expect(names).not.toContain("Old idea: Slack integration"); // dropped, but not labelled research
    });

    it("exposes label/owner facets for building filter controls", async () => {
      const { body } = await getJson<TicketListResponseDTO>("/api/tickets");
      expect(body.facets.labels).toContain("billing");
      expect(body.facets.owners).toContain("ryan");
      expect(body.facets.states).toContain("done");
    });
  });

  // -------------------------------------------------------------------------
  // §4.4 item 2: tree view — GET /api/tree.
  // -------------------------------------------------------------------------
  describe("2. Tree view", () => {
    function findNode(nodes: TreeNodeDTO[], name: string): TreeNodeDTO | undefined {
      for (const node of nodes) {
        if (node.ticket.name === name) return node;
        const found = findNode(node.children, name);
        if (found) return found;
      }
      return undefined;
    }

    it("shows the multi-level local hierarchy in nested order", async () => {
      const { status, body } = await getJson<TreeResponseDTO>("/api/tree");
      expect(status).toBe(200);

      const root = findNode(body.roots, "Add authentication provider");
      expect(root, "root ticket missing from /api/tree").toBeDefined();
      const child = root?.children.find((c) => c.ticket.name === "Implement OAuth provider");
      expect(child, "child ticket not nested under its parent").toBeDefined();
      const grandchild = child?.children.find(
        (c) => c.ticket.name === "Add OAuth provider unit tests",
      );
      expect(grandchild, "grandchild ticket not nested three levels deep").toBeDefined();
    });

    it("renders an external jira: parent as a badge linking to the URL built from remotes.jira, not as a traversable node", async () => {
      const { body } = await getJson<TreeResponseDTO>("/api/tree");
      // The ticket with the external parent is itself a *local root* (D1) — it must be a top-level tree node, not nested under anything.
      const node = body.roots.find((r) => r.ticket.name === "Migrate billing to new provider");
      expect(node, "ticket with an external jira: parent must be a local root").toBeDefined();
      expect(node?.external_parent?.ref).toBe("jira:PROJ-123");
      // remotes.jira in the fixture config is https://fixtureorg.atlassian.net (§3: "<system>:<key>" -> "<remotes.jira>/browse/<key>").
      expect(node?.external_parent?.safe_url).toBe(
        "https://fixtureorg.atlassian.net/browse/PROJ-123",
      );
      // ...and it still has its own local child nested beneath it.
      expect(node?.children.some((c) => c.ticket.name === "Write billing migration runbook")).toBe(
        true,
      );
    });
  });

  // -------------------------------------------------------------------------
  // §4.4 item 3: ticket detail — GET /api/tickets/:ref.
  // -------------------------------------------------------------------------
  describe("3. Ticket detail", () => {
    it("renders spec: summary, details_md as sanitized markdown HTML, acceptance[], context[], meta", async () => {
      const root = ticketBySlug("add-authentication-provider");
      const { status, body } = await getJson<TicketDetailDTO>(`/api/tickets/${root.id}`);
      expect(status).toBe(200);

      expect(body.spec.summary).toContain("Support pluggable auth providers so self-hosters");
      // details_md is markdown-rendered server-side into details_html, never left as raw markdown.
      expect(body.spec.details_html).toContain("<h2>Why</h2>");
      expect(body.spec.details_html).not.toContain("## Why");
      expect(body.spec.details_html).toContain(
        "<li>Keep the built-in provider as the default</li>",
      );
      for (const item of root.spec.acceptance) expect(body.spec.acceptance).toContain(item);
      for (const item of root.spec.context) expect(body.spec.context).toContain(item);
      expect(Object.keys(body.spec.meta)).toContain("estimated_days");
      expect(Object.keys(body.spec.meta)).toContain("epic");
    });

    it("renders the updates timeline with more than one event", async () => {
      const root = ticketBySlug("add-authentication-provider");
      const { body } = await getJson<TicketDetailDTO>(`/api/tickets/${root.id}`);
      const createdEvent = body.events.find((e) => e.verb === "ticket.created");
      expect(createdEvent, "no ticket.created event in the timeline").toBeDefined();
      expect(createdEvent?.label).toBe("created");
      const events = fixtureEvents.filter(
        (e) => e.entity.kind === "ticket" && e.entity.id === root.id,
      );
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it("renders sessions with actor/harness/git/plan-versions/checked-steps", async () => {
      const implementOauth = ticketBySlug("implement-oauth-provider");
      const { status, body } = await getJson<TicketDetailDTO>(`/api/tickets/${implementOauth.id}`);
      expect(status).toBe(200);

      const [session] = body.sessions;
      expect(session).toBeDefined();
      expect(session?.actor.name).toBe("claude-agent-1");
      expect(session?.harness).toBe("claude-code");
      expect(session?.git_branch).toBe("feature/oauth-provider");
      expect(session?.git_commit_at_start).toBe("a1b2c3d4");
      // Multi-version plan, both versions present, with checked-step counts.
      const v1 = session?.plan.find((p) => p.version === 1);
      const v2 = session?.plan.find((p) => p.version === 2);
      expect(v1?.steps.filter((s) => s.checked).length).toBe(2);
      expect(v1?.steps.length).toBe(3);
      expect(v2?.steps.filter((s) => s.checked).length).toBe(3);
      expect(v2?.steps.length).toBe(5);
      expect(v2?.steps.some((s) => s.text.includes("Wire up openid-client"))).toBe(true);
      const [fixtureSession] = sessionsForTicket(implementOauth.id);
      expect(fixtureSession).toBeDefined();
      expect(session?.id).toBe(fixtureSession?.id);
    });

    it("shows review info (MR link + review-staleness) for a ticket in review", async () => {
      const inReview = ticketBySlug("refactor-cli-error-reporting");
      const { body } = await getJson<TicketDetailDTO>(`/api/tickets/${inReview.id}`);
      expect(body.ticket.review?.mr?.url).toBe("https://github.com/ryan/slopwork-fixture/pull/42");
      expect(body.ticket.review?.mr?.safe_url).toBe(
        "https://github.com/ryan/slopwork-fixture/pull/42",
      );
      expect(typeof body.ticket.review?.awaiting_ms).toBe("number");
    });

    it("shows a blocked badge on a ticket with a live blocker", async () => {
      const blocked = ticketBySlug("add-oauth-provider-unit-tests");
      const { body } = await getJson<TicketDetailDTO>(`/api/tickets/${blocked.id}`);
      expect(body.ticket.overlay.blocked).toBe(true);
      expect(body.ticket.overlay.blocked_by.length).toBeGreaterThan(0);
    });

    it("404s readably for an unknown ref", async () => {
      const res = await get("/api/tickets/ticket_01DOESNOTEXIST0000000000");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('No ticket matches "ticket_01DOESNOTEXIST0000000000"');
    });
  });

  // -------------------------------------------------------------------------
  // §4.4 item 5: review panel — GET /api/review.
  // -------------------------------------------------------------------------
  describe("5. Review panel", () => {
    it("lists tickets in review with their MR links and marks the stale one, not the fresh one", async () => {
      const { status, body } = await getJson<ReviewResponseDTO>("/api/review");
      expect(status).toBe(200);

      const names = body.tickets.map((t) => t.name);
      expect(names).toContain("Refactor CLI error reporting");
      expect(names).toContain("Add dark mode to slop web");
      const mrUrls = body.tickets.map((t) => t.review?.mr?.url);
      expect(mrUrls).toContain("https://github.com/ryan/slopwork-fixture/pull/42");
      expect(mrUrls).toContain("https://github.com/ryan/slopwork-fixture/pull/37");

      // Exactly one of the two review tickets is stale (requested 3 days
      // ago vs. review_stale_after: 24h) — the other was requested 10
      // minutes ago and must NOT be marked stale.
      const staleCount = body.tickets.filter((t) => t.overlay.stale).length;
      expect(staleCount).toBe(1);
    });

    it("excludes tickets that are not in review", async () => {
      const { body } = await getJson<ReviewResponseDTO>("/api/review");
      const names = body.tickets.map((t) => t.name);
      expect(names).not.toContain("Implement OAuth provider");
      expect(names).not.toContain("Fix flaky CI on windows runners");
    });
  });

  // -------------------------------------------------------------------------
  // §4.4 item 6: stale / resumable panel — GET /api/stale.
  // -------------------------------------------------------------------------
  describe("6. Stale / resumable panel", () => {
    it("lists stale in-progress and stale review tickets, and excludes fresh ones", async () => {
      const { status, body } = await getJson<StaleResponseDTO>("/api/stale");
      expect(status).toBe(200);
      const names = body.rows.map((r) => r.ticket.name);

      // Stale (per config: stale_after 60m / review_stale_after 24h, against the pinned fixture clock):
      expect(names).toContain("Migrate billing to new provider"); // in_progress, 5h idle
      expect(names).toContain("Rewrite index builder for incremental updates"); // in_progress, 2d idle
      expect(names).toContain("Add dark mode to slop web"); // review, 3d idle

      // Fresh — must be excluded:
      expect(names).not.toContain("Implement OAuth provider"); // in_progress, 5m idle
      expect(names).not.toContain("Refactor CLI error reporting"); // review, 10m idle

      // Never-stale states, regardless of age:
      expect(names).not.toContain("Old idea: Slack integration"); // dropped
      expect(names).not.toContain("Add authentication provider"); // open
    });
  });

  // -------------------------------------------------------------------------
  // HEAD requests (web-head-returns-404-despite): Bun's declarative `routes`
  // table does not fall a HEAD request back onto a route's GET handler
  // automatically — a route with only a `GET:` entry 404s on HEAD, which
  // makes a health check (or `curl -I`, or anything else that HEADs before
  // GETting) conclude the UI is dead even though it's fine. Carried forward
  // for both the `/api/*` routes AND the SPA-shell fallback paths (new in
  // this rewrite — the shell is served by the `fetch` catch-all, not a
  // declarative route, so it needs its own coverage).
  // -------------------------------------------------------------------------
  describe("HEAD requests", () => {
    it.each([
      "/api/tickets",
      "/api/tree",
      "/api/review",
      "/api/stale",
      "/api/config",
      "/assets/app.css",
      "/assets/app.js",
      "/",
      "/tickets",
    ] as const)("HEAD %s returns 200 with an empty body", async (path) => {
      const res = await get(path, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    });

    it("HEAD on a ticket detail API route returns 200 with an empty body", async () => {
      const t = ticketBySlug("add-authentication-provider");
      const res = await get(`/api/tickets/${t.id}`, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    });

    it("HEAD on an unknown API route still 404s, never silently 200s", async () => {
      const res = await get("/api/nope/at/all", { method: "HEAD" });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Read-only contract (§4.6: "web mutations are explicitly out of scope").
  // -------------------------------------------------------------------------
  describe("Read-only contract", () => {
    it.each(["POST", "PUT", "DELETE", "PATCH"] as const)(
      "%s to a known API route returns 405, never a mutation",
      async (method) => {
        const res = await get("/api/tickets", { method });
        expect(res.status).toBe(405);
      },
    );

    it.each(["POST", "PUT", "DELETE"] as const)(
      "%s to a ticket detail API route returns 405",
      async (method) => {
        const t = ticketBySlug("add-authentication-provider");
        const res = await get(`/api/tickets/${t.id}`, { method });
        expect(res.status).toBe(405);
      },
    );

    it("POST to a client-routed SPA path (e.g. /tickets) returns 405, never the app shell", async () => {
      const res = await get("/tickets", { method: "POST" });
      expect(res.status).toBe(405);
    });

    it("POST to a totally unknown route returns 405, not a 500 or a silent 200", async () => {
      const res = await get("/nope/at/all", { method: "POST" });
      expect(res.status).toBe(405);
    });

    it("never mutates the on-disk fixture files, even when a write-shaped request is sent", async () => {
      const t = ticketBySlug("add-authentication-provider");
      const path = join(slopDir, "db", "tickets", `${t.id}.jsonc`);
      const before = readFileSync(path, "utf8");
      const beforeMtime = statSync(path).mtimeMs;

      await get(`/api/tickets/${t.id}`, { method: "POST" });
      await get(`/api/tickets/${t.id}`, { method: "DELETE" });
      await get("/api/tickets", { method: "PUT" });

      expect(readFileSync(path, "utf8")).toBe(before);
      expect(statSync(path).mtimeMs).toBe(beforeMtime);
    });
  });
});

// ---------------------------------------------------------------------------
// Compiled-binary path: the build-artifact smoke test (rewrite-slop-web-as-a
// acceptance criterion — "bun run build still emits the single
// self-contained binary with the SPA embedded... a build-artifact smoke
// test passes"). Proves the SPA (JS+CSS, including the bundled font) and
// the JSON API both actually work from `dist/slop`, not just from source,
// and that nothing in the served output reaches out to a CDN.
// ---------------------------------------------------------------------------
describe("D5: slop web — compiled binary (build-artifact smoke test)", () => {
  let binServer: RunningServer | undefined;

  beforeAll(async () => {
    if (!existsSync(binaryPath)) {
      execFileSync("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
    }
    if (!existsSync(binaryPath)) {
      throw new Error(`${binaryPath} is still missing after "bun run build".`);
    }
    binServer = await spawnAndWaitForUrl(binaryPath, ["web", "--port", "0"], fixtureParentDir, {
      ...process.env,
      SLOP_WEB_FAKE_NOW: FIXTURE_NOW_ISO,
    });
  }, 60_000);

  afterAll(async () => {
    await stopServer(binServer);
  });

  it("serves the SPA shell at / with the mount point and asset tags", async () => {
    const res = await fetch(new URL("/", binServer?.baseUrl));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<div id="root">');
    expect(body).toContain("/assets/app.js");
    expect(body).toContain("/assets/app.css");
  });

  it("serves real data from the compiled binary's JSON API", async () => {
    const res = await fetch(new URL("/api/tickets", binServer?.baseUrl));
    expect(res.status).toBe(200);
    const body = (await res.json()) as TicketListResponseDTO;
    expect(body.tickets.map((t) => t.name)).toContain("Add authentication provider");
  });

  it("serves the embedded CSS asset with a 200 (proves it's bundled into the binary, not read from a relative path that happens to exist)", async () => {
    const res = await fetch(new URL("/assets/app.css", binServer?.baseUrl));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("JetBrains Mono");
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  it("serves the embedded JS asset with a 200", async () => {
    const res = await fetch(new URL("/assets/app.js", binServer?.baseUrl));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(1000);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  it("nothing served reaches out to a CDN — the bundled JS/CSS carry no external-host references (offline posture)", async () => {
    const [js, css] = await Promise.all([
      fetch(new URL("/assets/app.js", binServer?.baseUrl)).then((r) => r.text()),
      fetch(new URL("/assets/app.css", binServer?.baseUrl)).then((r) => r.text()),
    ]);
    for (const host of [
      "fonts.googleapis.com",
      "fonts.gstatic.com",
      "cdn.",
      "unpkg.com",
      "jsdelivr.net",
    ]) {
      expect(js, `app.js referenced ${host}`).not.toContain(host);
      expect(css, `app.css referenced ${host}`).not.toContain(host);
    }
  });

  it("still enforces the read-only contract from the compiled binary", async () => {
    const res = await fetch(new URL("/api/tickets", binServer?.baseUrl), { method: "POST" });
    expect(res.status).toBe(405);
  });
});
