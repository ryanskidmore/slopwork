import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_EVENTS_LIMIT } from "../../src/cli/commands/events.js";
import {
  type Session,
  type Ticket,
  type TicketId,
  newSessionId,
  newTicketId,
  sessionSchema,
  slugify,
  ticketSchema,
} from "../../src/core/index.js";
import {
  createSession,
  createTicket,
  appendEvent,
  ensureDbDirs,
  type EventContext,
  listEvents,
  type RepoPaths,
  updateSession,
  updateTicket,
} from "../../src/repo/index.js";

// D3: `events` command
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "Cursor pagination stable across reindex"
//
// Proven below by, in order:
//   1. Building a substantial (162-event) fixture directly through the
//      repo layer — B1/C1's `new`/`start` commands are a different work
//      item's concern; per this item's brief, fixtures here are built with
//      `ensureDbDirs` + repo-layer mutation calls + a hand-written
//      config.yaml, never `slop init`/`slop new`.
//   2. Paging the compiled CLI through the WHOLE stream, in fixed,
//      non-divisor-of-total page sizes, twice — once, then again after
//      deleting `.slop/db/index.jsonc` and forcing `slop reindex` — and
//      asserting the two runs produce byte-identical pages, not just an
//      identical flattened id list ("identical page boundaries" in the
//      brief).
//   3. A third pagination run that interleaves the rebuild INTO a single
//      continuous paging sequence (delete + reindex fired partway through,
//      using a cursor obtained before the rebuild to keep paging after
//      it), asserting the concatenated result is exactly the full stream.
//   4. A same-millisecond burst (150 events minted in a tight loop, no
//      awaited I/O between them) paged via `--ticket`, proving ordering is
//      total and duplicate-free even under a burst a weaker (time-based)
//      cursor would collapse.
//
// Every one of these pages via `queryEvents`'s `since`/id-based cursor —
// never anything read from `index.jsonc` — which is what makes the
// criterion hold structurally; see src/cli/commands/events.ts's module doc
// and src/repo/events.ts's `queryEvents` doc for why.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
  // Same "build if missing" convention as A1.test.ts / D1.test.ts / D5.test.ts.
  if (!existsSync(binaryPath)) {
    execFileSync("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  }
  if (!existsSync(binaryPath)) {
    throw new Error(
      `${binaryPath} is still missing after attempting "bun run build". ` +
        'Run "bun run build" manually and re-run the tests.',
    );
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Scratch dirs + CLI spawning
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

afterAll(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const CONFIG_YAML = [
  "project: d3-fixture",
  "user: d3-tester",
  "defaults:",
  "  stale_after: 60m",
  "  review_stale_after: 24h",
  "",
].join("\n");

/** Build a bare repo directly through the repo layer — no `slop init`. */
async function makeScratchRepo(prefix: string): Promise<RepoPaths> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  const paths = await ensureDbDirs(dir);
  writeFileSync(join(dir, ".slop", "config.yaml"), CONFIG_YAML, "utf8");
  return paths;
}

function runSlop(args: string[], cwd: string) {
  return spawnSync(binaryPath, args, { cwd, encoding: "utf8", env: { ...process.env } });
}

interface EventsJsonEvent {
  id: string;
  at: string;
  verb: string;
  actor: { name: string; kind: string };
  session: string | null;
  entity: { kind: string; id: string };
  payload: Record<string, unknown>;
}

interface EventsJsonResponse {
  query: { since: string | null; ticket: string | null; limit: number | null };
  events: EventsJsonEvent[];
  count: number;
  next_cursor: string | null;
  has_more: boolean;
}

function runEventsJson(dir: string, args: string[] = []): EventsJsonResponse {
  const result = runSlop(["events", "--json", ...args], dir);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as EventsJsonResponse;
}

/** `.slop/db/index.jsonc`'s path under a scratch dir built by {@link makeScratchRepo}. */
function indexPath(dir: string): string {
  return join(dir, ".slop", "db", "index.jsonc");
}

/** Delete `index.jsonc` and force a rebuild via the real `slop reindex` — the acceptance criterion's own wording. */
function forceReindex(dir: string): void {
  rmSync(indexPath(dir), { force: true });
  const result = runSlop(["reindex"], dir);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(indexPath(dir))).toBe(true);
}

/** Page the whole stream via `--json`/`--limit`, collecting each page's ids separately. */
function pageAll(
  dir: string,
  limit: number,
  extraArgs: string[] = [],
): { pages: string[][]; ids: string[] } {
  const pages: string[][] = [];
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const args = [...extraArgs, "--limit", String(limit)];
    if (cursor !== undefined) args.push("--since", cursor);
    const resp = runEventsJson(dir, args);
    const pageIds = resp.events.map((e) => e.id);
    pages.push(pageIds);
    ids.push(...pageIds);
    cursor = resp.next_cursor ?? undefined;
    if (!resp.has_more) return { pages, ids };
  }
  throw new Error("pageAll: exceeded safety iteration bound — has_more never went false");
}

// ---------------------------------------------------------------------------
// Fixture builders (repo layer directly — see this file's header comment)
// ---------------------------------------------------------------------------

const NOW = "2026-07-23T10:00:00.000Z";
const SETUP_CTX: EventContext = { actor: { name: "d3-fixture", kind: "agent" }, session: null };

function makeTicket(overrides: Partial<Ticket> & { name: string }): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    slug: slugify(overrides.name),
    spec: { summary: "s" },
    state: "open",
    priority: 2,
    root_id: id,
    provenance: { method: "new", created_by: { name: "d3-fixture", kind: "agent" } },
    last_activity_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  });
}

