/**
 * Session (design.md §4.1 item 3, D9: "Sessions replace claims — sessions
 * are real harness sessions ... with ids, git context, and transcripts").
 */
import { z } from "zod";
import { sessionIdSchema, ticketIdSchema } from "../ids.js";
import { isoTimestampSchema } from "../timestamp.js";
import { actorSchema } from "./actor.js";

export const HARNESS_KINDS = ["claude-code", "opencode", "codex", "other"] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];
export const harnessKindSchema = z.enum(HARNESS_KINDS);

/**
 * The harness's own session id, when the harness exposes one (S1
 * sniffing). Nullable — not every harness does, and `--harness` /
 * detection failing is handled by falling back to `"other"`, never by
 * blocking `start`.
 */
export const harnessSchema = z.object({
  kind: harnessKindSchema,
  session_id: z.string().nullable(),
});
export type Harness = z.infer<typeof harnessSchema>;

/** Git context captured at `start` time. Nullable — not every working directory is a git repo. */
export const sessionGitSchema = z.object({
  branch: z.string().nullable(),
  commit_at_start: z.string().nullable(),
});
export type SessionGit = z.infer<typeof sessionGitSchema>;

export const planStepSchema = z.object({
  text: z.string().trim().min(1),
  checked: z.boolean().default(false),
});
export type PlanStep = z.infer<typeof planStepSchema>;

/**
 * One versioned snapshot of a session's plan (C2: "plan v2 diffable from
 * v1"). `sessionSchema.plan` is an ordered list of these — never a single
 * mutable step array — so a revision is a brand new version appended to
 * the list, and diffing v1 vs v2 is just comparing two array elements.
 */
export const planVersionSchema = z.object({
  version: z.int().min(1),
  steps: z.array(planStepSchema).default([]),
  created_at: isoTimestampSchema,
});
export type PlanVersion = z.infer<typeof planVersionSchema>;

/**
 * §4.3: "warn, record `transcript_ref: null`, never block the state
 * change" — `null` is load-bearing and stays valid here. When non-null,
 * the real writer always produces a path relative to the `.slop` root,
 * e.g. `"transcripts/session_….jsonl"` (D5's convention — see
 * `openTranscript` in src/web/fixture-data-source.ts).
 *
 * A value that couldn't possibly be that shape — a leading `/` (absolute
 * path) or any `..` segment — is *sanitised to `null`* rather than
 * failing the parse. That's deliberate, not a shortcut: `sessionSchema`
 * is parsed one file at a time by `readJsoncDir` (src/web/fixture-data
 * -source.ts), which aborts an entire directory listing on the first
 * file that fails validation. Throwing here would let one tampered
 * `transcript_ref` in `.slop/db` (a git-mergeable, collaborator-editable
 * store — a realistic way for a bad value to show up) take down every
 * ticket/session view that touches that directory, trading a path-
 * traversal bug for a denial-of-service one. Falling back to `null`
 * instead reuses the exact "couldn't find the transcript" path §4.3
 * already treats as expected and non-fatal — same as this field's normal
 * degraded case, not a special error path.
 *
 * This is still only the first line of defense, not the only one:
 * `openTranscript` independently re-checks the *resolved* path stays
 * inside the `.slop` root before ever opening a file, so even a
 * hypothetical bypass of this sanitisation (or a caller that never runs
 * it) can't read outside the root.
 */
export const transcriptRefSchema = z
  .string()
  .nullable()
  .transform((ref) => (ref !== null && isUnsafeTranscriptRef(ref) ? null : ref))
  .default(null);

function isUnsafeTranscriptRef(ref: string): boolean {
  return ref.startsWith("/") || ref.split("/").includes("..");
}

/**
 * housekeeping-gitignore-lock-stale: `end_summary` is the handoff/summary
 * text behind `stop`'s `--note`, `done`'s `--note`, and `drop`'s
 * `--reason` — free-form text an agent types, previously unbounded. A
 * generous ceiling (a genuine multi-paragraph handoff comfortably fits)
 * that still stops an accidentally-piped-in file or a runaway generation
 * from landing whole in the db. `src/cli/commands/shared.ts`'s
 * `assertMaxLength` enforces this same bound up front, at the CLI layer,
 * for a clean `USAGE_ERROR` (exit 2) instead of a schema-validation error
 * surfacing several calls deeper.
 */
export const END_SUMMARY_MAX_LENGTH = 10_000;

export const sessionSchema = z.object({
  id: sessionIdSchema,
  ticket: ticketIdSchema,
  actor: actorSchema,
  harness: harnessSchema,
  git: sessionGitSchema,
  started_at: isoTimestampSchema,
  ended_at: isoTimestampSchema.nullable().default(null),
  plan: z.array(planVersionSchema).default([]),
  end_summary: z.string().max(END_SUMMARY_MAX_LENGTH).nullable().default(null),
  // See transcriptRefSchema above for the full contract and rationale.
  transcript_ref: transcriptRefSchema,
});
export type Session = z.infer<typeof sessionSchema>;
