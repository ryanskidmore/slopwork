/**
 * The `slop web` JSON API's response contract (rewrite-slop-web-as-a).
 *
 * Hand-written, not `z.infer`-derived from the core entity schemas: the
 * wire contract is a deliberate, curated PROJECTION of the domain model
 * (derived overlays folded in, markdown pre-rendered to sanitized HTML,
 * URLs pre-validated to a `safe_url`, dangling ref ids resolved-or-not) —
 * not "whatever core happens to expose". Keeping it hand-written also lets
 * this exact file be imported, type-only, from BOTH tsconfigs in this
 * project (root `tsconfig.json` for the Bun server, `src/web/frontend/
 * tsconfig.json` for the browser SPA) with zero risk of a lib/global
 * mismatch between them — every field here is a plain string/number/
 * boolean/array/record, nothing Bun- or DOM-flavored.
 *
 * `src/web/api/*.ts` (server) builds these; `src/web/frontend/lib/api.ts`
 * (client) fetches and types against them. One file, one contract, both
 * sides import-type it — see that module's doc for the fetch layer.
 */

export type TicketState = "draft" | "open" | "in_progress" | "review" | "done" | "dropped";
export type ActorKind = "human" | "agent";
export type HarnessKind = "claude-code" | "opencode" | "codex" | "other";
export type EventVerb =
  | "ticket.created"
  | "ticket.updated"
  | "ticket.state_changed"
  | "ticket.ready"
  | "ticket.done"
  | "ticket.dropped"
  | "ticket.split"
  | "session.started"
  | "session.stopped"
  | "session.ended"
  | "session.takeover"
  | "plan.set"
  | "plan.revised"
  | "plan.step_checked"
  | "review.requested"
  | "question.asked"
  | "question.answered";

export interface ActorDTO {
  name: string;
  kind: ActorKind;
}

/** A resolved pointer to another ticket — every relationship/ancestry list
 * in this API is built from these, never a bare id, so the client never
 * has to look up a name/slug/state separately just to render a link. */
export interface TicketRefDTO {
  id: string;
  name: string;
  slug: string;
  state: TicketState;
  handle: string;
}

/** A ticket id that doesn't resolve in this db (a dangling edge, or a
 * ticket a fault-tolerant listing skipped) — rendered as inert text, never
 * a link. See src/web/views/ticket-detail.ts's original `byId.get`
 * fallback, carried forward here as an explicit union member instead of
 * `null`. */
export interface DanglingRefDTO {
  id: string;
}

export type RefOrDanglingDTO =
  | { kind: "ref"; ref: TicketRefDTO }
  | { kind: "dangling"; ref: DanglingRefDTO };

export interface ExternalParentDTO {
  ref: string;
  system: string;
  key: string;
  /** Built from `remotes.jira`, scheme-checked server-side (safeUrl) — `null` when no remote is configured or the configured URL's scheme is unsafe. */
  safe_url: string | null;
}

export type ParentDTO =
  | { kind: "none" }
  | { kind: "local"; ref: RefOrDanglingDTO }
  | { kind: "external"; parent: ExternalParentDTO };

/** blocked/stale/awaiting_input — derived, never stored (design.md D5).
 * Present on every ticket-shaped DTO so list/tree/detail/panels all read
 * the identical overlay facts. */
export interface OverlayDTO {
  blocked: boolean;
  blocked_by: TicketRefDTO[];
  stale: boolean;
  stale_reason: StaleReasonDTO | null;
  /** G4 (t-jggg9): `true` iff this ticket has >=1 unanswered question. */
  awaiting_input: boolean;
  awaiting_input_reason: AwaitingInputReasonDTO | null;
}

export interface StaleReasonDTO {
  state: "in_progress" | "review";
  since: string;
  idle_ms: number;
  threshold: string;
}

/** G4: the `awaiting_input` overlay's "why" — `null` iff `overlay.awaiting_input` is `false`. */
export interface AwaitingInputReasonDTO {
  open_question_count: number;
  oldest_question_at: string;
  oldest_question_age_ms: number;
}

export interface MrLinkDTO {
  url: string;
  safe_url: string | null;
}

export interface ReviewDTO {
  mr: MrLinkDTO | null;
  requested_at: string;
  by: ActorDTO;
  awaiting_ms: number;
}

export interface ProvenanceDTO {
  method: "new" | "split" | "draft" | "adhoc";
  created_by: ActorDTO;
  split_from: RefOrDanglingDTO | null;
}

/** The common row shape for /tickets, /tree, /review, /stale — everything
 * a list/tree/panel needs without a second round trip. */
export interface TicketSummaryDTO {
  id: string;
  handle: string;
  name: string;
  slug: string;
  state: TicketState;
  priority: number;
  labels: string[];
  owner: ActorDTO | null;
  adhoc: boolean;
  last_activity_at: string;
  latest_note: string | null;
  created_at: string;
  updated_at: string;
  parent: ParentDTO;
  overlay: OverlayDTO;
  review: ReviewDTO | null;
}

