/**
 * Shared DTO builders for the `slop web` JSON API (rewrite-slop-web-as-a).
 * Every `src/web/api/*.ts` route handler composes these instead of
 * re-deriving "what does a ticket/overlay/relationship look like on the
 * wire" independently — the same one-source-of-truth discipline
 * `src/web/overlays.ts` and the old `src/web/views/shared.ts` already
 * followed.
 */
import {
  type Config,
  type Event,
  type EventVerb,
  isTicketId,
  parseParentRef,
  shortTicketCode,
  type Ticket,
  type TicketId,
} from "../../core/index.js";
import type {
  ConfigDTO,
  EventDTO,
  ExternalParentDTO,
  MrLinkDTO,
  OverlayDTO,
  ParentDTO,
  ProvenanceDTO,
  RefOrDanglingDTO,
  ReviewDTO,
  StaleReasonDTO,
  TicketRefDTO,
  TicketSummaryDTO,
} from "./types.js";
import {
  computeStaleReason,
  isTicketStale,
  liveBlockers,
  msSince,
  type StaleReason,
  type StaleThresholds,
} from "../overlays.js";
import { safeUrl } from "../url-safety.js";

const VERB_LABELS: Record<EventVerb, string> = {
  "ticket.created": "created",
  "ticket.updated": "updated",
  "ticket.state_changed": "state changed",
  "ticket.ready": "became ready (blockers cleared)",
  "ticket.done": "marked done",
  "ticket.dropped": "dropped",
  "ticket.split": "split into sub-tickets",
  "session.started": "session started",
  "session.stopped": "session stopped",
  "session.ended": "session ended",
  "session.takeover": "session taken over",
  "plan.set": "plan set",
  "plan.revised": "plan revised",
  "plan.step_checked": "plan step checked",
  "review.requested": "requested review",
};

export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export function apiErrorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export function configDto(config: Config, warning: string | null): ConfigDTO {
  return {
    project: config.project,
    warning,
    remotes: {
      repo: config.remotes.repo ?? null,
      jira: config.remotes.jira ? config.remotes.jira || null : null,
    },
    defaults: {
      stale_after: config.defaults.stale_after,
      review_stale_after: config.defaults.review_stale_after,
    },
  };
}

export function ticketRefDto(ticket: Ticket): TicketRefDTO {
  return {
    id: ticket.id,
    name: ticket.name,
    slug: ticket.slug,
    state: ticket.state,
    handle: shortTicketCode(ticket.id),
  };
}

export function refOrDangling(id: TicketId, byId: ReadonlyMap<TicketId, Ticket>): RefOrDanglingDTO {
  const ticket = byId.get(id);
  return ticket ? { kind: "ref", ref: ticketRefDto(ticket) } : { kind: "dangling", ref: { id } };
}

export function refList(
  ids: readonly TicketId[],
  byId: ReadonlyMap<TicketId, Ticket>,
): RefOrDanglingDTO[] {
  return ids.map((id) => refOrDangling(id, byId));
}

/**
 * `remotes.jira` is schema-validated with `z.url()`, which accepts any URL
 * scheme — including `javascript:`/`data:`/`vbscript:` — and config.yaml is
 * collaborator-editable/git-merged, so it's attacker-reachable the same way
 * an MR link is. Routed through `safeUrl`, same backstop the old
 * `externalParentBadge` (views/shared.ts) applied; an unsafe scheme yields
 * `safe_url: null` so the client renders inert text instead of a live link.
 */
export function externalParentDto(ref: string, config: Config): ExternalParentDTO {
  let system = "";
  let key = ref;
  try {
    const parsed = parseParentRef(ref);
    if (parsed.kind === "external") {
      system = parsed.system;
      key = parsed.key;
    }
  } catch {
    // Malformed ref smuggled past schema validation somehow — fall back to showing it verbatim.
  }
  const safeBase = system === "jira" && config.remotes.jira ? safeUrl(config.remotes.jira) : null;
  const safe_url = safeBase
    ? `${safeBase.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`
    : null;
  return { ref, system, key, safe_url };
}

