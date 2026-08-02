import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";
import { fixedClock } from "../core/clock.js";
import {
  type Event,
  type Ticket,
  eventSchema,
  newSessionId,
  newTicketId,
  ticketSchema,
  writeCanonical,
} from "../core/index.js";
import {
  INDEX_SCHEMA_VERSION,
  buildIndex,
  computeBlockedCounts,
  computeContentFingerprint,
  computeReady,
  formatIndexProblems,
  isLiveBlockerState,
  loadIndex,
  writeIndex,
} from "./db-index.js";
import { appendEvent, createEvent, eventShardMonth } from "./events.js";
import type { EventContext, MutationEventSpec } from "./events.js";
import { ensureDbDirs } from "./paths.js";
import type { RepoPaths } from "./paths.js";
import { createTicket, readTicket, ticketFilePath, updateTicket } from "./tickets.js";

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

/**
 * G2 (shard-event-storage): a full, valid `Event` whose id's OWN embedded
 * ULID timestamp is `atMs` — NOT "now". `core/ids.ts`'s `newEventId`
 * always mints against the real wall clock (it has no seed-time
 * parameter), so it's useless for deliberately landing an event in an
 * arbitrary/old shard month; this instead mints the raw ULID body
 * directly via the `ulid` package's own seed-time overload (`ulid(atMs)`,
 * distinct from `core/ids.ts`'s shared monotonic factory) and assembles
 * a schema-valid `Event` around it, so tests can exercise
 * {@link computeContentFingerprint}'s per-shard behavior against two
 * (or more) deliberately-different months without depending on which
 * month the test happens to actually run in.
 */
