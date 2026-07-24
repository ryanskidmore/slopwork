import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../core/clock.js";
import { type Ticket, type TicketId, newTicketId, ticketSchema } from "../core/index.js";
import type { EventContext, LockHandle, MutationEventSpec, RepoPaths } from "../repo/index.js";
import {
  buildIndex,
  createTicket,
  ensureDbDirs,
  listEventIds,
  listEvents,
  readTicket,
  updateTicket,
  withLock,
} from "../repo/index.js";
import { TICKET_FIELDS, diffTicketPatch } from "./patch.js";
import { cascadeOnClose } from "./cascade.js";

// Perf fix regression coverage (see cascade.ts's module doc, "Emission is
// deduplicated against the event log"): the dedup check used to call
// `queryEvents(paths, { ticket })` once per unblocked candidate, each call
// reading/parsing the ENTIRE event log — O(candidates × total events) on
// this lock-held hot path. Wrapping `node:fs/promises`'s `readFile` lets the
// "reads the event log exactly once" test below count actual file reads
// under `paths.eventsDir`, without touching any file outside this test's
// allowlist (`entity-file.ts` itself is unmodified — this only observes the
// real reads it makes).
const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  readFileMock.mockImplementation(actual.readFile);
  return { ...actual, readFile: readFileMock };
});

const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };
const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "Ticket",
    slug: `ticket-${id.slice(-10).toLowerCase()}`,
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

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-cascade-test-"));
  paths = await ensureDbDirs(scratch);
  readFileMock.mockClear();
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A trivial always-held LockHandle for function-level tests that don't
 * exercise the real `.slop/db/.lock` file — the end-to-end describe block
 * below uses the real thing via `withLock`. */
function fakeLock(): LockHandle {
  return {
    token: "fake-token",
    assertHeld: async () => {},
  };
}

/** Directly flips `id`'s state to `toState` via the repo layer — this is
 * `cascadeOnClose`'s documented precondition ("the caller must already
 * have durably written the closed state"), reproduced here without going
 * through `done`/`drop` (C3, not yet implemented) — see the B4 brief:
 * "Build fixtures via the repo layer." */
async function closeTicket(id: TicketId, toState: "done" | "dropped"): Promise<void> {
  const before = await readTicket(paths, id);
  const after: Ticket = { ...before, state: toState, active_session: null };
  await updateTicket(paths, id, diffTicketPatch(before, after, TICKET_FIELDS), after, ctx, {
    verb: toState === "done" ? "ticket.done" : "ticket.dropped",
  });
}