export function parentDto(
  ticket: Ticket,
  byId: ReadonlyMap<TicketId, Ticket>,
  config: Config,
): ParentDTO {
  if (ticket.parent === undefined) return { kind: "none" };
  if (isTicketId(ticket.parent)) {
    return { kind: "local", ref: refOrDangling(ticket.parent, byId) };
  }
  return { kind: "external", parent: externalParentDto(ticket.parent, config) };
}

export function mrLinkDto(mr: string | undefined): MrLinkDTO | null {
  if (!mr) return null;
  return { url: mr, safe_url: safeUrl(mr) };
}

function staleReasonDto(
  reason: StaleReason | null,
  thresholds: { stale_after: string; review_stale_after: string },
  now: number,
): StaleReasonDTO | null {
  if (!reason) return null;
  return {
    state: reason.state,
    since: reason.since,
    idle_ms: msSince(reason.since, now),
    threshold: reason.state === "review" ? thresholds.review_stale_after : thresholds.stale_after,
  };
}

/**
 * `blocked_by` is built as full {@link TicketRefDTO}s directly (every live
 * blocker, by construction, exists in `allTickets`) rather than through
 * {@link refOrDangling} — there's nothing dangling to guard against here.
 */
export function overlayDto(
  ticket: Ticket,
  allTickets: readonly Ticket[],
  thresholds: StaleThresholds,
  configDefaults: { stale_after: string; review_stale_after: string },
  now: number,
): OverlayDTO {
  const blockers = liveBlockers(ticket.id, allTickets);
  const staleReason = computeStaleReason(ticket, thresholds, now);
  return {
    blocked: blockers.length > 0,
    blocked_by: blockers.map(ticketRefDto).sort((a, b) => a.name.localeCompare(b.name)),
    stale: isTicketStale(ticket, thresholds, now),
    stale_reason: staleReasonDto(staleReason, configDefaults, now),
  };
}

export function reviewDto(ticket: Ticket, now: number): ReviewDTO | null {
  if (ticket.state !== "review" || !ticket.review) return null;
  return {
    mr: mrLinkDto(ticket.review.mr),
    requested_at: ticket.review.requested_at,
    by: ticket.review.by,
    awaiting_ms: msSince(ticket.review.requested_at, now),
  };
}

export function provenanceDto(ticket: Ticket, byId: ReadonlyMap<TicketId, Ticket>): ProvenanceDTO {
  return {
    method: ticket.provenance.method,
    created_by: ticket.provenance.created_by,
    split_from: ticket.provenance.split_from
      ? refOrDangling(ticket.provenance.split_from, byId)
      : null,
  };
}

export function ticketSummaryDto(
  ticket: Ticket,
  allTickets: readonly Ticket[],
  byId: ReadonlyMap<TicketId, Ticket>,
  thresholds: StaleThresholds,
  config: Config,
  now: number,
): TicketSummaryDTO {
  return {
    id: ticket.id,
    handle: shortTicketCode(ticket.id),
    name: ticket.name,
    slug: ticket.slug,
    state: ticket.state,
    priority: ticket.priority,
    labels: ticket.labels,
    owner: ticket.owner,
    adhoc: ticket.adhoc,
    last_activity_at: ticket.last_activity_at,
    latest_note: ticket.latest_note,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    parent: parentDto(ticket, byId, config),
    overlay: overlayDto(ticket, allTickets, thresholds, config.defaults, now),
    review: reviewDto(ticket, now),
  };
}

export function eventLabel(event: Event): string {
  return VERB_LABELS[event.verb] ?? event.verb;
}

export function eventDto(event: Event): EventDTO {
  const progress = typeof event.payload.progress === "string" ? event.payload.progress : null;
  return {
    id: event.id,
    at: event.at,
    actor: event.actor,
    verb: event.verb,
    label: eventLabel(event),
    session: event.session,
    entity_kind: event.entity.kind,
    progress_note: progress,
    payload: event.payload,
  };
}
