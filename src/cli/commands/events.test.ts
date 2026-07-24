import { describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import type { TicketId } from "../../core/index.js";
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

describe("runEvents (in-process)", () => {
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
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { events: { id: string }[] };
    expect(body.events.every((e) => e.id > cursor)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
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