function makeSession(overrides: Partial<Session> & { ticket: TicketId }): Session {
  return sessionSchema.parse({
    id: newSessionId(),
    actor: { name: "d3-session-agent", kind: "agent" },
    harness: { kind: "claude-code", session_id: null },
    git: { branch: "main", commit_at_start: null },
    started_at: NOW,
    ...overrides,
  });
}

const BURST_COUNT = 150;

interface SubstantialFixture {
  dir: string;
  paths: RepoPaths;
  ticket1: Ticket;
  ticket2: Ticket;
  ticket5: Ticket;
  session1Id: string;
  session2Id: string;
  /** Every event id, in the exact order the fixture created them. */
  allIds: string[];
  /** Ids of every event about ticket1 OR a session under ticket1 — the widened `--ticket` answer. */
  ticket1EventIds: string[];
  /** ticket5's own `ticket.created` id followed by all 150 burst `ticket.updated` ids, in order. */
  ticket5EventIds: string[];
}

/**
 * A 162-event fixture: 5 tickets, 2 sessions (one with a plan revision and
 * an end), and a 150-event same-millisecond burst — built once and reused
 * read-only across every `it` below (the CLI process is spawned fresh per
 * assertion; the fixture directory itself is never mutated except by the
 * reindex calls this file's tests deliberately trigger, which is exactly
 * what the acceptance criterion is about).
 */
