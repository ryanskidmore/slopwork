import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Event,
  type Ticket,
  eventSchema,
  newEventId,
  newTicketId,
  ticketSchema,
} from "../core/index.js";
import { parseJsonc, writeCanonical } from "../core/jsonc.js";
import {
  createEvent,
  listEvents,
  readEvent,
  recoverMutationEvents,
  withMutationEvent,
} from "./events.js";
import {
  commitMutationWithEvent,
  type MutationJournal,
  mutationJournalFilePath,
} from "./mutation-journal.js";
import { ensureDbDirs } from "./paths.js";
import type { RepoPaths } from "./paths.js";
import { createTicket, readTicket, ticketFilePath, updateTicket } from "./tickets.js";
import { FlatfileBackend } from "../storage/flatfile.js";

const ctx = { actor: { name: "recovery-test", kind: "agent" as const }, session: null };

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "Recover an atomic mutation",
    slug: `recover-${id.slice(-8).toLowerCase()}`,
    spec: { summary: "Keep entity state and its audit event together" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: ctx.actor },
    last_activity_at: "2026-08-02T12:00:00.000Z",
    created_at: "2026-08-02T12:00:00.000Z",
    updated_at: "2026-08-02T12:00:00.000Z",
    ...overrides,
  });
}

function makeEvent(ticket: Ticket): Event {
  return eventSchema.parse({
    id: newEventId(),
    actor: ctx.actor,
    session: null,
    verb: "ticket.created",
    entity: { kind: "ticket", id: ticket.id },
    payload: {},
    at: "2026-08-02T12:00:00.000Z",
  });
}

async function onlyJournal(
  paths: RepoPaths,
): Promise<{ path: string; raw: string; value: MutationJournal }> {
  const names = (await readdir(paths.mutationJournalDir)).filter((name) => name.endsWith(".jsonc"));
  expect(names).toHaveLength(1);
  const name = names[0];
  if (!name) throw new Error("expected one mutation journal");
  const path = join(paths.mutationJournalDir, name);
  const raw = await readFile(path, "utf8");
  const parsed = parseJsonc<MutationJournal>(raw);
  expect(parsed.errors).toEqual([]);
  return { path, raw, value: parsed.value };
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

let scratch: string;
let paths: RepoPaths;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-mutation-journal-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  delete process.env.SLOP_TEST_FAIL_MUTATION_EVENT_WRITE;
  await rm(scratch, { recursive: true, force: true });
});

