import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import { eventSchema, type Event, type TicketId } from "../../core/index.js";
import { createEvent, ensureDbDirs, eventShardMonth, type RepoPaths } from "../../repo/index.js";
import { DEFAULT_EVENTS_LIMIT, runEvents } from "./events.js";
import { runNew } from "./new.js";
import { runStart } from "./start.js";

// In-process coverage of `runEvents` (real v8 coverage, no subprocess).

async function jsonNewTicket(root: string, name: string): Promise<TicketId> {
  const out = captureOutput();
  try {
    await withCwd(root, () =>
      runNew(name, {
        blocks: [],
        relatesTo: [],
        label: [],
        acceptance: [],
        context: [],
        json: true,
      }),
    );
    return (JSON.parse(out.stdout()) as { id: TicketId }).id;
  } finally {
    out.restore();
  }
}

function eventAt(atMs: number, suffix = ""): Event {
  return eventSchema.parse({
    id: `event_${ulid(atMs)}`,
    actor: { name: `producer${suffix}`, kind: "agent" },
    session: null,
    verb: "ticket.updated",
    entity: { kind: "ticket", id: `ticket-merged${suffix}` },
    payload: { progress: `merged${suffix}` },
    at: new Date(atMs).toISOString(),
  });
}

async function pollJson(
  root: string,
  poll: true | string,
  limit = 100,
): Promise<{
  events: Event[];
  poll_cursor: string;
  next_cursor: null;
  has_more: boolean;
}> {
  const out = captureOutput();
  try {
    await withCwd(root, () => runEvents({ poll, limit, json: true }));
    return JSON.parse(out.stdout());
  } finally {
    out.restore();
  }
}

async function mergeEventFile(source: RepoPaths, target: RepoPaths, event: Event): Promise<void> {
  const shard = eventShardMonth(event.id);
  await mkdir(join(target.eventsDir, shard), { recursive: true });
  await copyFile(
    join(source.eventsDir, shard, `${event.id}.jsonc`),
    join(target.eventsDir, shard, `${event.id}.jsonc`),
  );
}