async function buildSubstantialFixture(): Promise<SubstantialFixture> {
  const paths = await makeScratchRepo("slop-d3-fixture-");
  const dir = paths.root;
  const allIds: string[] = [];

  const ticket1 = makeTicket({ name: "Widget Alpha" });
  const ticket2 = makeTicket({ name: "Widget Beta" });
  const ticket3 = makeTicket({ name: "Widget Gamma" });
  const ticket4 = makeTicket({ name: "Widget Delta" });
  const ticket5 = makeTicket({ name: "Widget Epsilon" });

  const ticket1EventIds: string[] = [];
  const ticket5EventIds: string[] = [];

  for (const t of [ticket1, ticket2, ticket3, ticket4, ticket5]) {
    const ev = await createTicket(paths, t, SETUP_CTX, { verb: "ticket.created" });
    allIds.push(ev.id);
    if (t.id === ticket1.id) ticket1EventIds.push(ev.id);
    if (t.id === ticket5.id) ticket5EventIds.push(ev.id);
  }

  // ticket1: two plain field updates.
  const t1u1: Ticket = { ...ticket1, priority: 1 };
  const t1u1Event = await updateTicket(
    paths,
    ticket1.id,
    [{ path: ["priority"], value: 1 }],
    t1u1,
    SETUP_CTX,
    { verb: "ticket.updated" },
  );
  allIds.push(t1u1Event.id);
  ticket1EventIds.push(t1u1Event.id);

  const t1u2: Ticket = { ...t1u1, latest_note: "progress note" };
  const t1u2Event = await updateTicket(
    paths,
    ticket1.id,
    [{ path: ["latest_note"], value: "progress note" }],
    t1u2,
    SETUP_CTX,
    { verb: "ticket.updated" },
  );
  allIds.push(t1u2Event.id);
  ticket1EventIds.push(t1u2Event.id);

  // ticket2: one update.
  const t2u1: Ticket = { ...ticket2, priority: 0 };
  const t2u1Event = await updateTicket(
    paths,
    ticket2.id,
    [{ path: ["priority"], value: 0 }],
    t2u1,
    SETUP_CTX,
    { verb: "ticket.updated" },
  );
  allIds.push(t2u1Event.id);

  // session1, under ticket1: started -> plan set -> ended. This is the
  // session whose events D3's `--ticket` widening decision is about.
  const session1 = makeSession({ ticket: ticket1.id, actor: { name: "agent-1", kind: "agent" } });
  const session1Ctx: EventContext = { actor: session1.actor, session: session1.id };
  const s1StartEvent = await createSession(paths, session1, session1Ctx, {
    verb: "session.started",
  });
  allIds.push(s1StartEvent.id);
  ticket1EventIds.push(s1StartEvent.id);

  const session1Planned: Session = {
    ...session1,
    plan: [{ version: 1, steps: [{ text: "step 1", checked: false }], created_at: NOW }],
  };
  const s1PlanEvent = await updateSession(
    paths,
    session1.id,
    [{ path: ["plan"], value: session1Planned.plan }],
    session1Planned,
    session1Ctx,
    { verb: "plan.set" },
  );
  allIds.push(s1PlanEvent.id);
  ticket1EventIds.push(s1PlanEvent.id);

  const session1Ended: Session = { ...session1Planned, ended_at: NOW, end_summary: "wrapped up" };
  const s1EndEvent = await updateSession(
    paths,
    session1.id,
    [
      { path: ["ended_at"], value: NOW },
      { path: ["end_summary"], value: "wrapped up" },
    ],
    session1Ended,
    session1Ctx,
    { verb: "session.ended" },
  );
  allIds.push(s1EndEvent.id);
  ticket1EventIds.push(s1EndEvent.id);

  // session2, under ticket2: started only. Exists purely to prove
  // `--ticket ticket1` never leaks another ticket's session events.
  const session2 = makeSession({ ticket: ticket2.id, actor: { name: "agent-2", kind: "agent" } });
  const s2StartEvent = await createSession(
    paths,
    session2,
    { actor: session2.actor, session: session2.id },
    { verb: "session.started" },
  );
  allIds.push(s2StartEvent.id);

  // A same-millisecond burst against ticket5: BURST_COUNT `ticket.updated`
  // events fired back-to-back with no awaited I/O between mints, proving
  // total, duplicate-free ordering under exactly the condition a
  // wall-clock-based cursor would fail on (core/ids.ts's monotonic ULID
  // factory is what actually guarantees this).
  const burstCtx: EventContext = { actor: { name: "burst-agent", kind: "agent" }, session: null };
  for (let i = 0; i < BURST_COUNT; i++) {
    const ev = await appendEvent(
      paths,
      burstCtx,
      { kind: "ticket", id: ticket5.id },
      { verb: "ticket.updated", payload: { i } },
    );
    allIds.push(ev.id);
    ticket5EventIds.push(ev.id);
  }

  // Ground truth, independently derived (not via the CLI): confirms the
  // fixture itself is internally consistent before any test trusts it.
  const onDisk = await listEvents(paths);
  expect(onDisk.map((e) => e.id)).toEqual(allIds);

  return {
    dir,
    paths,
    ticket1,
    ticket2,
    ticket5,
    session1Id: session1.id,
    session2Id: session2.id,
    allIds,
    ticket1EventIds,
    ticket5EventIds,
  };
}