describe("durable mutation journal recovery", () => {
  it("retires the intent after a normal entity and event commit", async () => {
    const ticket = makeTicket();
    const event = await createTicket(paths, ticket, ctx, { verb: "ticket.created" });

    await expect(readTicket(paths, ticket.id)).resolves.toEqual(ticket);
    await expect(listEvents(paths)).resolves.toEqual([event]);
    await expect(readdir(paths.mutationJournalDir)).resolves.toEqual([]);
  });

  it("recovers an entity committed before its event and emits the event exactly once", async () => {
    const ticket = makeTicket();
    process.env.SLOP_TEST_FAIL_MUTATION_EVENT_WRITE = "1";
    await expect(createTicket(paths, ticket, ctx, { verb: "ticket.created" })).rejects.toThrow(
      "injected mutation event write failure",
    );

    await expect(readTicket(paths, ticket.id)).resolves.toEqual(ticket);
    await expect(listEvents(paths)).resolves.toEqual([]);
    const pending = await onlyJournal(paths);

    delete process.env.SLOP_TEST_FAIL_MUTATION_EVENT_WRITE;
    const recovered = await recoverMutationEvents(paths);
    expect(recovered).toEqual([pending.value.event]);
    await expect(listEvents(paths)).resolves.toEqual([pending.value.event]);
    await expectMissing(pending.path);

    // Replaying the same fully committed intent is harmless and must not
    // mint a replacement event.
    await writeFile(pending.path, pending.raw);
    await recoverMutationEvents(paths);
    await expect(listEvents(paths)).resolves.toEqual([pending.value.event]);
    await expectMissing(pending.path);
  });

  it("recovers pending work before a transaction callback runs", async () => {
    const ticket = makeTicket();
    const backend = new FlatfileBackend(paths);
    process.env.SLOP_TEST_FAIL_MUTATION_EVENT_WRITE = "1";
    await expect(backend.createTicket(ticket, ctx, { verb: "ticket.created" })).rejects.toThrow(
      "injected mutation event write failure",
    );

    delete process.env.SLOP_TEST_FAIL_MUTATION_EVENT_WRITE;
    let observedInsideTransaction = false;
    await backend.transact(async () => {
      observedInsideTransaction = true;
      await expect(backend.readTicket(ticket.id)).resolves.toEqual(ticket);
      await expect(backend.listEvents()).resolves.toHaveLength(1);
    });

    expect(observedInsideTransaction).toBe(true);
    await expect(readdir(paths.mutationJournalDir)).resolves.toEqual([]);
  });

  it("replays an intent whose entity is still at the recorded before state", async () => {
    const ticket = makeTicket();
    const event = makeEvent(ticket);
    const journal: MutationJournal = {
      schema_version: 1,
      entity: { kind: "ticket", id: ticket.id },
      mutation: {
        operation: "create",
        before_text: null,
        after_text: writeCanonical(ticket),
      },
      event,
    };
    const path = mutationJournalFilePath(paths, event.id);
    await writeFile(path, writeCanonical(journal));

    await recoverMutationEvents(paths);

    await expect(readTicket(paths, ticket.id)).resolves.toEqual(ticket);
    await expect(listEvents(paths)).resolves.toEqual([event]);
    await expectMissing(path);
  });

  it("recovers older work before preparing the next update's before state", async () => {
    const ticket = makeTicket({ priority: 2 });
    await createTicket(paths, ticket, ctx, { verb: "ticket.created" });
    const firstUpdate = {
      ...ticket,
      priority: 0,
      updated_at: "2026-08-02T12:30:00.000Z",
    };
    const firstEvent = eventSchema.parse({
      ...makeEvent(ticket),
      verb: "ticket.updated",
      payload: { priority: 0 },
    });
    const firstJournal: MutationJournal = {
      schema_version: 1,
      entity: { kind: "ticket", id: ticket.id },
      mutation: {
        operation: "update",
        before_text: await readFile(ticketFilePath(paths, ticket.id), "utf8"),
        after_text: writeCanonical(firstUpdate),
      },
      event: firstEvent,
    };
    await writeFile(mutationJournalFilePath(paths, firstEvent.id), writeCanonical(firstJournal));
    const final = {
      ...firstUpdate,
      name: "Prepared after recovery",
      updated_at: "2026-08-02T13:00:00.000Z",
    };

    await updateTicket(
      paths,
      ticket.id,
      [
        { path: ["name"], value: final.name },
        { path: ["updated_at"], value: final.updated_at },
      ],
      final,
      ctx,
      { verb: "ticket.updated", payload: { name: final.name } },
    );

    await expect(readTicket(paths, ticket.id)).resolves.toEqual(final);
    await expect(listEvents(paths)).resolves.toHaveLength(3);
    await expect(readdir(paths.mutationJournalDir)).resolves.toEqual([]);
  });

  it("recovers an update without dropping preserved JSONC comments", async () => {
    const ticket = makeTicket({ priority: 2 });
    await createTicket(paths, ticket, ctx, { verb: "ticket.created" });
    const path = ticketFilePath(paths, ticket.id);
    await writeFile(path, `// manually triaged\n${await readFile(path, "utf8")}`);
    const after = { ...ticket, priority: 0, updated_at: "2026-08-02T13:00:00.000Z" };

    process.env.SLOP_TEST_FAIL_MUTATION_EVENT_WRITE = "1";
    await expect(
      updateTicket(
        paths,
        ticket.id,
        [
          { path: ["priority"], value: 0 },
          { path: ["updated_at"], value: after.updated_at },
        ],
        after,
        ctx,
        { verb: "ticket.updated" },
      ),
    ).rejects.toThrow("injected mutation event write failure");

    delete process.env.SLOP_TEST_FAIL_MUTATION_EVENT_WRITE;
    await recoverMutationEvents(paths);

    expect(await readFile(path, "utf8")).toContain("// manually triaged");
    await expect(readTicket(paths, ticket.id)).resolves.toEqual(after);
    await expect(listEvents(paths)).resolves.toHaveLength(2);
  });

  it("uses the same replay state machine for a delete intent", async () => {
    const ticket = makeTicket();
    await createTicket(paths, ticket, ctx, { verb: "ticket.created" });
    const path = ticketFilePath(paths, ticket.id);
    const before = await readFile(path, "utf8");

    process.env.SLOP_TEST_FAIL_MUTATION_EVENT_WRITE = "1";
    await expect(
      withMutationEvent(
        paths,
        ctx,
        { kind: "ticket", id: ticket.id },
        { verb: "ticket.updated", payload: { maintenance_delete: true } },
        { operation: "delete", before_text: before, after_text: null },
      ),
    ).rejects.toThrow("injected mutation event write failure");
    await expectMissing(path);

    delete process.env.SLOP_TEST_FAIL_MUTATION_EVENT_WRITE;
    await recoverMutationEvents(paths);

    await expectMissing(path);
    await expect(listEvents(paths)).resolves.toHaveLength(2);
    await expect(readdir(paths.mutationJournalDir)).resolves.toEqual([]);
  });

  it("leaves a divergent entity and its intent untouched for manual resolution", async () => {
    const ticket = makeTicket();
    process.env.SLOP_TEST_FAIL_MUTATION_EVENT_WRITE = "1";
    await expect(createTicket(paths, ticket, ctx, { verb: "ticket.created" })).rejects.toThrow(
      "injected mutation event write failure",
    );
    const pending = await onlyJournal(paths);
    const divergent = { ...ticket, name: "Concurrent manual edit" };
    await writeFile(ticketFilePath(paths, ticket.id), writeCanonical(divergent));

    delete process.env.SLOP_TEST_FAIL_MUTATION_EVENT_WRITE;
    await expect(recoverMutationEvents(paths)).rejects.toMatchObject({ exitCode: 6 });

    await expect(readTicket(paths, ticket.id)).resolves.toEqual(divergent);
    await expect(listEvents(paths)).resolves.toEqual([]);
    await expect(readFile(pending.path, "utf8")).resolves.toBe(pending.raw);
  });

  it("never overwrites a different event that already owns the intent id", async () => {
    const ticket = makeTicket();
    process.env.SLOP_TEST_FAIL_MUTATION_EVENT_WRITE = "1";
    await expect(createTicket(paths, ticket, ctx, { verb: "ticket.created" })).rejects.toThrow(
      "injected mutation event write failure",
    );
    const pending = await onlyJournal(paths);
    const colliding = eventSchema.parse({
      ...pending.value.event,
      payload: { unexpected: true },
    });
    await createEvent(paths, colliding);

    delete process.env.SLOP_TEST_FAIL_MUTATION_EVENT_WRITE;
    await expect(recoverMutationEvents(paths)).rejects.toMatchObject({ exitCode: 6 });

    await expect(readTicket(paths, ticket.id)).resolves.toEqual(ticket);
    await expect(listEvents(paths)).resolves.toEqual([colliding]);
    await expect(readFile(pending.path, "utf8")).resolves.toBe(pending.raw);
  });

  it("fails loudly on a corrupt journal before applying any valid journal", async () => {
    const ticket = makeTicket();
    const event = makeEvent(ticket);
    const validPath = mutationJournalFilePath(paths, event.id);
    const valid: MutationJournal = {
      schema_version: 1,
      entity: { kind: "ticket", id: ticket.id },
      mutation: {
        operation: "create",
        before_text: null,
        after_text: writeCanonical(ticket),
      },
      event,
    };
    await writeFile(validPath, writeCanonical(valid));
    const corruptId = newEventId();
    await writeFile(mutationJournalFilePath(paths, corruptId), "{ definitely not jsonc");

    await expect(recoverMutationEvents(paths)).rejects.toMatchObject({ exitCode: 1 });

    await expectMissing(ticketFilePath(paths, ticket.id));
    await expect(listEvents(paths)).resolves.toEqual([]);
    await expect(readFile(validPath, "utf8")).resolves.toBe(writeCanonical(valid));
  });

  it("rejects a journal whose event doesn't name the same entity it mutates", async () => {
    const ticket = makeTicket();
    const other = makeTicket();
    const event = eventSchema.parse({
      ...makeEvent(ticket),
      entity: { kind: "ticket", id: other.id },
    });
    const journal: MutationJournal = {
      schema_version: 1,
      entity: { kind: "ticket", id: ticket.id },
      mutation: { operation: "create", before_text: null, after_text: writeCanonical(ticket) },
      event,
    };
    await writeFile(mutationJournalFilePath(paths, event.id), writeCanonical(journal));

    await expect(recoverMutationEvents(paths)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("must match the journal entity"),
    });
  });

  it("skips .gitkeep placeholders in the journal directory instead of treating them as intents", async () => {
    await writeFile(join(paths.mutationJournalDir, ".gitkeep"), "");

    await expect(recoverMutationEvents(paths)).resolves.toEqual([]);
    await expect(access(join(paths.mutationJournalDir, ".gitkeep"))).resolves.toBeUndefined();
  });

  it("fails loudly on a journal entry that isn't a .jsonc file", async () => {
    await writeFile(join(paths.mutationJournalDir, "not-a-journal.txt"), "whatever");

    await expect(recoverMutationEvents(paths)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("expected <event-id>.jsonc"),
    });
  });

  it("fails loudly on a journal filename that isn't a valid event id", async () => {
    await writeFile(join(paths.mutationJournalDir, "not-an-event-id.jsonc"), "{}");

    await expect(recoverMutationEvents(paths)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("expected event_<ULID>.jsonc"),
    });
  });

  it("fails loudly when a journal's filename id disagrees with its own event.id", async () => {
    const ticket = makeTicket();
    const event = makeEvent(ticket);
    const journal: MutationJournal = {
      schema_version: 1,
      entity: { kind: "ticket", id: ticket.id },
      mutation: { operation: "create", before_text: null, after_text: writeCanonical(ticket) },
      event,
    };
    // Written under a DIFFERENT event id's filename than the journal's own event.id.
    const mismatchedId = newEventId();
    await writeFile(mutationJournalFilePath(paths, mismatchedId), writeCanonical(journal));

    await expect(recoverMutationEvents(paths)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("does not match event.id"),
    });
  });

  it("refuses to commit a new intent whose journal path is occupied when it goes to write", async () => {
    // recoverMutationJournals runs before this function ever writes its own
    // journal, so an ordinary pre-existing file at the same path would
    // already be drained by the time the "already exists" check runs. A
    // `preparation` callback (invoked between recovery and the write) can
    // still land a file in that exact window, which is what this simulates.
    const ticket = makeTicket();
    const event = makeEvent(ticket);
    const path = mutationJournalFilePath(paths, event.id);

    await expect(
      commitMutationWithEvent(
        paths,
        event,
        { kind: "ticket", id: ticket.id },
        async () => {
          await writeFile(path, "{}");
          return { operation: "create", before_text: null, after_text: writeCanonical(ticket) };
        },
        { readEvent, createEvent },
      ),
    ).rejects.toMatchObject({
      exitCode: 6,
      message: expect.stringContaining("an intent with this event id already exists"),
    });
  });
});
