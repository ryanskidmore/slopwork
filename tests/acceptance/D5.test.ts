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
import { FIXTURE_NOW_ISO } from "../fixtures/web-db-meta.js";

// D5: `slop web`
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "All §4.4 views against a seeded fixture db; transcript JSONL renders
//   readably"
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
      reject(new Error(`process exited early (code ${code}) before printing a URL.\nstderr: ${stderr}`));
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
const fixtureSessions: Session[] = readJsoncEntities(join(slopDir, "db", "sessions"), sessionSchema);
const fixtureEvents: Event[] = readJsoncEntities(join(slopDir, "db", "events"), eventSchema);

function ticketBySlug(slug: string): Ticket {
  const found = fixtureTickets.find((t) => t.slug === slug);
  if (!found) throw new Error(`fixture db has no ticket with slug "${slug}" — did the generator change?`);
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

beforeAll(async () => {
  server = await spawnAndWaitForUrl(
    "bun",
    [cliEntry, "web", "--port", "0"],
    fixtureParentDir,
    { ...process.env, SLOP_WEB_FAKE_NOW: FIXTURE_NOW_ISO },
  );
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
      for (const key of ["project:", "remotes:", "jira:", "defaults:", "stale_after:", "review_stale_after:"]) {
        expect(text).toContain(key);
      }
    });
  });

  // -------------------------------------------------------------------------
  // §4.4 item 1: ticket list with filters.
  // -------------------------------------------------------------------------
  describe("1. Ticket list with filters", () => {
    it("lists every ticket with state/priority/name/slug/labels/owner/last-activity", async () => {
      const res = await get("/tickets");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(`${fixtureTickets.length} of ${fixtureTickets.length} ticket`);
      for (const t of fixtureTickets) {
        expect(body, `expected /tickets to list "${t.name}"`).toContain(t.name);
        expect(body).toContain(t.slug);
      }
    });

    it("state filter really filters", async () => {
      const res = await get("/tickets?state=done");
      const body = await res.text();
      const doneTickets = fixtureTickets.filter((t) => t.state === "done");
      const nonDoneTickets = fixtureTickets.filter((t) => t.state !== "done");
      expect(doneTickets.length).toBeGreaterThan(0);
      for (const t of doneTickets) expect(body).toContain(t.name);
      for (const t of nonDoneTickets) expect(body).not.toContain(t.name);
    });

    it("label filter really filters", async () => {
      const res = await get("/tickets?label=billing");
      const body = await res.text();
      const billing = fixtureTickets.filter((t) => t.labels.includes("billing"));
      const nonBilling = fixtureTickets.filter((t) => !t.labels.includes("billing"));
      expect(billing.length).toBeGreaterThan(0);
      for (const t of billing) expect(body).toContain(t.name);
      for (const t of nonBilling) expect(body).not.toContain(t.name);
    });

    it("priority filter really filters", async () => {
      const res = await get("/tickets?priority=0");
      const body = await res.text();
      const urgent = fixtureTickets.filter((t) => t.priority === 0);
      const nonUrgent = fixtureTickets.filter((t) => t.priority !== 0);
      expect(urgent.length).toBeGreaterThan(0);
      for (const t of urgent) expect(body).toContain(t.name);
      for (const t of nonUrgent) expect(body).not.toContain(t.name);
    });

    it("owner filter really filters (including the unowned case)", async () => {
      const res = await get("/tickets?owner=ryan");
      const body = await res.text();
      const owned = fixtureTickets.filter((t) => t.owner?.name === "ryan");
      const unowned = fixtureTickets.filter((t) => t.owner === null);
      expect(owned.length).toBeGreaterThan(0);
      expect(unowned.length).toBeGreaterThan(0);
      for (const t of owned) expect(body).toContain(t.name);
      for (const t of unowned) expect(body).not.toContain(t.name);
    });

    it("text filter really filters", async () => {
      const res = await get("/tickets?q=billing");
      const body = await res.text();
      expect(body).toContain("Migrate billing to new provider");
      expect(body).not.toContain("Fix flaky CI on windows runners");
    });

    it("filters compose (state AND label)", async () => {
      const res = await get("/tickets?state=dropped&label=research");
      const body = await res.text();
      expect(body).toContain("Prototype vector search for ticket search");
      expect(body).not.toContain("Old idea: Slack integration"); // dropped, but not labelled research
    });
  });

  // -------------------------------------------------------------------------
  // §4.4 item 2: tree view.
  // -------------------------------------------------------------------------
  describe("2. Tree view", () => {
    it("shows the multi-level local hierarchy in nested order", async () => {
      const res = await get("/tree");
      expect(res.status).toBe(200);
      const body = await res.text();

      const root = "Add authentication provider";
      const child = "Implement OAuth provider";
      const grandchild = "Add OAuth provider unit tests";
      for (const name of [root, child, grandchild]) {
        expect(body, `expected /tree to contain "${name}"`).toContain(name);
      }
      // Structural nesting: root appears before its child, which appears
      // before its own child (D1: parent/child hierarchy, 3 levels deep).
      const rootIndex = body.indexOf(root);
      const childIndex = body.indexOf(child);
      const grandchildIndex = body.indexOf(grandchild);
      expect(rootIndex).toBeGreaterThanOrEqual(0);
      expect(childIndex).toBeGreaterThan(rootIndex);
      expect(grandchildIndex).toBeGreaterThan(childIndex);
      // At least two levels of <ul class="tree"> nesting (root's children, and their children).
      expect(body.match(/<ul class="tree">/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });

    it("renders an external jira: parent as a badge linking to the URL built from remotes.jira, not as a traversable node", async () => {
      const res = await get("/tree");
      const body = await res.text();
      expect(body).toContain("jira:PROJ-123");
      // remotes.jira in the fixture config is https://fixtureorg.atlassian.net (§3: "<system>:<key>" -> "<remotes.jira>/browse/<key>").
      expect(body).toContain(
        '<a class="badge external-parent jira" href="https://fixtureorg.atlassian.net/browse/PROJ-123"',
      );
      // The ticket with the external parent is itself a *local root* (D1) — it must be listed as a top-level tree node, not nested under anything.
      expect(body).toContain("Migrate billing to new provider");
      // ...and it still has its own local child nested beneath it.
      const parentIndex = body.indexOf("Migrate billing to new provider");
      const childIndex = body.indexOf("Write billing migration runbook");
      expect(childIndex).toBeGreaterThan(parentIndex);
    });
  });

  // -------------------------------------------------------------------------
  // §4.4 item 3: ticket detail.
  // -------------------------------------------------------------------------
  describe("3. Ticket detail", () => {
    it("renders spec: summary, details_md as markdown, acceptance[], context[], meta", async () => {
      const root = ticketBySlug("add-authentication-provider");
      const res = await get(`/tickets/${root.id}`);
      expect(res.status).toBe(200);
      const body = await res.text();

      // spec.summary is plain escaped text (not markdown) — the fixture's summary contains an
      // apostrophe, which the page correctly HTML-escapes, so match on an apostrophe-free slice.
      expect(body).toContain("Support pluggable auth providers so self-hosters");
      // details_md contains "## Why" and a bullet list — markdown-rendered, not raw.
      expect(body).toContain("<h2>Why</h2>");
      expect(body).not.toContain("## Why");
      expect(body).toContain("<li>Keep the built-in provider as the default</li>");
      // acceptance[]
      for (const item of root.spec.acceptance) expect(body).toContain(item);
      // context[]
      for (const item of root.spec.context) expect(body).toContain(item);
      // meta
      expect(body).toContain("estimated_days");
      expect(body).toContain("epic");
    });

    it("renders the updates timeline with more than one event", async () => {
      const root = ticketBySlug("add-authentication-provider");
      const res = await get(`/tickets/${root.id}`);
      const body = await res.text();
      expect(body).toContain("Updates timeline");
      expect(body).toContain("created");
      // At least two distinct timestamps show up in the timeline for this ticket.
      const events = fixtureEvents.filter((e) => e.entity.kind === "ticket" && e.entity.id === root.id);
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it("renders sessions with actor/harness/git/plan-versions/checked-steps and a transcript link", async () => {
      const implementOauth = ticketBySlug("implement-oauth-provider");
      const res = await get(`/tickets/${implementOauth.id}`);
      expect(res.status).toBe(200);
      const body = await res.text();

      expect(body).toContain("claude-agent-1");
      expect(body).toContain("claude-code");
      expect(body).toContain("feature/oauth-provider");
      expect(body).toContain("a1b2c3d4");
      // Multi-version plan, both versions rendered, with checked-step counts.
      expect(body).toContain("Plan v1 (2/3 checked)");
      expect(body).toContain("Plan v2 (3/5 checked)");
      expect(body).toContain("Wire up openid-client");
      // Link to the transcript viewer for this session.
      const [session] = sessionsForTicket(implementOauth.id);
      expect(session).toBeDefined();
      expect(body).toContain(`/tickets/${implementOauth.id}/sessions/${session?.id}/transcript`);
    });

    it("shows review info (MR link + review-staleness) for a ticket in review", async () => {
      const inReview = ticketBySlug("refactor-cli-error-reporting");
      const res = await get(`/tickets/${inReview.id}`);
      const body = await res.text();
      expect(body).toContain("https://github.com/ryan/slopworks-fixture/pull/42");
      expect(body).toContain("awaiting review for");
    });

    it("shows a blocked badge on a ticket with a live blocker", async () => {
      const blocked = ticketBySlug("add-oauth-provider-unit-tests");
      const res = await get(`/tickets/${blocked.id}`);
      const body = await res.text();
      expect(body).toContain("Blocked");
    });

    it("404s readably for an unknown ref", async () => {
      const res = await get("/tickets/ticket_01DOESNOTEXIST0000000000");
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Not found");
    });
  });

  // -------------------------------------------------------------------------
  // §4.4 item 4: transcript viewer.
  // -------------------------------------------------------------------------
  describe("4. Transcript viewer", () => {
    const implementOauth = () => ticketBySlug("implement-oauth-provider");
    const bigSession = () => sessionsForTicket(implementOauth().id)[0] as Session;

    it("renders conversation turns readably: user text, assistant text, and the tool_use tool name", async () => {
      const ticket = implementOauth();
      const session = bigSession();
      const res = await get(`/tickets/${ticket.id}/sessions/${session.id}/transcript`);
      expect(res.status).toBe(200);
      const body = await res.text();

      expect(body).toContain(
        "Let's implement the OAuth provider described in the ticket. Start by reading the provider interface.",
      );
      expect(body).toContain("Working on wiring the authorize() flow");
      expect(body).toContain("tool_use: Read");
      expect(body).toContain('class="turn role-user"');
      expect(body).toContain('class="turn role-assistant"');
    });

    it("de-emphasises and collapses thinking blocks, and collapses tool_use/tool_result behind an expand affordance", async () => {
      const ticket = implementOauth();
      const session = bigSession();
      const res = await get(`/tickets/${ticket.id}/sessions/${session.id}/transcript`);
      const body = await res.text();
      expect(body).toContain('<details class="block-thinking">');
      expect(body).toContain('<details class="block-tool_use">');
      expect(body).toMatch(/<details class="block-tool_result/);
      // Collapsed by default: no `open` attribute on these <details>.
      expect(body).not.toMatch(/<details class="block-thinking" open>/);
      expect(body).not.toMatch(/<details class="block-tool_use" open>/);
    });

    it("truncates a very long tool_result with a visible note, rather than dumping it whole", async () => {
      const ticket = implementOauth();
      const session = bigSession();
      const res = await get(`/tickets/${ticket.id}/sessions/${session.id}/transcript`);
      const body = await res.text();
      expect(body).toMatch(/Truncated: showing the first [\d,]+ of [\d,]+ characters\./);
    });

    it("does NOT dump raw JSONL — no raw record fields ever appear in the HTML", async () => {
      const ticket = implementOauth();
      const session = bigSession();
      const res = await get(`/tickets/${ticket.id}/sessions/${session.id}/transcript`);
      const body = await res.text();
      for (const rawMarker of ['"parentUuid"', '"isSidechain"', '"userType"', '{"type":"assistant"', '{"type":"user"']) {
        expect(body, `transcript view leaked raw JSONL marker ${rawMarker}`).not.toContain(rawMarker);
      }
    });

    it("skips non-conversational record types by default, and paginates rather than rendering everything at once", async () => {
      const ticket = implementOauth();
      const session = bigSession();
      const page1 = await (await get(`/tickets/${ticket.id}/sessions/${session.id}/transcript`)).text();
      // Hidden-by-default types never show up as their own turns.
      expect(page1).not.toContain("— system");
      // The transcript has more than the default page size (40) worth of conversational records — pagination must kick in.
      expect(page1).toContain("records 1–40");
      expect(page1).toContain("Older →");

      const page2 = await (
        await get(`/tickets/${ticket.id}/sessions/${session.id}/transcript?offset=40&limit=40`)
      ).text();
      expect(page2).toContain("Newer");
      // "(iteration 1)" is a unique marker for the very first loop message, which lands on page 1 — it must not reappear on page 2.
      expect(page1).toContain("(iteration 1).");
      expect(page2).not.toContain("(iteration 1).");
    });

    it("shows system records only when explicitly toggled on", async () => {
      const ticket = implementOauth();
      const session = bigSession();
      const body = await (
        await get(`/tickets/${ticket.id}/sessions/${session.id}/transcript?all=1`)
      ).text();
      expect(body).toContain("system-divider");
      expect(body).toContain("compact_boundary");
    });

    it("degrades readably when no transcript was captured for a session (D16/S2: expected, not an error)", async () => {
      const migrateBilling = ticketBySlug("migrate-billing-to-new-provider");
      const [session] = sessionsForTicket(migrateBilling.id);
      expect(session?.transcript_ref).toBeNull();
      const res = await get(`/tickets/${migrateBilling.id}/sessions/${session?.id}/transcript`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("No transcript was captured");
    });
  });

  // -------------------------------------------------------------------------
  // §4.4 item 5: review panel.
  // -------------------------------------------------------------------------
  describe("5. Review panel", () => {
    it("lists tickets in review with their MR links and marks the stale one, not the fresh one", async () => {
      const res = await get("/review");
      expect(res.status).toBe(200);
      const body = await res.text();

      expect(body).toContain("Refactor CLI error reporting");
      expect(body).toContain("https://github.com/ryan/slopworks-fixture/pull/42");
      expect(body).toContain("Add dark mode to slop web");
      expect(body).toContain("https://github.com/ryan/slopworks-fixture/pull/37");

      // Exactly one of the two review tickets is stale (requested 3 days
      // ago vs. review_stale_after: 24h) — the other was requested 10
      // minutes ago and must NOT be marked stale.
      const staleBadgeCount = (body.match(/class="badge stale"/g) ?? []).length;
      expect(staleBadgeCount).toBe(1);
    });

    it("excludes tickets that are not in review", async () => {
      const res = await get("/review");
      const body = await res.text();
      expect(body).not.toContain("Implement OAuth provider");
      expect(body).not.toContain("Fix flaky CI on windows runners");
    });
  });

  // -------------------------------------------------------------------------
  // §4.4 item 6: stale / resumable panel.
  // -------------------------------------------------------------------------
  describe("6. Stale / resumable panel", () => {
    it("lists stale in-progress and stale review tickets, and excludes fresh ones", async () => {
      const res = await get("/stale");
      expect(res.status).toBe(200);
      const body = await res.text();

      // Stale (per config: stale_after 60m / review_stale_after 24h, against the pinned fixture clock):
      expect(body).toContain("Migrate billing to new provider"); // in_progress, 5h idle
      expect(body).toContain("Rewrite index builder for incremental updates"); // in_progress, 2d idle
      expect(body).toContain("Add dark mode to slop web"); // review, 3d idle

      // Fresh — must be excluded:
      expect(body).not.toContain("Implement OAuth provider"); // in_progress, 5m idle
      expect(body).not.toContain("Refactor CLI error reporting"); // review, 10m idle

      // Never-stale states, regardless of age:
      expect(body).not.toContain("Old idea: Slack integration"); // dropped
      expect(body).not.toContain("Add authentication provider"); // open
    });
  });

  // -------------------------------------------------------------------------
  // Read-only contract (§4.6: "web mutations are explicitly out of scope").
  // -------------------------------------------------------------------------
  describe("Read-only contract", () => {
    it.each(["POST", "PUT", "DELETE", "PATCH"] as const)(
      "%s to a known route returns 405 (or 404), never a mutation",
      async (method) => {
        const res = await get("/tickets", { method });
        expect([404, 405]).toContain(res.status);
      },
    );

    it.each(["POST", "PUT", "DELETE"] as const)(
      "%s to a ticket detail route returns 405 (or 404)",
      async (method) => {
        const t = ticketBySlug("add-authentication-provider");
        const res = await get(`/tickets/${t.id}`, { method });
        expect([404, 405]).toContain(res.status);
      },
    );

    it("POST to a totally unknown route returns 405, not a 500 or a silent 200", async () => {
      const res = await get("/nope/at/all", { method: "POST" });
      expect(res.status).toBe(405);
    });

    it("never mutates the on-disk fixture files, even when a write-shaped request is sent", async () => {
      const t = ticketBySlug("add-authentication-provider");
      const path = join(slopDir, "db", "tickets", `${t.id}.jsonc`);
      const before = readFileSync(path, "utf8");
      const beforeMtime = statSync(path).mtimeMs;

      await get(`/tickets/${t.id}`, { method: "POST" });
      await get(`/tickets/${t.id}`, { method: "DELETE" });
      await get("/tickets", { method: "PUT" });

      expect(readFileSync(path, "utf8")).toBe(before);
      expect(statSync(path).mtimeMs).toBe(beforeMtime);
    });
  });
});

// ---------------------------------------------------------------------------
// Compiled-binary path: the check that catches assets missing from the
// compiled binary (D5 architecture requirement).
// ---------------------------------------------------------------------------
describe("D5: slop web — compiled binary", () => {
  let binServer: RunningServer | undefined;

  beforeAll(async () => {
    if (!existsSync(binaryPath)) {
      execFileSync("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
    }
    if (!existsSync(binaryPath)) {
      throw new Error(`${binaryPath} is still missing after "bun run build".`);
    }
    binServer = await spawnAndWaitForUrl(
      binaryPath,
      ["web", "--port", "0"],
      fixtureParentDir,
      { ...process.env, SLOP_WEB_FAKE_NOW: FIXTURE_NOW_ISO },
    );
  }, 60_000);

  afterAll(async () => {
    await stopServer(binServer);
  });

  it("serves a real page from the compiled binary", async () => {
    const res = await fetch(new URL("/tickets", binServer?.baseUrl));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Add authentication provider");
  });

  it("serves the embedded CSS asset with a 200 (proves it's bundled into the binary, not read from a relative path that happens to exist)", async () => {
    const res = await fetch(new URL("/assets/style.css", binServer?.baseUrl));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(".badge");
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  it("serves the embedded JS asset with a 200", async () => {
    const res = await fetch(new URL("/assets/app.js", binServer?.baseUrl));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("data-live-filter");
  });

  it("still enforces the read-only contract from the compiled binary", async () => {
    const res = await fetch(new URL("/tickets", binServer?.baseUrl), { method: "POST" });
    expect(res.status).toBe(405);
  });
});
