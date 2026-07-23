import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../core/clock.js";
import { type Ticket, newTicketId, ticketSchema, writeCanonical } from "../core/index.js";
import { INDEX_SCHEMA_VERSION, buildIndex, computeContentFingerprint, loadIndex, writeIndex } from "./db-index.js";
import type { EventContext, MutationEventSpec } from "./events.js";
import { ensureDbDirs } from "./paths.js";
import type { RepoPaths } from "./paths.js";
import { createTicket, ticketFilePath } from "./tickets.js";

// A4: createTicket now requires an EventContext + a MutationEventSpec —
// these fixtures don't exercise event behavior, so a single fixed pair is
// reused across every createTicket call below.
const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "Ticket",
    slug: `ticket-${id.slice(-8).toLowerCase()}`,
    spec: { summary: "s" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

let scratch: string;
let paths: RepoPaths;
const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-db-index-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("buildIndex", () => {
  it("produces an empty-but-valid index against a fresh, empty repo", async () => {
    const index = await buildIndex(paths, clock);
    expect(index.schema_version).toBe(INDEX_SCHEMA_VERSION);
    expect(index.built_at).toBe("2026-07-23T12:00:00.000Z");
    expect(index.tickets).toEqual([]);
    expect(index.slugs).toEqual({});
  });

  it("summarizes every ticket field the brief requires", async () => {
    const t = makeTicket({ priority: 1, labels: ["area:auth"], active_session: null });
    await createTicket(paths, t, ctx, createdEvent);
    const index = await buildIndex(paths, clock);
    expect(index.tickets).toHaveLength(1);
    const row = index.tickets[0];
    expect(row).toMatchObject({
      id: t.id,
      slug: t.slug,
      name: t.name,
      state: t.state,
      priority: t.priority,
      parent: null,
      root_id: t.root_id,
      path: t.path,
      labels: t.labels,
      last_activity_at: t.last_activity_at,
      active_session: null,
    });
  });

  it("maps slugs to ids", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    const index = await buildIndex(paths, clock);
    expect(index.slugs[t.slug]).toBe(t.id);
  });

  it("leaves B4/C5 placeholder fields present but null", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    const index = await buildIndex(paths, clock);
    const row = index.tickets[0];
    expect(row).toBeDefined();
    expect(row?.blocked_count).toBeNull();
    expect(row?.ready).toBeNull();
    expect(row?.stale).toBeNull();
    expect(row?.review_stale).toBeNull();
  });

  it("derives reverse edges: blocked_by, related_from, discovered from forward fields on OTHER tickets", async () => {
    const target = makeTicket();
    const blocker = makeTicket({ blocks: [target.id] });
    const relater = makeTicket({ relates_to: [target.id] });
    const discoverer = makeTicket({ discovered_from: [target.id] });
    await createTicket(paths, target, ctx, createdEvent);
    await createTicket(paths, blocker, ctx, createdEvent);
    await createTicket(paths, relater, ctx, createdEvent);
    await createTicket(paths, discoverer, ctx, createdEvent);

    const index = await buildIndex(paths, clock);
    const targetRow = index.tickets.find((r) => r.id === target.id);
    expect(targetRow?.blocked_by).toEqual([blocker.id]);
    expect(targetRow?.related_from).toEqual([relater.id]);
    expect(targetRow?.discovered).toEqual([discoverer.id]);

    // And the forward-only side has no reverse debris of its own.
    const blockerRow = index.tickets.find((r) => r.id === blocker.id);
    expect(blockerRow?.blocked_by).toEqual([]);
  });

  it("does not choke on a ticket whose parent is an external (jira:) ref", async () => {
    const t = makeTicket({ parent: "jira:PROJ-1" });
    await createTicket(paths, t, ctx, createdEvent);
    const index = await buildIndex(paths, clock);
    expect(index.tickets[0]?.parent).toBe("jira:PROJ-1");
  });
});

describe("writeIndex / loadIndex — fresh read", () => {
  it("loadIndex reads back exactly what writeIndex wrote when nothing has changed", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    const built = await buildIndex(paths, clock);
    await writeIndex(paths, built);

    const result = await loadIndex(paths, clock);
    expect(result.rebuilt).toBe(false);
    expect(result.reason).toBe("fresh");
    expect(result.index).toEqual(built);
  });
});

