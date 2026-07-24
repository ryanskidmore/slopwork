/**
 * Ticket (design.md §4.1 item 1). See §2 for the state model and §4.1 for
 * the field-by-field shape this schema follows.
 */
import { z } from "zod";
import { sessionIdSchema, ticketIdSchema } from "../ids.js";
import { slugSchema } from "../slug.js";
import { isoTimestampSchema } from "../timestamp.js";
import { actorSchema } from "./actor.js";
import { ticketEdgeFieldsSchema } from "./edge.js";
import { specSchema } from "./spec.js";

export const TICKET_STATES = ["draft", "open", "in_progress", "review", "done", "dropped"] as const;
export type TicketState = (typeof TICKET_STATES)[number];
export const ticketStateSchema = z.enum(TICKET_STATES);

// NOTE (D5): "blocked" and "stale" are derived overlays, never stored —
// deliberately absent from this schema. B4 computes them into
// index.jsonc at reindex time (from live `blocks` edges and
// `last_activity_at` versus `config.defaults.stale_after` /
// `review_stale_after`), not from anything persisted on the ticket.

export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 3;
export const DEFAULT_PRIORITY = 2;

/** 0 = urgent .. 3 = low (design.md §8.1 item 4), default 2. */
export const prioritySchema = z.int().min(PRIORITY_MIN).max(PRIORITY_MAX).default(DEFAULT_PRIORITY);

export const labelSchema = z.string().trim().min(1).max(100);

export const PROVENANCE_METHODS = ["new", "split", "draft", "adhoc"] as const;
export type ProvenanceMethod = (typeof PROVENANCE_METHODS)[number];

/** How, and by whom, a ticket came to exist (design.md §4.1 item 1, "provenance"; D13, B2). */
export const provenanceSchema = z.object({
  method: z.enum(PROVENANCE_METHODS),
  created_by: actorSchema,
  /** Set only when method === "split": the ticket this one was split out of. */
  split_from: ticketIdSchema.optional(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

/**
 * The MR/PR link's URL shape — shared by {@link reviewSchema} (`review.mr`
 * on the persisted ticket) AND `src/cli/commands/review.ts`'s own up-front
 * `--mr` validation (Fix 3, adversarial review: `slop review --mr
 * <invalid-url>` must fail before any side effect, not after the session
 * write — see that file's module doc), so the two never drift on what
 * counts as a valid MR URL.
 *
 * Restricted to http(s): bare `z.url()` happily accepts `javascript:`,
 * `data:`, and `vbscript:` URLs, which `slop web` would otherwise render
 * as a live `href` (stored XSS — a human clicking a review's MR link runs
 * attacker-controlled script). MR links are always a web page a human
 * opens in a browser, so http(s)-only is not a real restriction on
 * legitimate use, just a closed allowlist instead of an open denylist.
 * `src/web/html.ts`'s `safeUrl` enforces the equivalent scheme allowlist
 * at render time, for content (e.g. markdown links) this schema never
 * sees.
 */
export const mrUrlSchema = z
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: "MR URL must be http(s)" });

/**
 * `{mr, requested_at, by}`, present if and only if `state === "review"`
 * (D15). `mr` is itself optional *within* that: design.md D15 / §8.1 item
 * 3 — "review --mr required-with-warning (can enter review without an MR
 * link, but it nags)" — so an honest model has both an optional outer
 * `review` and an optional inner `mr`, not one flag that means both.
 */
export const reviewSchema = z.object({
  mr: mrUrlSchema.optional(),
  requested_at: isoTimestampSchema,
  by: actorSchema,
});
export type Review = z.infer<typeof reviewSchema>;

/**
 * Reasonable ceiling for a `resolution` writeup — generous enough for a
 * genuine investigation/adhoc-ticket report (multi-paragraph, multi-line)
 * without leaving the field unbounded.
 */
export const RESOLUTION_MAX_LENGTH = 20_000;

/**
 * The durable outcome/resolution writeup (design.md-adjacent: a place for
 * an investigation's findings that today only fits in a one-line
 * `latest_note`). Set via `slop done --outcome` (see
 * cli/commands/done.ts's `buildDoneTicket`); rendered as markdown by both
 * `slop show` (tickets/detail.ts) and `slop web` (web/views/ticket-detail.ts),
 * same convention as `spec.details_md`. `.trim().min(1)` mirrors
 * `specSchema.summary`/`labelSchema`: an explicitly-passed but blank
 * `--outcome` is a usage mistake to surface, not silently ignore.
 */
export const resolutionSchema = z.string().trim().min(1).max(RESOLUTION_MAX_LENGTH);

export const ticketSchema = z
  .object({
    id: ticketIdSchema,
    name: z.string().trim().min(1).max(300),
    slug: slugSchema,
    spec: specSchema,
    state: ticketStateSchema,
    review: reviewSchema.optional(),
    priority: prioritySchema,
    labels: z.array(labelSchema).default([]),
    /** D13: adhoc creation affordance — ad hoc tickets skip the usual planning ceremony. */
    adhoc: z.boolean().default(false),

    // Edges embedded on the ticket — see edge.ts / DECISIONS.md for why
    // there is no separate edges/ store.
    ...ticketEdgeFieldsSchema.shape,

    // Materialised ancestry (D6). `root_id` is this ticket's own id when
    // it has no local parent — either a true root, or its parent is an
    // external ref (D1: "external parents terminate the local tree", so
    // such a ticket is the root of its *local* tree). `path` is the
    // ordered list of local ancestor ids from the root down to (but not
    // including) this ticket; empty for a root.
    root_id: ticketIdSchema,
    path: z.array(ticketIdSchema).default([]),

    active_session: sessionIdSchema.nullable().default(null),
    last_activity_at: isoTimestampSchema,
    latest_note: z.string().nullable().default(null),
    /** Optional — OMITTED entirely when absent (never `null`/""), so a
     * ticket that never got a `--outcome` parses byte-identically to
     * before this field existed. See `resolutionSchema`'s doc comment. */
    resolution: resolutionSchema.optional(),
    owner: actorSchema.nullable().default(null),
    provenance: provenanceSchema,
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .refine((t) => (t.state === "review" ? t.review !== undefined : t.review === undefined), {
    message: '`review` must be set if and only if state === "review" (D15)',
    path: ["review"],
  });

export type Ticket = z.infer<typeof ticketSchema>;