describe("runEvents (in-process)", () => {
  it("a two-clone late merge with an older ULID is discovered after an empty checkpoint", async () => {
    const cloneA = await makeTempRepo("slop-events-poll-clone-a-");
    const cloneB = await makeTempRepo("slop-events-poll-clone-b-");
    await bootstrapRepo(cloneA, { project: "p", user: "ryan" });
    await bootstrapRepo(cloneB, { project: "p", user: "ryan" });
    const first = await pollJson(cloneA, true);
    expect(first.events).toEqual([]);

    const late = eventAt(Date.UTC(2020, 0, 1), "-clone-b");
    const cloneBPaths = await ensureDbDirs(cloneB);
    const cloneAPaths = await ensureDbDirs(cloneA);
    await createEvent(cloneBPaths, late);
    // Copying the immutable event file models the material effect of Git
    // merging clone B after clone A checkpointed an empty event set.
    await mergeEventFile(cloneBPaths, cloneAPaths, late);

    const next = await pollJson(cloneA, first.poll_cursor);
    expect(next.events.map((event) => event.id)).toEqual([late.id]);
    expect(next.poll_cursor).toBe(first.poll_cursor);
    expect(next.next_cursor).toBeNull();
  });

  it("continues limited pages without gaps or duplicates and advances only returned ids", async () => {
    const root = await makeTempRepo("slop-events-poll-pages-");
    const producerA = await makeTempRepo("slop-events-poll-producer-a-");
    const producerB = await makeTempRepo("slop-events-poll-producer-b-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await bootstrapRepo(producerA, { project: "p", user: "ryan" });
    await bootstrapRepo(producerB, { project: "p", user: "ryan" });
    const paths = await ensureDbDirs(root);
    const producerAPaths = await ensureDbDirs(producerA);
    const producerBPaths = await ensureDbDirs(producerB);
    const events = [eventAt(1_000, "-a"), eventAt(1_000, "-b"), eventAt(500, "-rollback")];
    await createEvent(producerAPaths, events[0]!);
    await createEvent(producerBPaths, events[1]!);
    await createEvent(producerBPaths, events[2]!);
    for (const event of [events[0]!]) await mergeEventFile(producerAPaths, paths, event);
    for (const event of [events[1]!, events[2]!]) {
      await mergeEventFile(producerBPaths, paths, event);
    }

    let page = await pollJson(root, true, 1);
    const cursor = page.poll_cursor;
    const returned = [...page.events];
    expect(page.has_more).toBe(true);
    while (page.has_more) {
      page = await pollJson(root, cursor, 1);
      returned.push(...page.events);
    }
    expect(returned.map((event) => event.id).sort()).toEqual(
      events.map((event) => event.id).sort(),
    );
    expect(new Set(returned.map((event) => event.id)).size).toBe(3);
    expect((await pollJson(root, cursor, 1)).events).toEqual([]);
  });

  it("does not checkpoint an event elided by the output budget", async () => {
    const root = await makeTempRepo("slop-events-poll-budget-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const event = eventAt(2_000, "-budget");
    await createEvent(await ensureDbDirs(root), event);

    const out = captureOutput();
    let cursor!: string;
    try {
      await withCwd(root, () => runEvents({ poll: true, json: true, budget: 1 }));
      const body = JSON.parse(out.stdout()) as { events: Event[]; poll_cursor: string };
      expect(body.events).toEqual([]);
      cursor = body.poll_cursor;
    } finally {
      out.restore();
    }
    expect((await pollJson(root, cursor)).events.map((item) => item.id)).toEqual([event.id]);
  });

  it("rejects malformed/unknown poll tokens and forbids mixing polling with scalar since", async () => {
    const root = await makeTempRepo("slop-events-poll-validation-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await expect(withCwd(root, () => runEvents({ poll: "bad" }))).rejects.toMatchObject({
      exitCode: EXIT_CODES.USAGE_ERROR,
    });
    await expect(
      withCwd(root, () => runEvents({ poll: "cursor_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
    await expect(
      withCwd(root, () =>
        runEvents({
          poll: "cursor_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          since: "event_01AAAAAAAAAAAAAAAAAAAAAAAA",
        }),
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.USAGE_ERROR });
  });
  it("lists every event, human text, in chronological order", async () => {
    const root = await makeTempRepo("slop-events-inproc-human-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Eventful ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runEvents({}));
      expect(out.stdout()).toContain("ticket.created");
      expect(out.stdout()).toContain(id);
    } finally {
      out.restore();
    }
  });

  it("--json includes query/events/count/next_cursor/has_more/elided", async () => {
    const root = await makeTempRepo("slop-events-inproc-json-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await jsonNewTicket(root, "Json events ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runEvents({ json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      events: { verb: string }[];
      count: number;
      next_cursor: string | null;
      has_more: boolean;
      elided: string[];
    };
    expect(body.count).toBe(body.events.length);
    expect(body.events.some((e) => e.verb === "ticket.created")).toBe(true);
    expect(body.has_more).toBe(false);
    expect(body.elided).toEqual([]);
  });

  it("--ticket <ref> scopes to that ticket's events, AND widens to include its sessions' events", async () => {
    const root = await makeTempRepo("slop-events-inproc-ticket-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const target = await jsonNewTicket(root, "Scoped ticket");
    await jsonNewTicket(root, "Other ticket");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(target, {}));
    } finally {
      startOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runEvents({ ticket: target, json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      events: { verb: string; entity: { kind: string; id: string } }[];
    };
    // Every ticket.* event is for the target only...
    for (const e of body.events) {
      if (e.entity.kind === "ticket") expect(e.entity.id).toBe(target);
    }
    // ...and the widened session.started event for its session is included too.
    expect(body.events.some((e) => e.verb === "session.started")).toBe(true);
  });

  it("--limit caps the page and sets has_more/next_cursor", async () => {
    const root = await makeTempRepo("slop-events-inproc-limit-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await jsonNewTicket(root, "Ticket one");
    await jsonNewTicket(root, "Ticket two");
    await jsonNewTicket(root, "Ticket three");

    const out = captureOutput();
    try {
      await withCwd(root, () => runEvents({ json: true, limit: 1 }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      events: unknown[];
      has_more: boolean;
      next_cursor: string | null;
    };
    expect(body.events).toHaveLength(1);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).not.toBeNull();
  });

  it("--since <cursor> pages past events already seen", async () => {
    const root = await makeTempRepo("slop-events-inproc-since-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await jsonNewTicket(root, "First ticket");

    const firstPage = captureOutput();
    let cursor: string;
    try {
      await withCwd(root, () => runEvents({ json: true, limit: 1 }));
      cursor = (JSON.parse(firstPage.stdout()) as { next_cursor: string }).next_cursor;
    } finally {
      firstPage.restore();
    }

    await jsonNewTicket(root, "Second ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runEvents({ json: true, since: cursor }));
      expect(out.stderr()).toContain("static-snapshot pagination");
      expect(out.stderr()).toContain("use --poll");
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { events: { id: string }[] };
    expect(body.events.every((e) => e.id > cursor)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
  });

  it("keeps --since backward compatible while making its late-merge limitation explicit", async () => {
    const root = await makeTempRepo("slop-events-inproc-since-static-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const paths = await ensureDbDirs(root);
    const high = eventAt(Date.UTC(2025, 0, 1), "-high");
    const lateOld = eventAt(Date.UTC(2020, 0, 1), "-late-old");
    await createEvent(paths, high);

    const out = captureOutput();
    try {
      await createEvent(paths, lateOld);
      await withCwd(root, () => runEvents({ json: true, since: high.id }));
      const body = JSON.parse(out.stdout()) as { events: Event[]; query: { cursor_mode: string } };
      expect(body.events).toEqual([]);
      expect(body.query.cursor_mode).toBe("static_snapshot");
      expect(out.stderr()).toContain("can miss events merged later with older ids");
    } finally {
      out.restore();
    }
  });

  it("rejects a malformed --since cursor (USAGE_ERROR, exit 2)", async () => {
    const root = await makeTempRepo("slop-events-inproc-badsince-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    await expect(withCwd(root, () => runEvents({ since: "not-a-cursor" }))).rejects.toMatchObject({
      exitCode: EXIT_CODES.USAGE_ERROR,
    });
  });

  it("rejects a well-formed but unknown --since cursor (NOT_FOUND, exit 4)", async () => {
    const root = await makeTempRepo("slop-events-inproc-unknownsince-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    await expect(
      withCwd(root, () => runEvents({ since: "event_01AAAAAAAAAAAAAAAAAAAAAAAA" })),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
  });

  it("throws NOT_FOUND for an unresolvable --ticket ref", async () => {
    const root = await makeTempRepo("slop-events-inproc-badticket-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    await expect(
      withCwd(root, () => runEvents({ ticket: "no-such-ticket" })),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
  });

  it("--budget bounds output without corrupting --json", async () => {
    const root = await makeTempRepo("slop-events-inproc-budget-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await jsonNewTicket(root, "Budgeted events ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runEvents({ json: true, budget: 1 }));
    } finally {
      out.restore();
    }
    expect(() => JSON.parse(out.stdout())).not.toThrow();
  });

  it("empty repo: human output says 'no events'", async () => {
    const root = await makeTempRepo("slop-events-inproc-empty-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    const out = captureOutput();
    try {
      await withCwd(root, () => runEvents({}));
      expect(out.stdout()).toContain("no events");
    } finally {
      out.restore();
    }
  });

  // ---------------------------------------------------------------------------
  // Regression: ticket housekeeping-gitignore-lock-stale — `--limit`
  // defaults to DEFAULT_EVENTS_LIMIT when omitted (was previously
  // unbounded), and `has_more`/`next_cursor` must never combine into a
  // stuck page (has_more: true with a cursor that can't advance).
  // ---------------------------------------------------------------------------

  it("defaults --limit to DEFAULT_EVENTS_LIMIT when omitted, with a usable next_cursor once there's more", async () => {
    const root = await makeTempRepo("slop-events-inproc-defaultlimit-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const count = DEFAULT_EVENTS_LIMIT + 5;
    for (let i = 0; i < count; i++) {
      await jsonNewTicket(root, `Ticket ${i}`);
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runEvents({ json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      query: { limit: number };
      events: unknown[];
      has_more: boolean;
      next_cursor: string | null;
    };
    expect(body.query.limit).toBe(DEFAULT_EVENTS_LIMIT);
    expect(body.events).toHaveLength(DEFAULT_EVENTS_LIMIT);
    expect(body.has_more).toBe(true);
    // has_more: true is only ever honest alongside a next_cursor the
    // caller can actually page with — see events.ts's pageFor doc.
    expect(body.next_cursor).not.toBeNull();
  });

  it("--limit explicitly given still overrides the default", async () => {
    const root = await makeTempRepo("slop-events-inproc-limitoverride-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await jsonNewTicket(root, "One ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runEvents({ json: true, limit: 5 }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { query: { limit: number } };
    expect(body.query.limit).toBe(5);
  });

  it("has_more is never true with a next_cursor that can't advance — a budget too small to fit even one event elides everything honestly (has_more: false)", async () => {
    const root = await makeTempRepo("slop-events-inproc-stuckcursor-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await jsonNewTicket(root, "Ticket for a starving budget");

    const out = captureOutput();
    try {
      await withCwd(root, () => runEvents({ json: true, budget: 1 }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      events: unknown[];
      has_more: boolean;
      next_cursor: string | null;
      elided: string[];
    };
    // A 1-character budget can't fit even a single event's rendering, so
    // everything is elided from the page.
    expect(body.events).toEqual([]);
    // The degenerate bug this closes: has_more: true paired with a cursor
    // that doesn't move (null here, since no --since was given) would
    // leave a caller stuck retrying the exact same non-progressing query
    // forever. Honest instead: has_more: false, and `elided` already
    // names the real fix (raise --budget).
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
    expect(body.elided.length).toBeGreaterThan(0);
  });
});