describe("loadIndex — auto-heal (A3 acceptance: 'deleted index self-heals')", () => {
  it("rebuilds transparently when index.jsonc is missing entirely", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    // No index.jsonc ever written — simulates both an `rm` and a fresh
    // gitignored clone.
    const result = await loadIndex(paths, clock);
    expect(result.rebuilt).toBe(true);
    expect(result.reason).toBe("missing");
    expect(result.index.tickets.map((r) => r.id)).toEqual([t.id]);

    // And the rebuild was persisted, not just returned in memory.
    const raw = await readFile(paths.indexFile, "utf8");
    expect(raw).toContain(t.id);
  });

  it("rebuilds transparently when index.jsonc is corrupt/truncated JSONC", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    await writeFile(paths.indexFile, '{ "schema_version": 1, "tickets": [ this is not json');

    const result = await loadIndex(paths, clock);
    expect(result.rebuilt).toBe(true);
    expect(result.reason).toBe("parse_error");
    expect(result.index.tickets.map((r) => r.id)).toEqual([t.id]);
  });

  it("rebuilds transparently when index.jsonc has a stale schema_version", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    await writeFile(
      paths.indexFile,
      `${JSON.stringify({ schema_version: 999, built_at: clock.now().toISOString(), tickets: [], slugs: {} }, null, 2)}\n`,
    );

    const result = await loadIndex(paths, clock);
    expect(result.rebuilt).toBe(true);
    expect(result.reason).toBe("stale_schema_version");
    expect(result.index.schema_version).toBe(INDEX_SCHEMA_VERSION);
  });

  it("rebuilds transparently when index.jsonc parses but fails schema validation", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    await writeFile(
      paths.indexFile,
      `${JSON.stringify({ schema_version: INDEX_SCHEMA_VERSION, tickets: "not an array" }, null, 2)}\n`,
    );

    const result = await loadIndex(paths, clock);
    expect(result.rebuilt).toBe(true);
    expect(result.reason).toBe("invalid_schema");
    expect(result.index.tickets.map((r) => r.id)).toEqual([t.id]);
  });

  it("never throws for any of the above — always returns a valid index", async () => {
    await writeFile(paths.indexFile, "not even close to json {{{");
    await expect(loadIndex(paths, clock)).resolves.toBeDefined();
  });
});

describe("computeContentFingerprint", () => {
  it("is {count:0, max_mtime_ms:0} for an empty tickets dir", async () => {
    const fp = await computeContentFingerprint(paths);
    expect(fp.tickets).toEqual({ count: 0, max_mtime_ms: 0 });
  });

  it("counts only real ticket entity files, ignoring temp/other debris", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    await writeFile(join(paths.ticketsDir, ".tmp-abc-ticket_x.jsonc"), "partial");
    await writeFile(join(paths.ticketsDir, "not-a-ticket.txt"), "x");

    const fp = await computeContentFingerprint(paths);
    expect(fp.tickets).toEqual({ count: 1, max_mtime_ms: expect.any(Number) });
    expect(fp.tickets?.max_mtime_ms).toBeGreaterThan(0);
  });

  it("is readdir+stat only — never reads or parses file content (spot check: garbage content doesn't throw)", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    await writeFile(ticketFilePath(paths, t.id), "{ not even valid jsonc {{{");
    await expect(computeContentFingerprint(paths)).resolves.toEqual({
      tickets: { count: 1, max_mtime_ms: expect.any(Number) },
    });
  });
});

describe("loadIndex — content staleness (coordinator ruling: healing from staleness is the same 'self-heals' requirement)", () => {
  // These mirror tests/acceptance/A3.test.ts's acceptance-level versions
  // at the unit level: entity files change with NO slop command
  // involved at all (git merge/pull, $EDITOR), which the missing/
  // corrupt/stale-schema-version checks alone cannot catch, because the
  // index on disk is perfectly valid JSON at the current schema version
  // — just no longer accurate.

  it("detects a ticket file edited directly on disk (same count, different content/mtime)", async () => {
    const t = makeTicket({ name: "Before" });
    await createTicket(paths, t, ctx, createdEvent);
    const first = await loadIndex(paths, clock);
    expect(first.index.tickets[0]?.name).toBe("Before");

    await sleep(20); // real margin past mtime resolution — see db-index.ts's documented limitation
    const path = ticketFilePath(paths, t.id);
    await writeFile(path, (await readFile(path, "utf8")).replace("Before", "After"));

    const second = await loadIndex(paths, clock);
    expect(second.rebuilt).toBe(true);
    expect(second.reason).toBe("stale_content");
    expect(second.index.tickets[0]?.name).toBe("After");
  });

  it("detects a ticket file added directly on disk", async () => {
    const t1 = makeTicket();
    await createTicket(paths, t1, ctx, createdEvent);
    await loadIndex(paths, clock);

    await sleep(20);
    const t2 = makeTicket();
    await writeFile(ticketFilePath(paths, t2.id), writeCanonical(t2));

    const result = await loadIndex(paths, clock);
    expect(result.rebuilt).toBe(true);
    expect(result.reason).toBe("stale_content");
    expect(result.index.tickets.map((r) => r.id).sort()).toEqual([t1.id, t2.id].sort());
  });

  it("detects a ticket file deleted directly on disk", async () => {
    const t1 = makeTicket();
    const t2 = makeTicket();
    await createTicket(paths, t1, ctx, createdEvent);
    await createTicket(paths, t2, ctx, createdEvent);
    await loadIndex(paths, clock);

    await sleep(20);
    await rm(ticketFilePath(paths, t2.id));

    const result = await loadIndex(paths, clock);
    expect(result.rebuilt).toBe(true);
    expect(result.reason).toBe("stale_content");
    expect(result.index.tickets.map((r) => r.id)).toEqual([t1.id]);
  });

  it("does NOT rebuild when nothing changed — the fingerprint match short-circuits", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    const first = await loadIndex(paths, clock);
    expect(first.rebuilt).toBe(true);

    const second = await loadIndex(paths, clock);
    expect(second.rebuilt).toBe(false);
    expect(second.reason).toBe("fresh");
    expect(second.index).toEqual(first.index);
  });
});