function makeEventAt(atMs: number, overrides: Partial<Event> = {}): Event {
  return eventSchema.parse({
    id: `event_${ulid(atMs)}`,
    actor: { name: "ryan", kind: "human" },
    session: null,
    verb: "ticket.created",
    entity: { kind: "ticket", id: newTicketId() },
    at: new Date(atMs).toISOString(),
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

  it("computes blocked_count/ready for real (B4); an open ticket has neither deadline (C5)", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    const index = await buildIndex(paths, clock);
    const row = index.tickets[0];
    expect(row).toBeDefined();
    // A lone open ticket with no blockers and no active session: 0 live
    // blockers, and per design.md §2 it's therefore ready.
    expect(row?.blocked_count).toBe(0);
    expect(row?.ready).toBe(true);
    // Neither in_progress nor review — no deadline applies.
    expect(row?.stale_at).toBeNull();
    expect(row?.review_stale_at).toBeNull();
  });

  describe("C5: stale_at / review_stale_at", () => {
    it("in_progress: stale_at = last_activity_at + config's stale_after (default 60m); review_stale_at null", async () => {
      const t = makeTicket({ state: "in_progress", last_activity_at: "2026-07-23T10:00:00.000Z" });
      await createTicket(paths, t, ctx, createdEvent);
      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === t.id);
      expect(row?.stale_at).toBe("2026-07-23T11:00:00.000Z"); // +60m, the schema default
      expect(row?.review_stale_at).toBeNull();
    });

    it("review: review_stale_at = review.requested_at + config's review_stale_after (default 24h); stale_at null", async () => {
      const t = makeTicket({
        state: "review",
        review: { requested_at: "2026-07-22T10:00:00.000Z", by: { name: "ryan", kind: "human" } },
      });
      await createTicket(paths, t, ctx, createdEvent);
      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === t.id);
      expect(row?.review_stale_at).toBe("2026-07-23T10:00:00.000Z"); // +24h, the schema default
      expect(row?.stale_at).toBeNull();
    });

    it("review_stale_at anchors on review.requested_at, NOT the ticket's (later) last_activity_at", async () => {
      const t = makeTicket({
        state: "review",
        last_activity_at: "2026-07-23T09:00:00.000Z", // a later, unrelated activity bump
        review: { requested_at: "2026-07-22T10:00:00.000Z", by: { name: "ryan", kind: "human" } },
      });
      await createTicket(paths, t, ctx, createdEvent);
      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === t.id);
      expect(row?.review_stale_at).toBe("2026-07-23T10:00:00.000Z"); // anchored on requested_at
    });

    it("reads the REAL configured thresholds from config.yaml, not just the schema defaults", async () => {
      await writeFile(
        join(paths.slopDir, "config.yaml"),
        "project: x\ndefaults:\n  stale_after: 30m\n  review_stale_after: 12h\n",
        "utf8",
      );
      const t = makeTicket({ state: "in_progress", last_activity_at: "2026-07-23T10:00:00.000Z" });
      await createTicket(paths, t, ctx, createdEvent);
      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === t.id);
      expect(row?.stale_at).toBe("2026-07-23T10:30:00.000Z"); // +30m, not the 60m default
    });

    it("an absurdly huge stale_after doesn't crash buildIndex, clamps to null, and warns on stderr (regression: ticket duration-huge-stale-after-overflows)", async () => {
      await writeFile(
        join(paths.slopDir, "config.yaml"),
        "project: x\ndefaults:\n  stale_after: 99999999999d\n  review_stale_after: 24h\n",
        "utf8",
      );
      const t = makeTicket({ state: "in_progress", last_activity_at: "2026-07-23T10:00:00.000Z" });
      await createTicket(paths, t, ctx, createdEvent);

      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const index = await buildIndex(paths, clock);
        const row = index.tickets.find((r) => r.id === t.id);
        // Staleness disabled, not a crash.
        expect(row?.stale_at).toBeNull();
        // But not silent — the absurd config value gets flagged.
        const warned = stderrSpy.mock.calls.some((call) =>
          String(call[0]).includes("defaults.stale_after"),
        );
        expect(warned).toBe(true);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("a huge review_stale_after doesn't crash buildIndex and clamps to null for a review ticket", async () => {
      await writeFile(
        join(paths.slopDir, "config.yaml"),
        "project: x\ndefaults:\n  stale_after: 60m\n  review_stale_after: 99999999999d\n",
        "utf8",
      );
      const t = makeTicket({
        state: "review",
        review: { requested_at: "2026-07-22T10:00:00.000Z", by: { name: "ryan", kind: "human" } },
      });
      await createTicket(paths, t, ctx, createdEvent);

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === t.id);
      expect(row?.review_stale_at).toBeNull();
    });

    it("open/draft/done/dropped tickets never carry a deadline", async () => {
      const states = ["draft", "open", "done", "dropped"] as const;
      for (const state of states) {
        const t = makeTicket({ state, last_activity_at: "2026-07-23T10:00:00.000Z" });
        await createTicket(paths, t, ctx, createdEvent);
      }
      const index = await buildIndex(paths, clock);
      for (const row of index.tickets) {
        expect(row.stale_at, `state=${row.state}`).toBeNull();
        expect(row.review_stale_at, `state=${row.state}`).toBeNull();
      }
    });

    it("PROOF the deadline is a stable, content-derived value: rebuilding at two different 'now's leaves stale_at unchanged", async () => {
      const t = makeTicket({ state: "in_progress", last_activity_at: "2026-07-23T10:00:00.000Z" });
      await createTicket(paths, t, ctx, createdEvent);

      const earlyClock = fixedClock(new Date("2026-07-23T10:05:00.000Z")); // before the deadline
      const lateClock = fixedClock(new Date("2026-07-25T10:05:00.000Z")); // long after the deadline

      const earlyIndex = await buildIndex(paths, earlyClock);
      const lateIndex = await buildIndex(paths, lateClock);

      const earlyRow = earlyIndex.tickets.find((r) => r.id === t.id);
      const lateRow = lateIndex.tickets.find((r) => r.id === t.id);
      // The clock the index was BUILT with never affects the stored
      // deadline — only ticket content (last_activity_at) and config do.
      expect(earlyRow?.stale_at).toBe(lateRow?.stale_at);
      expect(earlyRow?.stale_at).toBe("2026-07-23T11:00:00.000Z");
      // built_at is the only thing that legitimately differs.
      expect(earlyIndex.built_at).not.toBe(lateIndex.built_at);
    });
  });

  describe("ticket_01KY9RWFM80BKNE2CDX85QMKGS: latest_note/last_activity_at are EFFECTIVE (derived from events)", () => {
    it("a lock-free `ticket.updated` progress event (no accompanying ticket write) becomes the row's latest_note/last_activity_at", async () => {
      const t = makeTicket({
        latest_note: null,
        last_activity_at: "2026-07-23T10:00:00.000Z",
      });
      await createTicket(paths, t, ctx, createdEvent);

      // Simulate a lock-free `update --progress` call: an event, with NO
      // accompanying ticket-file write — exactly what
      // src/cli/commands/update.ts's `appendEvent` call does.
      await appendEvent(
        paths,
        ctx,
        { kind: "ticket", id: t.id },
        { verb: "ticket.updated", payload: { progress: "lock-free note" } },
        fixedClock(new Date("2026-07-23T11:00:00.000Z")),
      );

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === t.id);
      expect(row?.latest_note).toBe("lock-free note");
      expect(row?.last_activity_at).toBe("2026-07-23T11:00:00.000Z");

      // The ticket FILE itself was never touched.
      const onDisk = await readTicket(paths, t.id);
      expect(onDisk.latest_note).toBeNull();
      expect(onDisk.last_activity_at).toBe("2026-07-23T10:00:00.000Z");
    });

    it("the LATEST of several progress events wins, regardless of listing order", async () => {
      const t = makeTicket({ latest_note: null, last_activity_at: "2026-07-23T10:00:00.000Z" });
      await createTicket(paths, t, ctx, createdEvent);

      await appendEvent(
        paths,
        ctx,
        { kind: "ticket", id: t.id },
        { verb: "ticket.updated", payload: { progress: "first" } },
        fixedClock(new Date("2026-07-23T10:30:00.000Z")),
      );
      await appendEvent(
        paths,
        ctx,
        { kind: "ticket", id: t.id },
        { verb: "ticket.updated", payload: { progress: "second, and latest" } },
        fixedClock(new Date("2026-07-23T11:30:00.000Z")),
      );

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === t.id);
      expect(row?.latest_note).toBe("second, and latest");
      expect(row?.last_activity_at).toBe("2026-07-23T11:30:00.000Z");
    });

    it("a locked update's OWN accompanying progress event never overrides its stored baseline (single-writer output is unaffected)", async () => {
      const t = makeTicket({
        latest_note: "old note",
        last_activity_at: "2026-07-23T10:00:00.000Z",
      });
      await createTicket(paths, t, ctx, createdEvent);

      // Mirrors what a LOCKED `update --progress --priority 0` does: the
      // ticket write and its event share one clock reading.
      const sharedClock = fixedClock(new Date("2026-07-23T10:30:00.000Z"));
      const locked: Ticket = { ...t, priority: 0, latest_note: "locked note" };
      await updateTicket(
        paths,
        t.id,
        [
          { path: ["priority"], value: 0 },
          { path: ["latest_note"], value: "locked note" },
        ],
        locked,
        ctx,
        { verb: "ticket.updated", payload: { progress: "locked note" } },
        sharedClock,
      );

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === t.id);
      expect(row?.latest_note).toBe("locked note");
      expect(row?.last_activity_at).toBe("2026-07-23T10:30:00.000Z");
    });

    it("an event for a DIFFERENT ticket never leaks into this ticket's overlay", async () => {
      const t1 = makeTicket({ latest_note: null, last_activity_at: "2026-07-23T10:00:00.000Z" });
      const t2 = makeTicket({ latest_note: null, last_activity_at: "2026-07-23T10:00:00.000Z" });
      await createTicket(paths, t1, ctx, createdEvent);
      await createTicket(paths, t2, ctx, createdEvent);

      await appendEvent(
        paths,
        ctx,
        { kind: "ticket", id: t2.id },
        { verb: "ticket.updated", payload: { progress: "for t2 only" } },
        fixedClock(new Date("2026-07-23T11:00:00.000Z")),
      );

      const index = await buildIndex(paths, clock);
      const row1 = index.tickets.find((r) => r.id === t1.id);
      expect(row1?.latest_note).toBeNull();
      expect(row1?.last_activity_at).toBe("2026-07-23T10:00:00.000Z");
    });

    it("a lock-free progress event resets stale_at exactly like a locked activity bump always has", async () => {
      const t = makeTicket({
        state: "in_progress",
        last_activity_at: "2026-07-23T09:00:00.000Z", // already past the 60m default -> would be stale
      });
      await createTicket(paths, t, ctx, createdEvent);

      const staleBefore = await buildIndex(paths, clock);
      const rowBefore = staleBefore.tickets.find((r) => r.id === t.id);
      expect(rowBefore?.stale_at).toBe("2026-07-23T10:00:00.000Z"); // already in the past relative to `clock`

      // A lock-free progress note IS activity — it must push the deadline
      // out, exactly like `--progress` always has.
      await appendEvent(
        paths,
        ctx,
        { kind: "ticket", id: t.id },
        { verb: "ticket.updated", payload: { progress: "still working on it" } },
        fixedClock(new Date("2026-07-23T11:55:00.000Z")),
      );

      const staleAfter = await buildIndex(paths, clock);
      const rowAfter = staleAfter.tickets.find((r) => r.id === t.id);
      expect(rowAfter?.stale_at).toBe("2026-07-23T12:55:00.000Z"); // +60m from the NEW activity
    });

    it("a non-progress event (e.g. plan.set) never affects latest_note/last_activity_at", async () => {
      const t = makeTicket({
        latest_note: "unchanged",
        last_activity_at: "2026-07-23T10:00:00.000Z",
      });
      await createTicket(paths, t, ctx, createdEvent);

      await appendEvent(
        paths,
        ctx,
        { kind: "ticket", id: t.id },
        { verb: "plan.set", payload: {} },
        fixedClock(new Date("2026-07-23T12:00:00.000Z")),
      );

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === t.id);
      expect(row?.latest_note).toBe("unchanged");
      expect(row?.last_activity_at).toBe("2026-07-23T10:00:00.000Z");
    });
  });

  describe("B4: blocked_count / ready", () => {
    it("counts an open blocker as live: blocked_count 1, ready false", async () => {
      const target = makeTicket();
      const blocker = makeTicket({ blocks: [target.id] });
      await createTicket(paths, target, ctx, createdEvent);
      await createTicket(paths, blocker, ctx, createdEvent);

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === target.id);
      expect(row?.blocked_count).toBe(1);
      expect(row?.ready).toBe(false);
    });

    it("does not count a done blocker: blocked_count 0, ready true", async () => {
      const target = makeTicket();
      const blocker = makeTicket({ blocks: [target.id], state: "done" });
      await createTicket(paths, target, ctx, createdEvent);
      await createTicket(paths, blocker, ctx, createdEvent);

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === target.id);
      expect(row?.blocked_count).toBe(0);
      expect(row?.ready).toBe(true);
    });

    it("does not count a dropped blocker: blocked_count 0, ready true", async () => {
      const target = makeTicket();
      const blocker = makeTicket({ blocks: [target.id], state: "dropped" });
      await createTicket(paths, target, ctx, createdEvent);
      await createTicket(paths, blocker, ctx, createdEvent);

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === target.id);
      expect(row?.blocked_count).toBe(0);
      expect(row?.ready).toBe(true);
    });

    it("diamond: two blockers, one done one open — still blocked, blocked_count 1", async () => {
      const target = makeTicket();
      const doneBlocker = makeTicket({ blocks: [target.id], state: "done" });
      const openBlocker = makeTicket({ blocks: [target.id] });
      await createTicket(paths, target, ctx, createdEvent);
      await createTicket(paths, doneBlocker, ctx, createdEvent);
      await createTicket(paths, openBlocker, ctx, createdEvent);

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === target.id);
      // A naive "any blocker closed -> flip to ready" implementation would
      // get this wrong; blocked_count must reflect the SURVIVING live
      // blocker.
      expect(row?.blocked_count).toBe(1);
      expect(row?.ready).toBe(false);
    });

    it("an in_progress ticket with an active session is never ready, even with 0 blockers", async () => {
      const t = makeTicket({ state: "in_progress", active_session: newSessionId() });
      await createTicket(paths, t, ctx, createdEvent);

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === t.id);
      expect(row?.blocked_count).toBe(0);
      expect(row?.ready).toBe(false);
    });

    // Adversarial-review, mutation-testing finding: an `active_session`
    // set WHILE `state` is still `open` is the only combination that
    // isolates design.md §2's "no active session" clause independently of
    // the "open" clause. A real `slop start` (and the test above, and
    // every CLI-level "has an active session -> excluded" check) flips
    // `state` to `in_progress` and sets `active_session` in the SAME
    // mutation, so the `state !== "open"` exclusion alone already hides
    // such a ticket from `ready` — a `computeReady` that dropped its
    // `activeSession === null` check entirely would still pass every one
    // of those. Constructing `open` + a non-null `active_session` directly
    // via the repo layer (never reachable through today's `start`/`stop`,
    // but a legal on-disk state — e.g. mid-transition, or a future
    // command) is the only way to catch that specific mutation.
    it("an OPEN ticket with an active session is never ready — isolates the active-session clause independently of state", async () => {
      const t = makeTicket({ state: "open", active_session: newSessionId() });
      await createTicket(paths, t, ctx, createdEvent);

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === t.id);
      expect(row?.state).toBe("open");
      expect(row?.blocked_count).toBe(0);
      expect(row?.active_session).not.toBeNull();
      expect(row?.ready).toBe(false);
    });

    it("drafts/in_progress/review/done/dropped are never ready, regardless of blocked_count", async () => {
      const nonOpenStates = ["draft", "in_progress", "review", "done", "dropped"] as const;
      for (const state of nonOpenStates) {
        const t = makeTicket({
          state,
          review:
            state === "review"
              ? { requested_at: "2026-07-23T10:00:00.000Z", by: { name: "ryan", kind: "human" } }
              : undefined,
        });
        await createTicket(paths, t, ctx, createdEvent);
      }

      const index = await buildIndex(paths, clock);
      expect(index.tickets).toHaveLength(nonOpenStates.length);
      for (const row of index.tickets) {
        expect(row.ready, `state=${row.state} should never be ready`).toBe(false);
      }
    });
  });

  describe("computeBlockedCounts / computeReady / isLiveBlockerState (pure)", () => {
    it("isLiveBlockerState: only done/dropped are non-live", () => {
      expect(isLiveBlockerState("draft")).toBe(true);
      expect(isLiveBlockerState("open")).toBe(true);
      expect(isLiveBlockerState("in_progress")).toBe(true);
      expect(isLiveBlockerState("review")).toBe(true);
      expect(isLiveBlockerState("done")).toBe(false);
      expect(isLiveBlockerState("dropped")).toBe(false);
    });

    it("computeBlockedCounts: every ticket gets an entry, including one with zero blockers", () => {
      const a = makeTicket();
      const b = makeTicket();
      const counts = computeBlockedCounts([a, b]);
      expect(counts.get(a.id)).toBe(0);
      expect(counts.get(b.id)).toBe(0);
    });

    it("computeBlockedCounts: fan-out — one blocker counted against every ticket it blocks", () => {
      const x = makeTicket();
      const y = makeTicket();
      const blocker = makeTicket({ blocks: [x.id, y.id] });
      const counts = computeBlockedCounts([x, y, blocker]);
      expect(counts.get(x.id)).toBe(1);
      expect(counts.get(y.id)).toBe(1);
    });

    it("computeReady matches design.md §2 exactly", () => {
      expect(computeReady("open", 0, null)).toBe(true);
      expect(computeReady("open", 1, null)).toBe(false);
      expect(computeReady("open", 0, newSessionId())).toBe(false);
      expect(computeReady("in_progress", 0, null)).toBe(false);
      expect(computeReady("draft", 0, null)).toBe(false);
      expect(computeReady("review", 0, null)).toBe(false);
      expect(computeReady("done", 0, null)).toBe(false);
      expect(computeReady("dropped", 0, null)).toBe(false);
    });
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

  it("has an empty problems array in the ordinary (no corruption) case", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    const index = await buildIndex(paths, clock);
    expect(index.problems).toEqual([]);
  });

  // Adversarial-review Finding 3: a single corrupt ticket file used to
  // make buildIndex (and therefore `slop reindex`, `ready`, `status`,
  // ref resolution — everything through loadIndex) throw outright.
  describe("fault tolerance: a corrupt ticket file never aborts the whole build", () => {
    it("skips one unreadable ticket file, records it in problems with a high-quality error, and still includes every good ticket", async () => {
      const good1 = makeTicket();
      const good2 = makeTicket();
      await createTicket(paths, good1, ctx, createdEvent);
      await createTicket(paths, good2, ctx, createdEvent);
      const badId = newTicketId();
      const badPath = ticketFilePath(paths, badId);
      await writeFile(badPath, '{ "id": "not even close to a valid ticket" }');

      const index = await buildIndex(paths, clock);

      expect(index.tickets.map((r) => r.id).sort()).toEqual([good1.id, good2.id].sort());
      expect(index.problems).toHaveLength(1);
      expect(index.problems[0]).toMatchObject({ id: badId, path: badPath });
      // The quality readTicket's own error carries — path + specifics —
      // must survive into the captured problem, not be flattened away.
      expect(index.problems[0]?.message).toContain(badPath);
      expect(index.problems[0]?.message.length).toBeGreaterThan(badPath.length);
    });

    it("records EVERY bad file in one pass, not just the first", async () => {
      const good = makeTicket();
      await createTicket(paths, good, ctx, createdEvent);
      const bad1 = newTicketId();
      const bad2 = newTicketId();
      await writeFile(ticketFilePath(paths, bad1), "{ not even valid jsonc {{{");
      await writeFile(ticketFilePath(paths, bad2), '{ "id": "still not a valid ticket" }');

      const index = await buildIndex(paths, clock);

      expect(index.tickets.map((r) => r.id)).toEqual([good.id]);
      expect(index.problems.map((p) => p.id).sort()).toEqual([bad1, bad2].sort());
    });
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

  // Adversarial-review Finding 3: a corrupt ticket file must never
  // silently vanish from a build — loadIndex (the function every other
  // read path calls) warns on stderr, and does so every time it returns
  // problems, not just once.
  it("never throws when a ticket file is corrupt either — rebuilds everything readable and records the rest in problems", async () => {
    const good = makeTicket();
    await createTicket(paths, good, ctx, createdEvent);
    await writeFile(ticketFilePath(paths, newTicketId()), "{ not even valid jsonc {{{");

    const result = await loadIndex(paths, clock);
    expect(result.index.tickets.map((r) => r.id)).toEqual([good.id]);
    expect(result.index.problems).toHaveLength(1);
  });

  it("warns on stderr, every time it returns an index with problems — a 'fresh' (non-rebuilt) read is loud too, not just the rebuild", async () => {
    const good = makeTicket();
    await createTicket(paths, good, ctx, createdEvent);
    const badId = newTicketId();
    const badPath = ticketFilePath(paths, badId);
    await writeFile(badPath, "{ not even valid jsonc {{{");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const first = await loadIndex(paths, clock);
      expect(first.rebuilt).toBe(true);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(String(stderrSpy.mock.calls[0]?.[0])).toContain(badPath);

      // A second read, with NOTHING on disk changed: the fingerprint
      // matches, so this is a "fresh" (non-rebuilt) load — but the
      // persisted problems list still names the same bad file, so this
      // must warn AGAIN. Silence here would mean "loud once, then never
      // again," which is exactly what Finding 3 says not to do.
      const second = await loadIndex(paths, clock);
      expect(second.rebuilt).toBe(false);
      expect(second.reason).toBe("fresh");
      expect(stderrSpy).toHaveBeenCalledTimes(2);
      expect(String(stderrSpy.mock.calls[1]?.[0])).toContain(badPath);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("does NOT warn on stderr when there are no problems", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await loadIndex(paths, clock);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("formatIndexProblems", () => {
  it("renders a count header plus each problem's path and full message", () => {
    const text = formatIndexProblems([
      {
        id: "ticket_01ARZ3NDEKTSV4RRFFQ69G5FAA" as Ticket["id"],
        path: "/x/ticket_a.jsonc",
        message: "/x/ticket_a.jsonc: invalid JSONC\n  line 3, column 1: bad token",
      },
      {
        id: "ticket_01ARZ3NDEKTSV4RRFFQ69G5FAB" as Ticket["id"],
        path: "/x/ticket_b.jsonc",
        message: "/x/ticket_b.jsonc: failed schema validation\n  id: expected ticket_<ULID>",
      },
    ]);
    expect(text).toContain("2 ticket file(s)");
    expect(text).toContain("/x/ticket_a.jsonc");
    expect(text).toContain("line 3, column 1: bad token");
    expect(text).toContain("/x/ticket_b.jsonc");
    expect(text).toContain("id: expected ticket_<ULID>");
  });
});

describe("computeContentFingerprint", () => {
  it("is {count:0, digest:<empty-input sha256>} for an empty tickets dir", async () => {
    const fp = await computeContentFingerprint(paths);
    expect(fp.tickets).toEqual({ count: 0, digest: expect.any(String) });
  });

  // C5: config.yaml joins the fingerprint (stale_at/review_stale_at are
  // computed from its defaults.*) — see db-index.ts's module doc.
  describe("C5: config.yaml is part of the fingerprint", () => {
    it("is {count:0, digest:'absent'} when config.yaml does not exist", async () => {
      const fp = await computeContentFingerprint(paths);
      expect(fp.config).toEqual({ count: 0, digest: "absent" });
    });

    it("becomes {count:1, ...} once config.yaml is created, and changes again on edit", async () => {
      await writeFile(join(paths.slopDir, "config.yaml"), "project: x\n", "utf8");
      const afterCreate = await computeContentFingerprint(paths);
      expect(afterCreate.config?.count).toBe(1);

      await sleep(20);
      await writeFile(
        join(paths.slopDir, "config.yaml"),
        "project: x\ndefaults:\n  stale_after: 5m\n",
        "utf8",
      );
      const afterEdit = await computeContentFingerprint(paths);
      expect(afterEdit.config?.digest).not.toBe(afterCreate.config?.digest);
    });
  });

  it("counts only real ticket entity files, ignoring temp/other debris", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    await writeFile(join(paths.ticketsDir, ".tmp-abc-ticket_x.jsonc"), "partial");
    await writeFile(join(paths.ticketsDir, "not-a-ticket.txt"), "x");

    const fp = await computeContentFingerprint(paths);
    expect(fp.tickets).toEqual({ count: 1, digest: expect.any(String) });
    expect(fp.tickets?.digest.length).toBeGreaterThan(0);
  });

  it("is readdir+stat only — never reads or parses file content (spot check: garbage content doesn't throw)", async () => {
    const t = makeTicket();
    const created = await createTicket(paths, t, ctx, createdEvent);
    await writeFile(ticketFilePath(paths, t.id), "{ not even valid jsonc {{{");
    // G2 (shard-event-storage): createTicket's accompanying `ticket.created`
    // event lands in ITS OWN id's shard, never flat — so the flat `events`
    // key stays {count: 0, digest: "empty"} and a NEW `events/<month>` key
    // (the month derived from the created event's own id, never a
    // hardcoded/wall-clock-dependent string, so this test doesn't depend on
    // what month it happens to run in) carries the {count: 1, digest}.
    const month = eventShardMonth(created.id);
    await expect(computeContentFingerprint(paths)).resolves.toEqual({
      tickets: { count: 1, digest: expect.any(String) },
      config: { count: 0, digest: "absent" },
      events: { count: 0, digest: "empty" },
      [`events/${month}`]: { count: 1, digest: expect.any(String) },
    });
  });

  // ticket_01KY9RWFM80BKNE2CDX85QMKGS: events/ is part of the fingerprint
  // — this is what lets loadIndex() notice a lock-free `update --progress`
  // event even though appending one never touches tickets/ or
  // config.yaml. Cheap by construction (events are immutable/append-only,
  // events.ts's module doc): {count, digest: <max event id>}, zero `stat`
  // calls, unlike fingerprintTicketsDir's per-file stat.
  //
  // G2 (shard-event-storage): a NEW event never lands in the flat `events/`
  // directory anymore (events.ts's module doc) — it lands in
  // `events/<eventShardMonth(id)>/`. The flat `events` key therefore stays
  // put (still meaning "the flat directory's own fingerprint", still
  // `{count: 0, digest: "empty"}` with nothing flat ever written), and a
  // per-shard `events/<month>` key is what actually changes on append —
  // see the tests below.
  describe("events/ is part of the fingerprint", () => {
    it("is {count:0, digest:'empty'} for an empty events dir", async () => {
      const fp = await computeContentFingerprint(paths);
      expect(fp.events).toEqual({ count: 0, digest: "empty" });
    });

    it("changes (count and digest, the max event id) on every event appended, regardless of which ticket file it describes — via a NEW `events/<month>` shard key, since the flat `events` key never receives a new write", async () => {
      const before = await computeContentFingerprint(paths);
      const t = makeTicket();
      const created = await createTicket(paths, t, ctx, createdEvent);
      const after = await computeContentFingerprint(paths);

      // The flat key is untouched: no new event has ever been written
      // flat, in `before` or `after`.
      expect(after.events).toEqual({ count: 0, digest: "empty" });
      expect(before.events).toEqual({ count: 0, digest: "empty" });

      const month = eventShardMonth(created.id);
      const key = `events/${month}`;
      expect(before[key]).toBeUndefined();
      expect(after[key]?.count).toBe(1);
      expect(after[key]?.digest).toBe(created.id);
    });

    it("two events landing in two different months produce two independent shard keys, each reflecting only that one shard's own content", async () => {
      // A deliberately old-dated event — synthesized via `makeEventAt`
      // rather than `createTicket`/`appendEvent`, since `newEventId()`
      // always mints against the real wall clock (core/ids.ts has no
      // seed-time parameter) and this test needs two events guaranteed to
      // land in two DIFFERENT shard months regardless of when it's run.
      const oldEvent = makeEventAt(new Date("2020-01-15T00:00:00.000Z").getTime());
      await createEvent(paths, oldEvent);

      // A "current" (real-clock) event via the normal mutation path.
      const currentEvent = await appendEvent(
        paths,
        ctx,
        { kind: "ticket", id: newTicketId() },
        { verb: "ticket.created" },
      );

      const oldMonth = eventShardMonth(oldEvent.id);
      const currentMonth = eventShardMonth(currentEvent.id);
      // Sanity: this test only proves what it claims to if these really
      // are two different shards.
      expect(oldMonth).not.toBe(currentMonth);

      const fp = await computeContentFingerprint(paths);
      expect(fp.events).toEqual({ count: 0, digest: "empty" }); // flat: untouched
      expect(fp[`events/${oldMonth}`]).toEqual({ count: 1, digest: oldEvent.id });
      expect(fp[`events/${currentMonth}`]).toEqual({ count: 1, digest: currentEvent.id });
    });

    it("a shard key appearing between two snapshots is a real difference — the property fingerprintsEqual's generic (not fixed-3-key) comparison depends on", async () => {
      const before = await computeContentFingerprint(paths);
      const event = await appendEvent(
        paths,
        ctx,
        { kind: "ticket", id: newTicketId() },
        { verb: "ticket.created" },
      );
      const key = `events/${eventShardMonth(event.id)}`;

      // The key didn't exist at all in the earlier snapshot...
      expect(before[key]).toBeUndefined();
      // ...and does in the later one — a fingerprint comparison that only
      // ever checked a fixed set of keys (rather than the full key union,
      // which is what `fingerprintsEqual` actually does) could miss this
      // exact shape of change.
      const after = await computeContentFingerprint(paths);
      expect(after[key]).toEqual({ count: 1, digest: event.id });
      expect(after).not.toEqual(before);
    });
  });

  // Adversarial-review Finding 2: the old count+max-mtime-only fingerprint
  // could miss a real content change if the edited file's mtime never
  // advanced past another file's already-recorded max — exactly what
  // `cp -p`/`rsync -t`/a backup restore/clock skew between machines
  // produces. The digest must catch this: a file's mtime or size
  // changing, *in either direction*, always changes the digest.
  it("changes when a file's mtime is pushed BACKWARDS below another file's mtime — same count, same 'max' either way (Finding 2)", async () => {
    const older = makeTicket({ name: "Older ticket" });
    await createTicket(paths, older, ctx, createdEvent);
    const olderPath = ticketFilePath(paths, older.id);
    const baseTime = new Date("2026-07-23T10:00:00.000Z");
    await utimes(olderPath, baseTime, baseTime);

    const newer = makeTicket({ name: "Newer ticket" });
    await createTicket(paths, newer, ctx, createdEvent);
    const newerTime = new Date(baseTime.getTime() + 5_000);
    await utimes(ticketFilePath(paths, newer.id), newerTime, newerTime);

    const before = await computeContentFingerprint(paths);

    // Edit the OLDER ticket's content, then force its mtime backwards —
    // still less than `newer`'s mtime, so a max-mtime-only fingerprint
    // would see the directory's max as unchanged and its count as
    // unchanged, and therefore (wrongly) conclude nothing changed.
    const raw = await readFile(olderPath, "utf8");
    await writeFile(olderPath, raw.replace("Older ticket", "Older ticket RENAMED"));
    const editedTime = new Date(baseTime.getTime() + 1_000); // still < newerTime
    await utimes(olderPath, editedTime, editedTime);

    const after = await computeContentFingerprint(paths);

    expect(after.tickets?.count).toBe(before.tickets?.count); // count: unchanged
    expect(after.tickets?.digest).not.toBe(before.tickets?.digest); // digest: caught it anyway
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

  // C5: hand-editing config.yaml's defaults.* must invalidate the index —
  // otherwise a changed stale_after/review_stale_after would silently do
  // nothing until some unrelated ticket file also happened to change.
  it("C5: detects a config.yaml hand-edit and recomputes stale_at against the NEW threshold", async () => {
    await writeFile(
      join(paths.slopDir, "config.yaml"),
      "project: x\ndefaults:\n  stale_after: 60m\n",
      "utf8",
    );
    const t = makeTicket({ state: "in_progress", last_activity_at: "2026-07-23T10:00:00.000Z" });
    await createTicket(paths, t, ctx, createdEvent);

    const first = await loadIndex(paths, clock);
    expect(first.index.tickets[0]?.stale_at).toBe("2026-07-23T11:00:00.000Z");

    await sleep(20);
    await writeFile(
      join(paths.slopDir, "config.yaml"),
      "project: x\ndefaults:\n  stale_after: 5m\n",
      "utf8",
    );

    const second = await loadIndex(paths, clock);
    expect(second.rebuilt).toBe(true);
    expect(second.reason).toBe("stale_content");
    expect(second.index.tickets[0]?.stale_at).toBe("2026-07-23T10:05:00.000Z");
  });
});