export interface SpecDTO {
  summary: string;
  details_md: string;
  /** Pre-rendered via src/web/markdown.ts (renderMarkdownToString ->
   * sanitizeMarkdownHtml) — the client renders this with
   * dangerouslySetInnerHTML, exactly as safe as the old server-rendered
   * page, never re-parsed client-side. */
  details_html: string;
  acceptance: string[];
  context: string[];
  meta: Record<string, unknown>;
}

export interface PlanStepDTO {
  text: string;
  checked: boolean;
}

export interface PlanVersionDTO {
  version: number;
  steps: PlanStepDTO[];
  created_at: string;
  is_latest: boolean;
}

export interface SessionDTO {
  id: string;
  actor: ActorDTO;
  harness: HarnessKind;
  harness_session_id: string | null;
  git_branch: string | null;
  git_commit_at_start: string | null;
  started_at: string;
  ended_at: string | null;
  plan: PlanVersionDTO[];
  end_summary: string | null;
  is_active: boolean;
}

export interface EventDTO {
  id: string;
  at: string;
  actor: ActorDTO;
  verb: EventVerb;
  label: string;
  session: string | null;
  entity_kind: "ticket" | "session";
  progress_note: string | null;
  payload: Record<string, unknown>;
}

export interface RelationshipsDTO {
  blocks: RefOrDanglingDTO[];
  blocked_by: RefOrDanglingDTO[];
  relates_to: RefOrDanglingDTO[];
  discovered_from: RefOrDanglingDTO[];
  discovered_here: RefOrDanglingDTO[];
}

export interface TicketDetailDTO {
  ticket: TicketSummaryDTO;
  ancestry: RefOrDanglingDTO[];
  children: TicketRefDTO[];
  relationships: RelationshipsDTO;
  spec: SpecDTO;
  /** Pre-rendered markdown, same guarantee as `spec.details_html`. `null` when `resolution` was never set. */
  resolution_html: string | null;
  events: EventDTO[];
  sessions: SessionDTO[];
  provenance: ProvenanceDTO;
  integrity: IntegrityDTO;
}

export interface EventReadProblemDTO {
  kind: "invalid_filename" | "read_error" | "id_mismatch" | "wrong_shard" | "duplicate_id";
  id: string | null;
  path: string;
  message: string;
}

export interface IntegrityDTO {
  event_problems: EventReadProblemDTO[];
}

export interface ConfigDTO {
  project: string;
  warning: string | null;
  remotes: { repo: string | null; jira: string | null };
  defaults: { stale_after: string; review_stale_after: string };
  integrity: IntegrityDTO;
}

/** Stable, 1-based page metadata for `GET /api/tickets`. `total` on the
 * response remains the whole-repository count for compatibility;
 * `filtered_total` is the number of rows matching the active filters. */
export interface TicketListPaginationDTO {
  page: number;
  limit: number;
  filtered_total: number;
  total_pages: number;
  previous_page: number | null;
  next_page: number | null;
}

export interface TicketListResponseDTO {
  config: ConfigDTO;
  tickets: TicketSummaryDTO[];
  /** Whole-repository ticket count, preserving the pre-pagination contract. */
  total: number;
  pagination: TicketListPaginationDTO;
  facets: { labels: string[]; owners: string[]; states: TicketState[] };
}

export interface TreeNodeDTO {
  ticket: TicketSummaryDTO;
  children: TreeNodeDTO[];
  external_parent: ExternalParentDTO | null;
}

export interface TreeResponseDTO {
  config: ConfigDTO;
  roots: TreeNodeDTO[];
  total: number;
}

export interface ReviewResponseDTO {
  config: ConfigDTO;
  tickets: TicketSummaryDTO[];
}

export interface StaleRowDTO {
  ticket: TicketSummaryDTO;
  since: string;
}

export interface StaleResponseDTO {
  config: ConfigDTO;
  rows: StaleRowDTO[];
}

/** G4 (t-jggg9): one `question.asked` event, folded with its answer (if
 * any) — mirrors `EventDTO`'s shape for the same event verbs, but this is
 * the QUESTIONS-panel's own richer shape (options, the paired answer),
 * not the generic audit-spine row. */
export interface QuestionDTO {
  id: string;
  text: string;
  options: string[];
  asked_by: ActorDTO;
  asked_at: string;
  answer: { id: string; text: string; by: ActorDTO; answered_at: string } | null;
}

export interface QuestionGroupDTO {
  ticket: TicketRefDTO;
  questions: QuestionDTO[];
}

/** `GET /api/questions` — unanswered questions across the project, oldest
 * first, grouped by ticket (mirrors `/api/review`'s shape). */
export interface QuestionsResponseDTO {
  config: ConfigDTO;
  groups: QuestionGroupDTO[];
  total_questions: number;
}

export interface ApiErrorDTO {
  error: string;
}
