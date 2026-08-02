/**
 * Neutral contract for the derived ticket index.
 *
 * The flatfile repository persists and validates this shape, while storage
 * ports, domain queries, CLI rendering, and future remote adapters consume it.
 * Keeping the schema here prevents those consumers from depending on the
 * flatfile adapter merely to name the shared DTO.
 */
import { z } from "zod";
import { actorSchema } from "./entities/actor.js";
import { parentRefSchema } from "./entities/ref.js";
import { labelSchema, prioritySchema, ticketStateSchema } from "./entities/ticket.js";
import { eventIdSchema, sessionIdSchema, ticketIdSchema } from "./ids.js";
import { slugSchema } from "./slug.js";
import { isoTimestampSchema } from "./timestamp.js";

/** Event-integrity diagnostics bump it 5 -> 6: `event_problems` records
 * skipped/duplicate/misplaced event files the same way `problems` already
 * does for tickets. */
export const INDEX_SCHEMA_VERSION = 6;

export const indexTicketRowSchema = z.object({
  id: ticketIdSchema,
  slug: slugSchema,
  name: z.string(),
  state: ticketStateSchema,
  priority: prioritySchema,
  parent: parentRefSchema.nullable(),
  root_id: ticketIdSchema,
  path: z.array(ticketIdSchema),
  labels: z.array(labelSchema),
  latest_note: z.string().nullable(),
  last_activity_at: isoTimestampSchema,
  active_session: sessionIdSchema.nullable(),
  owner: actorSchema.nullable(),
  blocked_by: z.array(ticketIdSchema),
  related_from: z.array(ticketIdSchema),
  discovered: z.array(ticketIdSchema),
  blocked_count: z.number().int().nullable(),
  ready: z.boolean().nullable(),
  stale_at: isoTimestampSchema.nullable(),
  review_stale_at: isoTimestampSchema.nullable(),
  awaiting_input: z.boolean(),
  open_question_count: z.number().int(),
  oldest_open_question_at: isoTimestampSchema.nullable(),
});
export type IndexTicketRow = z.infer<typeof indexTicketRowSchema>;

export const dirFingerprintSchema = z.object({
  count: z.number().int().min(0),
  digest: z.string(),
});
export type DirFingerprint = z.infer<typeof dirFingerprintSchema>;

export const contentFingerprintSchema = z.record(z.string(), dirFingerprintSchema);
export type ContentFingerprint = z.infer<typeof contentFingerprintSchema>;

export const ticketReadProblemSchema = z.object({
  id: ticketIdSchema,
  path: z.string(),
  message: z.string(),
});
export type TicketReadProblem = z.infer<typeof ticketReadProblemSchema>;

/** One event file a tolerant bulk read could not admit: unparseable/
 * schema-invalid content, a filename that doesn't match its own id, an id
 * mismatch between filename and payload, a shard/month mismatch, or a
 * duplicate id already seen elsewhere. `id` is `null` when the filename
 * itself couldn't even be parsed into a candidate id. */
export const eventReadProblemSchema = z.object({
  kind: z.enum(["invalid_filename", "read_error", "id_mismatch", "wrong_shard", "duplicate_id"]),
  id: eventIdSchema.nullable(),
  path: z.string(),
  message: z.string(),
});
export type EventReadProblem = z.infer<typeof eventReadProblemSchema>;

export const duplicateSlugProblemSchema = z.object({
  slug: slugSchema,
  ids: z.array(ticketIdSchema).min(2),
});
export type DuplicateSlugProblem = z.infer<typeof duplicateSlugProblemSchema>;

export const dbIndexSchema = z.object({
  schema_version: z.literal(INDEX_SCHEMA_VERSION),
  built_at: isoTimestampSchema,
  fingerprint: contentFingerprintSchema,
  tickets: z.array(indexTicketRowSchema),
  slugs: z.record(z.string(), ticketIdSchema),
  problems: z.array(ticketReadProblemSchema),
  /** Event files omitted while building event-derived overlays. A
   * non-empty list forces each load to retry the read so an in-place
   * repair is visible even when the cheap fingerprint is unchanged. */
  event_problems: z.array(eventReadProblemSchema),
  slug_problems: z.array(duplicateSlugProblemSchema),
});
export type DbIndex = z.infer<typeof dbIndexSchema>;

export type IndexLoadReason =
  | "fresh"
  | "missing"
  | "parse_error"
  | "stale_schema_version"
  | "invalid_schema"
  | "stale_content";

export interface LoadIndexResult {
  index: DbIndex;
  /** `true` if this call had to rebuild and rewrite the index. */
  rebuilt: boolean;
  reason: IndexLoadReason;
}

export function formatIndexProblems(problems: readonly TicketReadProblem[]): string {
  const header = `${problems.length} ticket file(s) could not be read and were skipped while building the index:`;
  const body = problems.map((problem) => {
    const indented = problem.message
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    return `  - ${problem.path}\n${indented}`;
  });
  return [header, ...body].join("\n");
}

export function formatDuplicateSlugProblems(problems: readonly DuplicateSlugProblem[]): string {
  const header =
    `${problems.length} slug(s) are claimed by more than one ticket (a cross-clone merge collision) ` +
    "— resolving any of them by slug is ambiguous (AMBIGUOUS_REF, exit 5) until healed:";
  const body = problems.map((problem) => `  - "${problem.slug}": ${problem.ids.join(", ")}`);
  return [
    header,
    ...body,
    "  run `slop reindex --heal` to deterministically re-suffix the newer duplicate(s) " +
      "(the OLDEST ticket, by id, keeps the slug).",
  ].join("\n");
}
