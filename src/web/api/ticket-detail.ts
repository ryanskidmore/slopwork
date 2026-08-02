/**
 * `GET /api/tickets/:ref` — everything about one ticket (feature parity
 * with the old `src/web/views/ticket-detail.ts`): spec, both-direction
 * relationships, overlays with reasons, the updates timeline, and every
 * session with its plan versions. See src/web/api/types.ts's
 * `TicketDetailDTO` for the wire shape and this ticket's audit-spine design
 * direction — the client (not this file) decides display order/emphasis;
 * this handler's only ordering opinion is `events`/`sessions` staying
 * oldest-first (the same order `WebDataSource` hands them back in), which
 * matches a provenance timeline's natural reading order.
 */
import type { BunRequest } from "bun";
import type { Session } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import { renderMarkdownToString } from "../markdown.js";
import {
  computeAwaitingInputByTicket,
  deriveEffectiveTickets,
  liveBlockersFromReverseIndex,
  matchTicketByRef,
  staleThresholdsFromConfig,
} from "../overlays.js";
import {
  apiErrorResponse,
  createTicketSummaryContext,
  eventDto,
  jsonResponse,
  provenanceDto,
  refList,
  refOrDangling,
  ticketRefDto,
  ticketSummaryDto,
} from "./shared.js";
import type { RelationshipsDTO, SessionDTO, TicketDetailDTO } from "./types.js";

function sessionDto(session: Session, activeSessionId: string | null): SessionDTO {
  const latestVersion =
    session.plan.length > 0 ? Math.max(...session.plan.map((p) => p.version)) : 0;
  return {
    id: session.id,
    actor: session.actor,
    harness: session.harness.kind,
    harness_session_id: session.harness.session_id,
    git_branch: session.git.branch,
    git_commit_at_start: session.git.commit_at_start,
    started_at: session.started_at,
    ended_at: session.ended_at,
    plan: session.plan.map((version) => ({
      version: version.version,
      steps: version.steps,
      created_at: version.created_at,
      is_latest: version.version === latestVersion,
    })),
    end_summary: session.end_summary,
    is_active: session.id === activeSessionId,
  };
}

export async function handleTicketDetail(
  req: BunRequest<"/api/tickets/:ref">,
  dataSource: WebDataSource,
  now: number,
): Promise<Response> {
  const ref = req.params.ref;
  // Unlike every other route, ticket detail doesn't embed its own `config`
  // — the SPA's AppShell fetches `/api/config` once, globally, and renders
  // the fault-tolerance warning banner there (src/web/frontend/components/
  // app-shell.tsx), so every page shares one config fetch instead of one
  // per route.
  const [allTickets, { config }] = await Promise.all([
    dataSource.listTickets(),
    dataSource.getConfig(),
  ]);
  const ticket = matchTicketByRef(allTickets, ref);
  if (!ticket) {
    return apiErrorResponse(`No ticket matches "${ref}".`, 404);
  }

  const sessions = await dataSource.listSessionsForTicket(ticket.id);
  const eventResult = await dataSource.listEventsForTicket(ticket.id, sessions);
  const events = eventResult.events;

  const effectiveTicket = deriveEffectiveTickets([ticket], events)[0] ?? ticket;
  const thresholds = staleThresholdsFromConfig(config);
  // G4 (t-jggg9): `events` is already scoped to this one ticket (plus its
  // sessions' events, which computeAwaitingInputByTicket's own
  // entity.kind==="ticket" filter ignores) — one ticket's worth of
  // question-verb events is exactly what the awaiting_input overlay
  // needs, no separate whole-db read.
  const awaitingInputByTicket = computeAwaitingInputByTicket(events);
  const summaryContext = createTicketSummaryContext(
    allTickets,
    thresholds,
    config,
    now,
    awaitingInputByTicket,
  );
  const { byId, reverseEdges } = summaryContext;
  const children = allTickets.filter((t) => t.parent === ticket.id);

  const relatesToIds = [
    ...new Set([...ticket.relates_to, ...(reverseEdges.relatedFrom.get(ticket.id) ?? [])]),
  ];
  const relationships: RelationshipsDTO = {
    blocks: refList(ticket.blocks, byId),
    blocked_by: liveBlockersFromReverseIndex(ticket.id, byId, reverseEdges).map((t) => ({
      kind: "ref" as const,
      ref: ticketRefDto(t),
    })),
    relates_to: refList(relatesToIds, byId),
    discovered_from: refList(ticket.discovered_from, byId),
    discovered_here: refList(reverseEdges.discovered.get(ticket.id) ?? [], byId),
  };

  const detailsHtml = ticket.spec.details_md ? renderMarkdownToString(ticket.spec.details_md) : "";
  const resolutionHtml = ticket.resolution ? renderMarkdownToString(ticket.resolution) : null;

  const body: TicketDetailDTO = {
    ticket: ticketSummaryDto(effectiveTicket, summaryContext),
    ancestry: ticket.path.map((id) => refOrDangling(id, byId)),
    children: children.map(ticketRefDto).sort((a, b) => a.name.localeCompare(b.name)),
    relationships,
    spec: {
      summary: ticket.spec.summary,
      details_md: ticket.spec.details_md,
      details_html: detailsHtml,
      acceptance: ticket.spec.acceptance,
      context: ticket.spec.context,
      meta: ticket.spec.meta,
    },
    resolution_html: resolutionHtml,
    events: events.map(eventDto),
    sessions: sessions.map((s) => sessionDto(s, ticket.active_session)),
    provenance: provenanceDto(ticket, byId),
    integrity: { event_problems: eventResult.problems },
  };

  return jsonResponse(body);
}
