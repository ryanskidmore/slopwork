/**
 * Spec JSON (D10: "Specs = structured JSON, markdown inside").
 * `details_md` carries the free-form prose (rendered as markdown by
 * `slop show` / `slop web`); every other field is structured and
 * queryable. `v` is the *spec schema* version — separate from the
 * ticket's own `created_at`/`updated_at` — so a later work item can
 * migrate old specs without having to sniff their shape.
 */
import { z } from "zod";

export const SPEC_SCHEMA_VERSION = 1;

export const specSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  details_md: z.string().default(""),
  acceptance: z.array(z.string().min(1)).default([]),
  context: z.array(z.string().min(1)).default([]),
  meta: z.record(z.string(), z.unknown()).default({}),
  v: z.int().min(1).default(SPEC_SCHEMA_VERSION),
});
export type Spec = z.infer<typeof specSchema>;
