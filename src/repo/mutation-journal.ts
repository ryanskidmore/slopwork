/**
 * Durable write-ahead intents for entity mutations that must emit an
 * audit event. One journal file is written before the entity changes and
 * is removed only after both the entity state and its stable, pre-minted
 * event are durable.
 *
 * Recovery is a small compare-and-apply state machine:
 * - current === before: apply after, then ensure the event exists;
 * - current === after: the entity already committed, ensure the event;
 * - anything else: fail with no write, because another state cannot be
 *   safely overwritten from this intent.
 *
 * `null` means absence, giving create (`null -> text`), update
 * (`text -> text`), and delete (`text -> null`) the same replay rules.
 */
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SlopError } from "../cli/errors.js";
import {
  type Event,
  type EventId,
  eventSchema,
  isEventId,
  sessionIdSchema,
  ticketIdSchema,
} from "../core/index.js";
import { writeCanonical } from "../core/jsonc.js";
import { EXIT_CODES } from "../core/exit-codes.js";
import { atomicWriteFile, durableRemoveFile, isTempFileName } from "./atomic-write.js";
import { readEntityFile } from "./entity-file.js";
import { isEnoent, readDirSafe } from "./fs-utils.js";
import type { RepoPaths } from "./paths.js";

const JOURNAL_SCHEMA_VERSION = 1;

const mutationEntitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ticket"), id: ticketIdSchema }).strict(),
  z.object({ kind: z.literal("session"), id: sessionIdSchema }).strict(),
]);
export type MutationEntity = z.infer<typeof mutationEntitySchema>;

const mutationDescriptorSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create"),
      before_text: z.null(),
      after_text: z.string(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("update"),
      before_text: z.string(),
      after_text: z.string(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      before_text: z.string(),
      after_text: z.null(),
    })
    .strict(),
]);
export type MutationDescriptor = z.infer<typeof mutationDescriptorSchema>;
export type MutationPreparation = MutationDescriptor | (() => Promise<MutationDescriptor>);

const mutationJournalSchema = z
  .object({
    schema_version: z.literal(JOURNAL_SCHEMA_VERSION),
    entity: mutationEntitySchema,
    mutation: mutationDescriptorSchema,
    event: eventSchema,
  })
  .strict()
  .superRefine((journal, ctx) => {
    if (
      journal.event.entity.kind !== journal.entity.kind ||
      journal.event.entity.id !== journal.entity.id
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["event", "entity"],
        message: "must match the journal entity",
      });
    }
  });
export type MutationJournal = z.infer<typeof mutationJournalSchema>;

export interface MutationEventIo {
  readEvent(paths: RepoPaths, id: EventId): Promise<Event>;
  createEvent(paths: RepoPaths, event: Event): Promise<void>;
}

export function mutationJournalFilePath(paths: RepoPaths, eventId: EventId): string {
  return join(paths.mutationJournalDir, `${eventId}.jsonc`);
}

function entityFilePath(paths: RepoPaths, entity: MutationEntity): string {
  const dir = entity.kind === "ticket" ? paths.ticketsDir : paths.sessionsDir;
  return join(dir, `${entity.id}.jsonc`);
}

async function readCurrentText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    const cause = err instanceof Error ? err.message : String(err);
    throw new SlopError(
      `${path}: failed to inspect mutation state: ${cause}`,
      EXIT_CODES.GENERIC_ERROR,
    );
  }
}

function journalConflict(path: string, detail: string): SlopError {
  return new SlopError(
    `cannot recover mutation journal ${path}: ${detail}; the intent remains pending and conflicting data was not overwritten`,
    EXIT_CODES.CONFLICT,
  );
}

async function inspectExistingEvent(
  paths: RepoPaths,
  journalPath: string,
  expected: Event,
  io: MutationEventIo,
): Promise<"absent" | "matching"> {
  try {
    const existing = await io.readEvent(paths, expected.id);
    if (!isDeepStrictEqual(existing, expected)) {
      throw journalConflict(
        journalPath,
        `event ${expected.id} already exists with different content`,
      );
    }
    return "matching";
  } catch (err) {
    if (err instanceof SlopError && err.exitCode === EXIT_CODES.NOT_FOUND) return "absent";
    throw err;
  }
}

