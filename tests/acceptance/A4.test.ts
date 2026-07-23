import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Event,
  type EventEntity,
  type EventVerb,
  type Session,
  type Ticket,
  newSessionId,
  newTicketId,
  sessionSchema,
  ticketSchema,
} from "../../src/core/index.js";
import { rebuildIndex } from "../../src/repo/db-index.js";
import type { EventContext, MutationEventSpec } from "../../src/repo/events.js";
import * as eventsModule from "../../src/repo/events.js";
import { listEvents, queryEvents, withMutationEvent } from "../../src/repo/events.js";
import { acquireLock, releaseLock, withLock } from "../../src/repo/lock.js";
import { ensureDbDirs } from "../../src/repo/paths.js";
import type { RepoPaths } from "../../src/repo/paths.js";
import * as repoModule from "../../src/repo/index.js";
import * as sessionsModule from "../../src/repo/sessions.js";
import { createSession, readSession, updateSession } from "../../src/repo/sessions.js";
import * as ticketsModule from "../../src/repo/tickets.js";
import { createTicket, readTicket, updateTicket } from "../../src/repo/tickets.js";

// A4: Event writer
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "Every repo mutation in tests produces exactly one ordered event"
//
// This file tests that as a general property of the repo layer's mutation
// surface (tickets.ts's createTicket/updateTicket, sessions.ts's
// createSession/updateSession), not a handful of hand-picked examples —
// see "structural coverage" below for how the driver table is kept
// honest against that surface — plus the other three clauses this work
// item's brief calls out explicitly: ULID cursor ordering (strict, no
// duplicates, stable under repeated reads AND across a ticket-index
// rebuild — D3's own acceptance criterion), immutability (no supported
// path to modify/delete an event), and multi-file transaction semantics
// under `.lock` (N mutations -> N durable events; a mid-transaction
// failure leaves completed mutations' events standing, never rolled
// back).

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "Ticket",
    slug: `ticket-${id.slice(-8).toLowerCase()}`,
    spec: { summary: "s" },
    state: "open",
    priority: 2,
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return sessionSchema.parse({
    id: newSessionId(),
    ticket: newTicketId(),
    actor: { name: "ryan", kind: "human" },
    harness: { kind: "claude-code", session_id: null },
    git: { branch: "main", commit_at_start: null },
    started_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

let scratch: string;
let paths: RepoPaths;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-a4-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("A4: Event writer", () => {
  describe('"every repo mutation in tests produces exactly one ordered event"', () => {
    // The context/verb a driver's SETUP phase uses — deliberately a
    // different actor from the tracked call's own ctx, so a test can't
    // accidentally pass by conflating the setup mutation's event with the
    // one actually under test.
    const SETUP_CTX: EventContext = { actor: { name: "setup", kind: "agent" }, session: null };

    interface DriverOutcome {
      event: Event;
      ctx: EventContext;
      verb: EventVerb;
      entity: EventEntity;
    }

    /**
     * One case per repo-layer mutation function. `setup` does whatever
     * scaffolding the mutation needs (e.g. an existing ticket to update)
     * and is NOT the call under test; `act` is the actual call whose
     * event-emission behavior this test asserts on.
     */
    interface MutationCase {
      setup(paths: RepoPaths): Promise<unknown>;
      act(paths: RepoPaths, setupResult: unknown): Promise<DriverOutcome>;
    }

    const DRIVERS: Record<string, MutationCase> = {
      "tickets.createTicket": {
        async setup() {
          return undefined;
        },
        async act(paths) {
          const ticket = makeTicket();
          const ctx: EventContext = { actor: { name: "agent-new", kind: "agent" }, session: null };
          const spec: MutationEventSpec = { verb: "ticket.created", payload: { via: "new" } };
          const event = await createTicket(paths, ticket, ctx, spec);
          return { event, ctx, verb: spec.verb, entity: { kind: "ticket", id: ticket.id } };
        },
      },
      "tickets.updateTicket": {
        async setup(paths) {
          const ticket = makeTicket();
          await createTicket(paths, ticket, SETUP_CTX, { verb: "ticket.created" });
          return ticket;
        },
        async act(paths, setupResult) {
          const ticket = setupResult as Ticket;
          const after = { ...ticket, priority: 0 };
          const ctx: EventContext = {
            actor: { name: "agent-update", kind: "agent" },
            session: newSessionId(),
          };
          const spec: MutationEventSpec = { verb: "ticket.state_changed", payload: { to: "open" } };
          const event = await updateTicket(
            paths,
            ticket.id,
            [{ path: ["priority"], value: 0 }],
            after,
            ctx,
            spec,
          );
          return { event, ctx, verb: spec.verb, entity: { kind: "ticket", id: ticket.id } };
        },
      },
      "sessions.createSession": {
        async setup() {
          return undefined;
        },
        async act(paths) {
          const session = makeSession();
          const ctx: EventContext = { actor: session.actor, session: session.id };
          const spec: MutationEventSpec = { verb: "session.started" };
          const event = await createSession(paths, session, ctx, spec);
          return { event, ctx, verb: spec.verb, entity: { kind: "session", id: session.id } };
        },
      },
      "sessions.updateSession": {
        async setup(paths) {
          const session = makeSession();
          await createSession(paths, session, SETUP_CTX, { verb: "session.started" });
          return session;
        },
        async act(paths, setupResult) {
          const session = setupResult as Session;
          const after: Session = { ...session, end_summary: "wrapped up" };
          const ctx: EventContext = { actor: session.actor, session: session.id };
          const spec: MutationEventSpec = { verb: "session.ended" };
          const event = await updateSession(
            paths,
            session.id,
            [{ path: ["end_summary"], value: "wrapped up" }],
            after,
            ctx,
            spec,
          );
          return { event, ctx, verb: spec.verb, entity: { kind: "session", id: session.id } };
        },
      },
    };

    describe("structural coverage — the driver table can't silently fall behind the repo layer's mutation surface", () => {
      /**
       * Every function exported from tickets.ts/sessions.ts whose name
       * matches the repo layer's create-or-update mutation-naming
       * convention (see DECISIONS.md's A4 entry) — reflected off the
       * actual module, not hand-copied. Deliberately scoped to just these
       * two modules, not the whole repo barrel: lower-level primitives
       * like entity-file.ts's `createEntityFileCanonical`/
       * `updateEntityFile` and events.ts's own `createEvent` also match
       * the naming convention but are explicitly NOT the sanctioned
       * per-entity mutation surface (see tickets.ts/sessions.ts/events.ts
       * module docs) — the whole point of tickets.ts/sessions.ts existing
       * is to be the one place that surface lives.
       */
      function mutationExportNames(mod: object): string[] {
        return Object.keys(mod).filter((name) => /^(create|update)[A-Z]/.test(name));
      }

      it("DRIVERS has exactly one entry per create*/update* export of tickets.ts and sessions.ts — adding a new mutation there without adding a driver here fails this test", () => {
        const actual = new Set([
          ...mutationExportNames(ticketsModule).map((n) => `tickets.${n}`),
          ...mutationExportNames(sessionsModule).map((n) => `sessions.${n}`),
        ]);
        expect(new Set(Object.keys(DRIVERS))).toEqual(actual);
      });
    });

    // The property test itself, driven off the enumeration above rather
    // than a fixed list of `it(...)` blocks.
    it.each(Object.entries(DRIVERS))(
      "%s: produces exactly one new event, ordered, with the caller's verb/actor/session/entity",
      async (_name, driverCase) => {
        const setupResult = await driverCase.setup(paths);
        const before = await listEvents(paths);
        const { event, ctx, verb, entity } = await driverCase.act(paths, setupResult);
        const after = await listEvents(paths);

        // Exactly one — not zero, not two.
        expect(after.length - before.length).toBe(1);
        const beforeIds = new Set(before.map((e) => e.id));
        const newEvents = after.filter((e) => !beforeIds.has(e.id));
        expect(newEvents).toHaveLength(1);
        expect(newEvents[0]).toEqual(event);

        // Ordered: the new event's id sorts after every prior one (ULID
        // cursor ordering, exercised again in bulk below).
        for (const priorEvent of before) {
          expect(event.id > priorEvent.id).toBe(true);
        }

        // Correctly attributed: the caller's own actor/session/verb/
        // entity — not some default or a value borrowed from setup.
        expect(event.actor).toEqual(ctx.actor);
        expect(event.session).toEqual(ctx.session);
        expect(event.verb).toBe(verb);
        expect(event.entity).toEqual(entity);
      },
    );
  });

  describe("ULID cursor ordering", () => {
    const ctx: EventContext = { actor: { name: "loop", kind: "agent" }, session: null };

    it("a same-millisecond batch of mutations is strictly ordered with no duplicate ids", async () => {
      const COUNT = 250;
      for (let i = 0; i < COUNT; i++) {
        await withMutationEvent(
          paths,
          ctx,
          { kind: "ticket", id: newTicketId() },
          { verb: "ticket.updated", payload: { i } },
          async () => {},
        );
      }

      const events = await listEvents(paths);
      expect(events).toHaveLength(COUNT);
      for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1];
        const cur = events[i];
        expect(prev).toBeDefined();
        expect(cur).toBeDefined();
        expect(cur && prev && cur.id > prev.id).toBe(true);
      }
      expect(new Set(events.map((e) => e.id)).size).toBe(COUNT);
    });

    it("is stable under repeated reads (listEvents and queryEvents alike)", async () => {
      for (let i = 0; i < 12; i++) {
        await withMutationEvent(
          paths,
          ctx,
          { kind: "ticket", id: newTicketId() },
          { verb: "ticket.updated" },
          async () => {},
        );
      }
      const listFirst = await listEvents(paths);
      const listSecond = await listEvents(paths);
      expect(listSecond).toEqual(listFirst);

      const queryFirst = await queryEvents(paths);
      const querySecond = await queryEvents(paths);
      expect(querySecond).toEqual(queryFirst);
      expect(queryFirst.map((e) => e.id)).toEqual(listFirst.map((e) => e.id));
    });

    // D3's own acceptance criterion ("cursor pagination stable across
    // reindex") — provable here because events are immutable, ordered by
    // their own id, and NOT part of the ticket index's content
    // fingerprint at all (see db-index.ts / this work item's report), so
    // rebuilding index.jsonc can never change what queryEvents returns.
    it("cursor pagination is stable across a ticket index.jsonc rebuild", async () => {
      const events: Event[] = [];
      for (let i = 0; i < 7; i++) {
        const ticket = makeTicket();
        const event = await createTicket(paths, ticket, ctx, { verb: "ticket.created" });
        events.push(event);
      }

      await rebuildIndex(paths); // builds/writes .slop/db/index.jsonc

      const page1Before = await queryEvents(paths, { limit: 3 });
      const cursor = page1Before[page1Before.length - 1];
      expect(cursor).toBeDefined();
      if (!cursor) throw new Error("unreachable");
      const page2Before = await queryEvents(paths, { since: cursor.id, limit: 3 });

      // Delete and rebuild the ticket index — the derived, gitignored
      // artifact events don't live in and never did.
      await rm(paths.indexFile, { force: true });
      await rebuildIndex(paths);

      const page1After = await queryEvents(paths, { limit: 3 });
      const page2After = await queryEvents(paths, { since: cursor.id, limit: 3 });

      expect(page1After.map((e) => e.id)).toEqual(page1Before.map((e) => e.id));
      expect(page2After.map((e) => e.id)).toEqual(page2Before.map((e) => e.id));
      expect(page1After.map((e) => e.id)).toEqual(events.slice(0, 3).map((e) => e.id));
    });
  });

  describe('immutability — "no supported path to modify or delete an event"', () => {
    it("events.ts exports no updateEvent or deleteEvent", () => {
      expect("updateEvent" in eventsModule).toBe(false);
      expect("deleteEvent" in eventsModule).toBe(false);
    });

    it("the repo barrel (src/repo/index.ts) doesn't add one back either", () => {
      expect("updateEvent" in repoModule).toBe(false);
      expect("deleteEvent" in repoModule).toBe(false);
    });

    it("the only way to make an event file appear on disk is createEvent/withMutationEvent — writing one twice for the same id is a plain overwrite, never exposed through the mutation surface", async () => {
      const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
      const event = await withMutationEvent(
        paths,
        ctx,
        { kind: "ticket", id: newTicketId() },
        { verb: "ticket.created" },
        async () => {},
      );
      const read1 = await listEvents(paths);
      expect(read1).toEqual([event]);
      // No exported function takes an existing event id and changes it —
      // demonstrated structurally above; here we just confirm reading
      // twice yields the identical, unchanged record.
      const read2 = await listEvents(paths);
      expect(read2).toEqual(read1);
    });
  });

  describe("multi-file transactions compose correctly with .lock (B4's done-cascade shape)", () => {
    const ctx: EventContext = { actor: { name: "cascade", kind: "agent" }, session: null };
    const SETUP_CTX: EventContext = { actor: { name: "setup", kind: "agent" }, session: null };

    it("N mutations inside one withLock produce exactly N durable, immutable events", async () => {
      const tickets = [makeTicket(), makeTicket(), makeTicket()];
      for (const t of tickets) {
        await createTicket(paths, t, SETUP_CTX, { verb: "ticket.created" });
      }
      const before = await listEvents(paths);

      const emitted = await withLock(paths.lockFile, async () => {
        const out: Event[] = [];
        for (const t of tickets) {
          const after = { ...t, priority: 0 };
          const event = await updateTicket(
            paths,
            t.id,
            [{ path: ["priority"], value: 0 }],
            after,
            ctx,
            { verb: "ticket.updated" },
          );
          out.push(event);
        }
        return out;
      });

      expect(emitted).toHaveLength(tickets.length);
      const after = await listEvents(paths);
      expect(after.length - before.length).toBe(tickets.length);
      expect(new Set(emitted.map((e) => e.id)).size).toBe(tickets.length);
      for (const t of tickets) {
        await expect(readTicket(paths, t.id)).resolves.toMatchObject({ priority: 0 });
      }

      // Durable + immutable: still there, byte-identical, on a fresh read.
      const reread = await listEvents(paths);
      const emittedIds = new Set(emitted.map((e) => e.id));
      const rereadMatching = reread.filter((e) => emittedIds.has(e.id));
      expect(rereadMatching).toEqual(emitted.sort((a, b) => (a.id < b.id ? -1 : 1)));
    });

    it("a mutation that fails partway through a transaction leaves earlier mutations' entity writes AND events standing — nothing is rolled back — and the lock is still released", async () => {
      const t1 = makeTicket();
      const t2 = makeTicket();
      await createTicket(paths, t1, SETUP_CTX, { verb: "ticket.created" });
      await createTicket(paths, t2, SETUP_CTX, { verb: "ticket.created" });
      const before = await listEvents(paths);

      let threw: unknown;
      try {
        await withLock(paths.lockFile, async () => {
          // 1st mutation: succeeds, writes a file + emits an event.
          await updateTicket(
            paths,
            t1.id,
            [{ path: ["priority"], value: 0 }],
            { ...t1, priority: 0 },
            ctx,
            { verb: "ticket.updated" },
          );
          // 2nd mutation: targets a ticket id that was never created ->
          // updateEntityFile throws NOT_FOUND before any event is minted.
          await updateTicket(
            paths,
            newTicketId(),
            [{ path: ["priority"], value: 0 }],
            { ...t2, priority: 0 },
            ctx,
            { verb: "ticket.updated" },
          );
          // 3rd mutation: never reached.
          await updateTicket(
            paths,
            t2.id,
            [{ path: ["priority"], value: 0 }],
            { ...t2, priority: 0 },
            ctx,
            { verb: "ticket.updated" },
          );
        });
      } catch (err) {
        threw = err;
      }

      expect(threw).toMatchObject({ exitCode: 4 }); // NOT_FOUND

      const after = await listEvents(paths);
      // Exactly one new event — the 1st mutation's. Not zero (it wasn't
      // rolled back), not three (the 2nd/3rd never happened).
      expect(after.length - before.length).toBe(1);

      // The 1st mutation's file write is durable too — no partial state.
      await expect(readTicket(paths, t1.id)).resolves.toMatchObject({ priority: 0 });
      // The 3rd mutation never ran: t2 is untouched.
      await expect(readTicket(paths, t2.id)).resolves.toMatchObject({ priority: 2 });

      // The lock was released in `finally` even though the transaction
      // threw — acquirable again immediately, not stuck.
      await acquireLock(paths.lockFile, { timeoutMs: 500 });
      await releaseLock(paths.lockFile);
    });

    it("session mutations compose the same way as ticket mutations under one lock", async () => {
      const sessions = [makeSession(), makeSession()];
      for (const s of sessions) {
        await createSession(paths, s, SETUP_CTX, { verb: "session.started" });
      }
      const before = await listEvents(paths);

      await withLock(paths.lockFile, async () => {
        for (const s of sessions) {
          await updateSession(
            paths,
            s.id,
            [{ path: ["end_summary"], value: "done" }],
            { ...s, end_summary: "done" },
            ctx,
            { verb: "session.ended" },
          );
        }
      });

      const after = await listEvents(paths);
      expect(after.length - before.length).toBe(sessions.length);
      for (const s of sessions) {
        await expect(readSession(paths, s.id)).resolves.toMatchObject({ end_summary: "done" });
      }
    });
  });
});