describe("cascadeOnClose", () => {
  describe("preconditions", () => {
    it("throws if the closed ticket doesn't exist on disk", async () => {
      await expect(
        cascadeOnClose(paths, newTicketId(), ctx, fakeLock(), clock),
      ).rejects.toMatchObject({ exitCode: 1 });
    });

    it("throws if the ticket is still in a live state (caller forgot to write the closure first)", async () => {
      const t = makeTicket({ state: "open" });
      await createTicket(paths, t, ctx, createdEvent);
      await expect(cascadeOnClose(paths, t.id, ctx, fakeLock(), clock)).rejects.toMatchObject({
        exitCode: 1,
      });
    });
  });

  describe("fan-out: one ticket blocking several", () => {
    it("unblocks every direct blockee that has no OTHER live blocker, and emits ticket.ready for each", async () => {
      const a = makeTicket({ state: "open" });
      const b = makeTicket({ state: "open" });
      const c = makeTicket({ state: "open" });
      const closer = makeTicket({ state: "open", blocks: [a.id, b.id, c.id] });
      for (const t of [a, b, c, closer]) await createTicket(paths, t, ctx, createdEvent);

      await closeTicket(closer.id, "done");
      const result = await cascadeOnClose(paths, closer.id, ctx, fakeLock(), clock);

      expect(result.unblocked.sort()).toEqual([a.id, b.id, c.id].sort());
      expect(result.events).toHaveLength(3);
      for (const event of result.events) {
        expect(event.verb).toBe("ticket.ready");
        expect(event.payload).toEqual({ unblocked_by: closer.id });
        expect(["ticket", event.entity.kind]).toContain("ticket");
      }
      const unblockedByEvent = result.events.map((e) => e.entity.id).sort();
      expect(unblockedByEvent).toEqual([a.id, b.id, c.id].sort());
    });

    it("does NOT unblock a ticket that has another still-live blocker (diamond)", async () => {
      // target is blocked by BOTH `closer` and `other` — closing `closer`
      // alone must leave it blocked. A naive "decrement and flip"
      // implementation gets this wrong.
      const target = makeTicket({ state: "open" });
      const other = makeTicket({ state: "open", blocks: [target.id] });
      const closer = makeTicket({ state: "open", blocks: [target.id] });
      for (const t of [target, other, closer]) await createTicket(paths, t, ctx, createdEvent);

      await closeTicket(closer.id, "done");
      const result = await cascadeOnClose(paths, closer.id, ctx, fakeLock(), clock);

      expect(result.unblocked).toEqual([]);
      expect(result.events).toEqual([]);

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === target.id);
      expect(row?.blocked_count).toBe(1);
      expect(row?.ready).toBe(false);
    });

    it("a diamond IS unblocked once its LAST live blocker closes", async () => {
      const target = makeTicket({ state: "open" });
      const first = makeTicket({ state: "open", blocks: [target.id] });
      const second = makeTicket({ state: "open", blocks: [target.id] });
      for (const t of [target, first, second]) await createTicket(paths, t, ctx, createdEvent);

      await closeTicket(first.id, "done");
      const firstResult = await cascadeOnClose(paths, first.id, ctx, fakeLock(), clock);
      expect(firstResult.unblocked).toEqual([]); // `second` still blocks it

      await closeTicket(second.id, "done");
      const secondResult = await cascadeOnClose(paths, second.id, ctx, fakeLock(), clock);
      expect(secondResult.unblocked).toEqual([target.id]);
      expect(secondResult.events).toHaveLength(1);
      expect(secondResult.events[0]?.payload).toEqual({ unblocked_by: second.id });

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === target.id);
      expect(row?.blocked_count).toBe(0);
      expect(row?.ready).toBe(true);
    });
  });

  describe("dropped blockers also stop blocking", () => {
    it("closing via drop unblocks exactly like done", async () => {
      const target = makeTicket({ state: "open" });
      const closer = makeTicket({ state: "open", blocks: [target.id] });
      await createTicket(paths, target, ctx, createdEvent);
      await createTicket(paths, closer, ctx, createdEvent);

      await closeTicket(closer.id, "dropped");
      const result = await cascadeOnClose(paths, closer.id, ctx, fakeLock(), clock);
      expect(result.unblocked).toEqual([target.id]);
    });
  });

  describe("non-open blockees never flip ready", () => {
    it("a blockee that is in_progress/draft/review/done/dropped is never returned as unblocked", async () => {
      const inProgressBlockee = makeTicket({ state: "in_progress" });
      const draftBlockee = makeTicket({ state: "draft" });
      const closer = makeTicket({
        state: "open",
        blocks: [inProgressBlockee.id, draftBlockee.id],
      });
      await createTicket(paths, inProgressBlockee, ctx, createdEvent);
      await createTicket(paths, draftBlockee, ctx, createdEvent);
      await createTicket(paths, closer, ctx, createdEvent);

      await closeTicket(closer.id, "done");
      const result = await cascadeOnClose(paths, closer.id, ctx, fakeLock(), clock);
      expect(result.unblocked).toEqual([]);
    });
  });

  describe("unblocked ordering", () => {
    it("returns unblocked ids in ascending (creation) order regardless of `blocks` array order", async () => {
      const a = makeTicket({ state: "open" });
      const b = makeTicket({ state: "open" });
      const c = makeTicket({ state: "open" });
      // Deliberately out-of-order `blocks` array.
      const closer = makeTicket({ state: "open", blocks: [c.id, a.id, b.id] });
      for (const t of [a, b, c, closer]) await createTicket(paths, t, ctx, createdEvent);

      await closeTicket(closer.id, "done");
      const result = await cascadeOnClose(paths, closer.id, ctx, fakeLock(), clock);
      expect(result.unblocked).toEqual([a.id, b.id, c.id].sort());
    });
  });

  describe("idempotency", () => {
    it("calling it twice for the same closure emits ZERO new ticket.ready events the second time (adversarial-review regression: a re-invocation used to duplicate every already-unblocked ticket's event)", async () => {
      const target = makeTicket({ state: "open" });
      const closer = makeTicket({ state: "open", blocks: [target.id] });
      await createTicket(paths, target, ctx, createdEvent);
      await createTicket(paths, closer, ctx, createdEvent);

      await closeTicket(closer.id, "done");

      const first = await cascadeOnClose(paths, closer.id, ctx, fakeLock(), clock);
      expect(first.unblocked).toEqual([target.id]);
      expect(first.events).toHaveLength(1);
      expect(first.events[0]?.verb).toBe("ticket.ready");
      expect(first.events[0]?.payload).toEqual({ unblocked_by: closer.id });

      const second = await cascadeOnClose(paths, closer.id, ctx, fakeLock(), clock);
      // `target` is still truthfully open with blocked_count 0, so
      // `unblocked` — recompute-from-truth, unchanged by this fix — still
      // names it. But it was ALREADY notified by the first call, so the
      // dedup guard (module doc: "Emission is deduplicated against the
      // event log") must make the second call write NO event for it.
      expect(second.unblocked).toEqual([target.id]);
      expect(second.events).toEqual([]);

      // Cross-check the full event log on disk, not just the return value —
      // exactly ONE ticket.ready must ever exist for this closure, never two.
      const allEvents = await listEvents(paths);
      const readyEvents = allEvents.filter((e) => e.verb === "ticket.ready");
      expect(readyEvents).toHaveLength(1);
      expect(readyEvents[0]?.payload).toEqual({ unblocked_by: closer.id });
    });
  });

  describe("end-to-end: real .slop/db/.lock, one transaction covering the close + cascade", () => {
    it("closing a ticket under a real withLock acquisition cascades correctly", async () => {
      const target = makeTicket({ state: "open" });
      const closer = makeTicket({ state: "open", blocks: [target.id] });
      await createTicket(paths, target, ctx, createdEvent);
      await createTicket(paths, closer, ctx, createdEvent);

      const result = await withLock(paths.lockFile, async (lock) => {
        const before = closer;
        const after: Ticket = { ...before, state: "done", active_session: null };
        await updateTicket(
          paths,
          closer.id,
          diffTicketPatch(before, after, TICKET_FIELDS),
          after,
          ctx,
          { verb: "ticket.done" },
        );
        await lock.assertHeld();
        return cascadeOnClose(paths, closer.id, ctx, lock, clock);
      });

      expect(result.unblocked).toEqual([target.id]);
      expect(result.events).toHaveLength(1);

      const index = await buildIndex(paths, clock);
      const row = index.tickets.find((r) => r.id === target.id);
      expect(row?.ready).toBe(true);
      expect(row?.blocked_count).toBe(0);
    });
  });

  describe("perf: dedup check does not re-scan the whole event log per candidate", () => {
    it("reads the event log exactly once for the whole cascade, regardless of how many candidates it unblocks", async () => {
      const M = 6;
      const targets: Ticket[] = [];
      for (let i = 0; i < M; i++) targets.push(makeTicket({ state: "open" }));
      const closer = makeTicket({ state: "open", blocks: targets.map((t) => t.id) });
      for (const t of [...targets, closer]) await createTicket(paths, t, ctx, createdEvent);

      await closeTicket(closer.id, "done");

      // M+1 `createTicket` calls + 1 closing `updateTicket` call = M+2
      // events on disk right before the cascade runs.
      const totalEventsBeforeCascade = (await listEventIds(paths)).length;
      expect(totalEventsBeforeCascade).toBe(M + 2);

      readFileMock.mockClear();
      const result = await cascadeOnClose(paths, closer.id, ctx, fakeLock(), clock);
      expect(result.unblocked).toHaveLength(M);
      expect(result.events).toHaveLength(M);

      const eventFileReads = readFileMock.mock.calls.filter(([path]) =>
        String(path).startsWith(paths.eventsDir),
      ).length;

      // The bug: one `queryEvents({ ticket })` full-log scan per candidate
      // would read the event log M times here — M * (M+2) reads. The fix
      // reads it exactly once, independent of M.
      expect(eventFileReads).toBe(totalEventsBeforeCascade);
    });
  });
});