// ---------------------------------------------------------------------------

describe("D3: events command", () => {
  describe("substantial event stream (162 events): pagination, --json, --limit, --ticket, cursor stability", () => {
    let fixture: SubstantialFixture;
    const PAGE_SIZE = 17; // deliberately not a divisor of 162 — exercises a partial last page

    beforeAll(async () => {
      fixture = await buildSubstantialFixture();
    }, 30_000);

    it("pages through the entire stream with no duplicates, no gaps, in ULID order", () => {
      const { pages, ids } = pageAll(fixture.dir, PAGE_SIZE);
      expect(ids).toEqual(fixture.allIds);
      expect(new Set(ids).size).toBe(fixture.allIds.length);
      // Every page except (possibly) the last is exactly PAGE_SIZE.
      for (const page of pages.slice(0, -1)) expect(page).toHaveLength(PAGE_SIZE);
      const lastPage = pages[pages.length - 1];
      expect(lastPage).toBeDefined();
      expect(lastPage?.length).toBe(fixture.allIds.length % PAGE_SIZE || PAGE_SIZE);
    });

    it('"cursor pagination stable across reindex" — two full passes, before and after deleting + rebuilding index.jsonc, produce byte-identical pages', () => {
      const before = pageAll(fixture.dir, PAGE_SIZE);
      expect(before.ids).toEqual(fixture.allIds);

      forceReindex(fixture.dir);

      const after = pageAll(fixture.dir, PAGE_SIZE);
      // Identical page boundaries, not just an identical flattened list.
      expect(after.pages).toEqual(before.pages);
      expect(after.ids).toEqual(before.ids);
    });

    it("interleaved: rebuilding the index mid-pagination doesn't affect the cursor obtained before it — concatenated result is exactly the full stream", () => {
      const collected: string[] = [];
      let cursor: string | undefined;
      let rebuiltMidway = false;

      for (let i = 0; i < 1000; i++) {
        const args = ["--limit", String(PAGE_SIZE)];
        if (cursor !== undefined) args.push("--since", cursor);
        const resp = runEventsJson(fixture.dir, args);
        collected.push(...resp.events.map((e) => e.id));
        cursor = resp.next_cursor ?? undefined;

        if (!rebuiltMidway && collected.length >= fixture.allIds.length / 2) {
          rebuiltMidway = true;
          forceReindex(fixture.dir); // "page halfway, rebuild the index mid-pagination, continue"
        }
        if (!resp.has_more) break;
      }

      expect(rebuiltMidway).toBe(true); // sanity: the rebuild genuinely happened mid-stream
      expect(collected).toEqual(fixture.allIds);
    });

    it("a cursor at the tip of the stream returns an empty page and echoes the same cursor back", () => {
      const last = fixture.allIds[fixture.allIds.length - 1];
      expect(last).toBeDefined();
      const resp = runEventsJson(fixture.dir, ["--since", last as string]);
      expect(resp.events).toEqual([]);
      expect(resp.next_cursor).toBe(last);
      expect(resp.has_more).toBe(false);
    });

    it("--json shape: events + query + count + next_cursor + has_more", () => {
      const limit = 10;
      const resp = runEventsJson(fixture.dir, ["--limit", String(limit)]);
      expect(resp.query).toEqual({
        since: null,
        ticket: null,
        limit,
        poll_cursor: null,
        cursor_mode: "static_snapshot",
      });
      expect(resp.events).toHaveLength(limit);
      expect(resp.count).toBe(limit);
      expect(resp.has_more).toBe(true);
      expect(resp.next_cursor).toBe(resp.events[resp.events.length - 1]?.id);
      expect(resp.next_cursor).toMatch(/^event_[0-9A-HJKMNP-TV-Z]{26}$/);
      // Every real Event field is present, unmodified.
      const first = resp.events[0];
      expect(first).toMatchObject({
        id: fixture.allIds[0],
        verb: "ticket.created",
        entity: { kind: "ticket", id: fixture.ticket1.id },
      });
      expect(first?.actor).toBeDefined();
      expect("session" in (first as object)).toBe(true);
      expect("payload" in (first as object)).toBe(true);
    });

    it("--limit caps the page size and reports has_more correctly at the boundary", () => {
      const exact = runEventsJson(fixture.dir, ["--limit", String(fixture.allIds.length)]);
      expect(exact.events).toHaveLength(fixture.allIds.length);
      expect(exact.has_more).toBe(false);

      const over = runEventsJson(fixture.dir, ["--limit", String(fixture.allIds.length + 5)]);
      expect(over.events).toHaveLength(fixture.allIds.length);
      expect(over.has_more).toBe(false);

      const under = runEventsJson(fixture.dir, ["--limit", "1"]);
      expect(under.events).toHaveLength(1);
      expect(under.has_more).toBe(true);
    });

    it("human output: one line per event with timestamp, verb, actor, entity ref, and session when present", () => {
      const result = runSlop(["events", "--limit", "1"], fixture.dir);
      expect(result.status, result.stderr).toBe(0);
      const line = result.stdout.trim();
      expect(line).toContain(fixture.allIds[0]);
      expect(line).toContain("ticket.created");
      expect(line).toContain(fixture.ticket1.id);
      // The first event (ticket1's `ticket.created`) ran outside any
      // session, so no `session:` fragment should appear on its line.
      expect(line).not.toContain("session:");
    });

    it("human output includes a session: fragment for an event that happened under a session", () => {
      const resp = runEventsJson(fixture.dir, ["--ticket", fixture.ticket1.id]);
      const planEvent = resp.events.find((e) => e.verb === "plan.set");
      expect(planEvent?.session).toBeTruthy();

      const result = runSlop(
        ["events", "--ticket", fixture.ticket1.id, "--since", fixture.ticket1EventIds[2] as string],
        fixture.dir,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`session:${planEvent?.session}`);
    });

    describe("--ticket (widened per D3's own decision — see events.ts's module doc)", () => {
      it("matches by full id, slug, and short prefix identically, and includes session-lifecycle/plan events for sessions under the ticket", () => {
        const shortPrefix = fixture.ticket1.id.slice("ticket_".length, "ticket_".length + 10);
        const byId = runEventsJson(fixture.dir, ["--ticket", fixture.ticket1.id]);
        const bySlug = runEventsJson(fixture.dir, ["--ticket", fixture.ticket1.slug]);
        const byPrefix = runEventsJson(fixture.dir, ["--ticket", shortPrefix]);

        for (const resp of [byId, bySlug, byPrefix]) {
          expect(resp.events.map((e) => e.id)).toEqual(fixture.ticket1EventIds);
          expect(resp.query.ticket).toBe(fixture.ticket1.id);
        }

        const verbs = byId.events.map((e) => e.verb);
        expect(verbs).toEqual([
          "ticket.created",
          "ticket.updated",
          "ticket.updated",
          "session.started",
          "plan.set",
          "session.ended",
        ]);
      });

      it("never leaks another ticket's own session events", () => {
        const resp = runEventsJson(fixture.dir, ["--ticket", fixture.ticket1.id]);
        expect(
          resp.events.some(
            (e) => e.entity.kind === "session" && e.entity.id === fixture.session2Id,
          ),
        ).toBe(false);
      });

      it("a same-millisecond burst is strictly, totally ordered — proven by paging a --ticket-scoped 151-event burst in small pages", () => {
        const expected = fixture.ticket5EventIds; // ticket.created + 150 ticket.updated, creation order
        expect(expected).toHaveLength(BURST_COUNT + 1);

        const { ids } = pageAll(fixture.dir, 23, ["--ticket", fixture.ticket5.id]);
        expect(ids).toEqual(expected);
        expect(new Set(ids).size).toBe(expected.length);
      });
    });
  });

  describe("empty result is not an error", () => {
    it("human path: exit 0, an explicit 'no events' line", async () => {
      const paths = await makeScratchRepo("slop-d3-empty-");
      const result = runSlop(["events"], paths.root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("no events");
    });

    it("--json path: exit 0, events: [], next_cursor: null, has_more: false", async () => {
      const paths = await makeScratchRepo("slop-d3-empty-json-");
      const resp = runEventsJson(paths.root);
      expect(resp.events).toEqual([]);
      expect(resp.count).toBe(0);
      expect(resp.next_cursor).toBeNull();
      expect(resp.has_more).toBe(false);
      // housekeeping-gitignore-lock-stale: `--limit` now always has an
      // EFFECTIVE value in the response — DEFAULT_EVENTS_LIMIT when the
      // flag was omitted, never `null` (see events.ts's module doc).
      expect(resp.query).toEqual({
        since: null,
        ticket: null,
        limit: DEFAULT_EVENTS_LIMIT,
        poll_cursor: null,
        cursor_mode: "static_snapshot",
      });
    });
  });

  describe("error paths", () => {
    it("malformed --since cursor -> exit 2 (USAGE_ERROR), not silently ignored", async () => {
      const paths = await makeScratchRepo("slop-d3-err-malformed-");
      // Baseline: without --since, this repo genuinely has one event.
      await createTicket(paths, makeTicket({ name: "Baseline" }), SETUP_CTX, {
        verb: "ticket.created",
      });

      const result = runSlop(["events", "--since", "not-a-cursor"], paths.root);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/--since/);
      expect(result.stdout).toBe(""); // never falls back to "return everything"
    });

    it("well-formed but unknown --since cursor -> exit 4 (NOT_FOUND)", async () => {
      const paths = await makeScratchRepo("slop-d3-err-unknown-cursor-");
      await createTicket(paths, makeTicket({ name: "Baseline" }), SETUP_CTX, {
        verb: "ticket.created",
      });
      const neverIssued = `event_${"Z".repeat(26)}`;

      const result = runSlop(["events", "--since", neverIssued], paths.root);
      expect(result.status).toBe(4);
      expect(result.stderr).toMatch(/no event found/i);
      expect(result.stdout).toBe("");
    });

    it("unknown --ticket ref -> exit 4 (NOT_FOUND)", async () => {
      const paths = await makeScratchRepo("slop-d3-err-unknown-ticket-");
      const result = runSlop(["events", "--ticket", "totally-unknown-ref-xyz"], paths.root);
      expect(result.status).toBe(4);
    });

    it("ambiguous short-prefix --ticket ref -> exit 5 (AMBIGUOUS_REF)", async () => {
      const paths = await makeScratchRepo("slop-d3-err-ambiguous-");
      const sharedBody = `01${"0".repeat(23)}`; // 25 chars, all valid Crockford-base32
      const idA = `ticket_${sharedBody}1`;
      const idB = `ticket_${sharedBody}2`;
      await createTicket(
        paths,
        makeTicket({ id: idA as TicketId, name: "Ambiguous A", slug: "ambiguous-a" }),
        SETUP_CTX,
        { verb: "ticket.created" },
      );
      await createTicket(
        paths,
        makeTicket({ id: idB as TicketId, name: "Ambiguous B", slug: "ambiguous-b" }),
        SETUP_CTX,
        { verb: "ticket.created" },
      );

      const result = runSlop(["events", "--ticket", sharedBody], paths.root);
      expect(result.status).toBe(5);
      expect(result.stderr).toMatch(/ambiguous/i);
    });
  });
});
