/**
 * `.slop/config.yaml` (design.md §3). YAML parsing itself is D1/A3's job
 * — this schema only validates + defaults the plain object a YAML parser
 * hands back.
 */
import { z } from "zod";
import { durationStringSchema } from "../duration.js";

export const TRANSCRIPTS_MODES = ["local", "commit", "off"] as const;
export type TranscriptsMode = (typeof TRANSCRIPTS_MODES)[number];
export const transcriptsModeSchema = z.enum(TRANSCRIPTS_MODES);

export const DEFAULT_STALE_AFTER = "60m";
export const DEFAULT_REVIEW_STALE_AFTER = "24h";
export const DEFAULT_TRANSCRIPTS_MODE: TranscriptsMode = "local";

export const configRemotesSchema = z.object({
  /** Autodetected from the git remote at `init` time (design.md §3); absent if detection failed. */
  repo: z.url().optional(),
  /**
   * "prompted or blank" (design.md §3) — an explicit empty string is a
   * legitimate "not configured yet", distinct from the key being absent
   * entirely (never prompted).
   */
  jira: z.union([z.url(), z.literal("")]).optional(),
});
export type ConfigRemotes = z.infer<typeof configRemotesSchema>;

export const configDefaultsSchema = z.object({
  stale_after: durationStringSchema.default(DEFAULT_STALE_AFTER),
  review_stale_after: durationStringSchema.default(DEFAULT_REVIEW_STALE_AFTER),
});
export type ConfigDefaults = z.infer<typeof configDefaultsSchema>;

export const configSchema = z.object({
  project: z.string().trim().min(1),
  /** Actor fallback (D17) — `user:` in config.yaml, checked after `--as` and `SLOP_ACTOR`. */
  user: z.string().trim().min(1).optional(),
  // `.default(() => schema.parse({}))`, not `.default({})`: zod's
  // `.default(<literal>)` substitutes the literal directly when the key
  // is missing WITHOUT re-running the inner schema's own field defaults
  // (verified directly against this zod version — an easy silent-bug
  // trap, worth the comment). `.default(() => schema.parse({}))` runs a
  // full parse of `{}` through the inner schema instead, so nested
  // defaults (stale_after, review_stale_after) still apply when the
  // whole `defaults:` key is absent from config.yaml, not just when it's
  // present-but-empty.
  remotes: configRemotesSchema.default(() => configRemotesSchema.parse({})),
  defaults: configDefaultsSchema.default(() => configDefaultsSchema.parse({})),
  transcripts: transcriptsModeSchema.default(DEFAULT_TRANSCRIPTS_MODE),
});
export type Config = z.infer<typeof configSchema>;
