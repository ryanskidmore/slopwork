/**
 * Session (design.md §4.1 item 3, D9: "Sessions replace claims — sessions
 * are real harness sessions ... with ids and git context").
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
});
export type Session = z.infer<typeof sessionSchema>;