function testDelayAfterEntityMs(): number {
  // Test-only crash-window widener used by the real SIGKILL acceptance test.
  const raw = process.env.SLOP_TEST_MUTATION_DELAY_AFTER_ENTITY_MS;
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function throwInjectedEventWriteFailure(): void {
  // Test-only deterministic fault at the exact boundary this journal protects.
  if (process.env.SLOP_TEST_FAIL_MUTATION_EVENT_WRITE === "1") {
    throw new Error("injected mutation event write failure");
  }
}

async function replayOne(
  paths: RepoPaths,
  journalPath: string,
  journal: MutationJournal,
  io: MutationEventIo,
): Promise<Event> {
  const targetPath = entityFilePath(paths, journal.entity);
  const current = await readCurrentText(targetPath);
  const { before_text: before, after_text: after } = journal.mutation;
  const isBefore = current === before;
  const isAfter = current === after;
  if (!isBefore && !isAfter) {
    throw journalConflict(
      journalPath,
      `${journal.mutation.operation} target ${targetPath} matches neither recorded before nor after state`,
    );
  }

  // Check for an event-id collision before touching an entity that is
  // still at its before state.
  const eventState = await inspectExistingEvent(paths, journalPath, journal.event, io);

  if (!isAfter) {
    if (after === null) {
      await durableRemoveFile(targetPath);
    } else {
      await atomicWriteFile(targetPath, after);
    }

    const delayMs = testDelayAfterEntityMs();
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (eventState === "absent") {
    throwInjectedEventWriteFailure();
    await io.createEvent(paths, journal.event);
  }
  await durableRemoveFile(journalPath, { missing: "ignore" });
  return journal.event;
}

function journalNames(paths: RepoPaths): Promise<string[]> {
  return readDirSafe(paths.mutationJournalDir);
}

async function loadJournals(
  paths: RepoPaths,
): Promise<Array<{ path: string; journal: MutationJournal }>> {
  const loaded: Array<{ path: string; journal: MutationJournal }> = [];
  for (const name of (await journalNames(paths)).sort()) {
    if (name === ".gitkeep" || isTempFileName(name)) continue;
    if (!name.endsWith(".jsonc")) {
      throw new SlopError(
        `invalid mutation journal entry ${join(paths.mutationJournalDir, name)}: expected <event-id>.jsonc`,
        EXIT_CODES.GENERIC_ERROR,
      );
    }
    const id = name.slice(0, -".jsonc".length);
    if (!isEventId(id)) {
      throw new SlopError(
        `invalid mutation journal filename ${name}: expected event_<ULID>.jsonc`,
        EXIT_CODES.GENERIC_ERROR,
      );
    }
    const path = join(paths.mutationJournalDir, name);
    const journal = await readEntityFile(path, mutationJournalSchema);
    if (journal.event.id !== id) {
      throw new SlopError(
        `invalid mutation journal ${path}: filename id ${id} does not match event.id ${journal.event.id}`,
        EXIT_CODES.GENERIC_ERROR,
      );
    }
    loaded.push({ path, journal });
  }
  return loaded;
}

export async function hasPendingMutationJournals(paths: RepoPaths): Promise<boolean> {
  return (await journalNames(paths)).some((name) => name !== ".gitkeep" && !isTempFileName(name));
}

/** Replay every fully validated pending journal in stable event-id order. */
export async function recoverMutationJournals(
  paths: RepoPaths,
  io: MutationEventIo,
): Promise<Event[]> {
  // Parse all records before applying any. A corrupt second record must
  // not be discovered only after a valid first one has already changed data.
  const journals = await loadJournals(paths);
  const recovered: Event[] = [];
  for (const { path, journal } of journals) {
    recovered.push(await replayOne(paths, path, journal, io));
  }
  return recovered;
}

/** Persist one intent, then drive the same idempotent replay path used after restart. */
export async function commitMutationWithEvent(
  paths: RepoPaths,
  event: Event,
  entity: MutationEntity,
  preparation: MutationPreparation,
  io: MutationEventIo,
): Promise<Event> {
  await recoverMutationJournals(paths, io);
  const mutation = typeof preparation === "function" ? await preparation() : preparation;
  const journal: MutationJournal = mutationJournalSchema.parse({
    schema_version: JOURNAL_SCHEMA_VERSION,
    entity,
    mutation,
    event,
  });
  const path = mutationJournalFilePath(paths, event.id);
  if ((await readCurrentText(path)) !== null) {
    throw journalConflict(path, "an intent with this event id already exists");
  }
  await atomicWriteFile(path, writeCanonical(journal));
  return replayOne(paths, path, journal, io);
}
