/**
 * Event (design.md §4.1 item 4): immutable, one per event, `id`, `actor`,
 * `session`, `verb`, `entity`, `payload`.
 *
 * The verb vocabulary is a closed union, grouped below by which command
 * -surface area emits it, with the reasoning next to each group so later
 * work items (A4 emits, B4/C3/C5/D3 consume) don't have to reverse
 * -engineer why a given verb exists or isn't further split.
 */
import { z } from "zod";
import { eventIdSchema, sessionIdSchema } from "../ids.js";
import { isoTimestampSchema } from "../timestamp.js";
import { actorSchema } from "./actor.js";

export const EVENT_VERBS = [
  // --- Ticket lifecycle -------------------------------------------------
  // `new` (B1).
  "ticket.created",
  // `edit`, `update` (name/spec/priority/labels/owner/progress notes) —
  // anything that changes a ticket's fields without moving its `state`.
  "ticket.updated",
  // Any `state` transition that ISN'T specifically "entered review" or
  // terminal (done/dropped) — draft<->open (`draft`/`undraft`),
  // open->in_progress (`start`), in_progress->open (`stop`),
  // review->in_progress (re-`start` after changes requested, D15;
  // payload carries `re_entry: true`).
  "ticket.state_changed",
  // Fired when a ticket's live blockers clear (B4 done-cascade: "decrement
  // + emit ticket.ready"). Distinct from state_changed because the
  // ticket's own `state` doesn't change — only its derived `blocked`
  // overlay (D5) does.
  "ticket.ready",
  // `done` — terminal, and notable enough on its own (cascade triggers,
  // search/filtering "was this ever completed") to warrant its own verb
  // rather than folding into state_changed.
  "ticket.done",
  // `drop` — terminal, same rationale as ticket.done.
  "ticket.dropped",
  // `split <ref> "sub1" "sub2"` (B2) — one event on the parent; each
  // child gets its own separate ticket.created.
  "ticket.split",

  // --- Session lifecycle (D9) --------------------------------------------
  // `start` (including takeover and review->in_progress re-entry).
  "session.started",
  // `stop` — hands a still-open ticket back off; resumable.
  "session.stopped",
  // `done` or `drop` — session finalized because the ticket left the
  // active loop. Three distinct endings, not one, because "why did this
  // session end" is exactly what an audit trail (§4.7 item 3/4) needs.
  "session.ended",
  // §5.4 / D9: "explicit logged takeovers" of an already-active ticket.
  "session.takeover",

  // --- Plans (C2) ---------------------------------------------------------
  // First `plan` call for a session.
  "plan.set",
  // Subsequent `plan` calls — a new version appended (see session.ts).
  "plan.revised",
  // `plan --check N` / `--uncheck N` — one verb for both; payload carries
  // `checked: boolean` rather than splitting into two verbs.
  "plan.step_checked",

  // --- Review (D15) --------------------------------------------------------
  // `review --mr <url>` (in_progress -> review).
  "review.requested",

  // --- Elicitations (G4, t-jggg9) -------------------------------------------
  // `slop ask <ticket-ref> "<question>" [--option <text>]...` — ticket
  // -scoped (`entity: {kind: "ticket", id}`), payload carries `text` and
  // `options` (string[], [] when none given). Identified by THIS event's
  // own id — `slop answer <question-id>` and the `awaiting_input` overlay
  // (a ticket has it iff it has >=1 question.asked with no later
  // question.answered referencing it — src/tickets/overlay.ts) both key
  // off it. Deliberately an event, not a new stored entity: this keeps the
  // merge-clean, immutable one-file-per-event property (concepts.md) and
  // puts questions on the same audit spine as everything else, instead of
  // inventing a `.slop/db/questions/` directory with its own CRUD.
  "question.asked",
  // `slop answer <question-id> "<answer>"` — same ticket as the question
  // it answers (payload.question_id names the question.asked event id);
  // answering an already-answered question is a CONFLICT (exit 6), never
  // a second question.answered event for the same question_id.
  "question.answered",
] as const;
export const eventVerbSchema = z.enum(EVENT_VERBS);
export type EventVerb = (typeof EVENT_VERBS)[number];

export const EVENT_ENTITY_KINDS = ["ticket", "session"] as const;
export type EventEntityKind = (typeof EVENT_ENTITY_KINDS)[number];

/**
 * What the event is about. `id` is deliberately typed as a plain string
 * rather than a specific `TicketId`/`SessionId` union — which concrete id
 * shape is valid depends on `kind`, and a discriminated union here would
 * buy little for a field that's purely descriptive (never traversed) at
 * the A2 layer.
 */
export const eventEntitySchema = z.object({
  kind: z.enum(EVENT_ENTITY_KINDS),
  id: z.string().min(1),
});
export type EventEntity = z.infer<typeof eventEntitySchema>;

export const eventSchema = z.object({
  id: eventIdSchema,
  actor: actorSchema,
  /** Null for events not tied to a session (e.g. `new` run outside any `start`ed session). */
  session: sessionIdSchema.nullable(),
  verb: eventVerbSchema,
  entity: eventEntitySchema,
  /** Verb-specific data. Open-ended by design — see EVENT_VERBS for what each verb's payload is expected to carry. */
  payload: z.record(z.string(), z.unknown()).default({}),
  at: isoTimestampSchema,
});
export type Event = z.infer<typeof eventSchema>;
