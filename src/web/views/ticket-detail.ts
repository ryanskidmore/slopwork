/**
 * §4.4 item 3: "Ticket detail — spec (summary, `details_md` rendered as
 * markdown, `acceptance[]`, `context[]`, `meta`), the updates timeline
 * (events for this ticket, newest-first or oldest-first, your call —
 * justify it), sessions with plan progress (per-session: actor, harness
 * kind, git branch/commit, start/end, plan version(s) with checked steps,
 * end summary), and links to transcripts."
 *
 * Timeline order: **newest-first.** A human opening a ticket mid-project
 * wants "what just happened" before "how did this start" — the same
 * convention as a GitHub issue's activity feed, a chat thread, or `git
 * log` without `--reverse`. Sessions, by contrast, are rendered
 * oldest-first: a session history reads as a narrative ("first agent X
 * worked it, stopped, then agent Y picked it up"), which only makes sense
 * chronologically forward.
 */
import type { BunRequest } from "bun";
import type { Event, EventVerb, Session, Ticket, TicketId } from "../../core/index.js";
import { isTicketId, shortTicketCode } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import { html, joinHtml, type RawHtml, raw, safeUrl } from "../html.js";
import { renderMarkdownToString } from "../markdown.js";
import {
  buildReverseEdgeIndex,
  computeStaleReason,
  deriveEffectiveTickets,
  formatDurationShort,
  formatRelative,
  liveBlockers,
  msSince,
  type ReverseEdgeIndex,
  type StaleReason,
  staleThresholdsFromConfig,
} from "../overlays.js";
import {
  blockedBadge,
  externalParentBadge,
  labelChips,
  notFoundPage,
  pageResponse,
  priorityBadge,
  staleBadge,
  stateBadge,
  ticketLink,
} from "./shared.js";

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

function eventLabel(event: Event): string {
  return VERB_LABELS[event.verb] ?? event.verb;
}

/**
 * The review MR link, scheme-guarded. `mrUrlSchema` (core/entities/ticket.ts)
 * already rejects non-http(s) MR URLs at write time, but this is the
 * render-time backstop for anything already in the db from before that
 * guard existed — mirrors `externalParentBadge`'s (shared.ts) fallback to
 * inert text rather than ever emitting a `javascript:`/`data:` `href`.
 * Exported (only) so `ticket-detail.test.ts` can exercise it directly.
 */
export function renderMrLink(mr: string | undefined): RawHtml {
  if (!mr) return html`<span class="muted">No MR link yet</span>`;
  const safe = safeUrl(mr);
  return safe
    ? html`<a href="${safe}" target="_blank" rel="noopener noreferrer">${mr}</a>`
    : html`<span class="muted" title="Unsafe URL scheme — shown as text, not a link">${mr}</span>`;
}

/**
 * The `resolution` (outcome writeup, set via `slop done --outcome`)
 * section — present iff `ticket.resolution` is set, rendered through the
 * exact same markdown path as `spec.details_md` (`renderMarkdownToString`
 * -> `sanitizeMarkdownHtml`, markdown.ts): `resolution` is free-form prose
 * that could itself carry a `javascript:`/`data:` link, so it gets the
 * identical guard — never a raw interpolation. Exported (only) so
 * `ticket-detail.test.ts` can exercise it directly, same convention as
 * {@link renderMrLink}.
 */
export function renderResolutionSection(ticket: Ticket): RawHtml {
  if (!ticket.resolution) return html``;
  return html`<section class="section">
  <h2>Resolution</h2>
  <div class="details-md">${raw(renderMarkdownToString(ticket.resolution))}</div>
</section>`;
}

function renderPayload(payload: Record<string, unknown>): RawHtml {
  const keys = Object.keys(payload);
  if (keys.length === 0) return html``;
  return html`<details><summary>payload</summary><pre><code>${JSON.stringify(payload, null, 2)}</code></pre></details>`;
}

/**
 * ticket_01KY9S0172V8AYCYV9KWS6RC9P: surface a lock-free `update
 * --progress` note directly (not just buried in the collapsed raw-payload
 * `<details>` below) — these are plain `ticket.updated` events whose
 * `payload.progress` carries the note (`src/cli/commands/update.ts`'s
 * `pureProgressNote` path; `src/repo/db-index.ts`'s module doc, "EFFECTIVE,
 * not stored-verbatim"), structurally indistinguishable from any other
 * `ticket.updated` event except for carrying this string field — so this
 * checks the field, not the verb. Auto-escaped like every other
 * interpolation in this file (`html` tagged template) — never raw.
 */
export function renderTimelineEntry(event: Event): RawHtml {
  const progress = typeof event.payload.progress === "string" ? event.payload.progress : null;
  return html`<li>
  <span class="ts" title="${event.at}">${event.at}</span>
  <strong>${event.actor.name}</strong> (${event.actor.kind}) — ${eventLabel(event)}
  ${progress ? html`<p class="muted">progress note: “${progress}”</p>` : ""}
  ${renderPayload(event.payload)}
</li>`;
}

function renderTimeline(events: readonly Event[]): RawHtml {
  if (events.length === 0) return html`<p class="muted">No events yet.</p>`;
  // Oldest-first internally (event-id/ULID order, per WebDataSource's contract); reversed here for newest-first display — see this file's header comment for why.
  const newestFirst = [...events].reverse();
  return html`<ul class="timeline">${joinHtml(newestFirst.map(renderTimelineEntry))}</ul>`;
}

/**
 * ALL relationships, in BOTH directions, as clickable links
 * (ticket_01KY9S0172V8AYCYV9KWS6RC9P) — `parent`/`children` stay in the
 * top meta grid (unchanged from before this ticket), this section covers
 * the four edge kinds that only D5 ever partially surfaced: `blocks`
 * (outgoing), `blocked-by` (the derived reverse of every OTHER ticket's
 * `blocks`), `relates-to` (symmetric — edges.ts's own doc calls a
 * `relates-to` "cycle" a tautology, so the outgoing and reverse-derived
 * sets are merged into one list rather than shown as two directions of the
 * same fact), and `discovered-from` (outgoing) / "discovered here" (the
 * derived reverse). A target id missing from `byId` (a dangling edge, or a
 * ticket a fault-tolerant listing skipped — see FixtureDataSource's module
 * doc) degrades to inert muted text instead of a broken link/crash.
 */
export function renderTicketRefList(
  ids: readonly TicketId[],
  byId: ReadonlyMap<TicketId, Ticket>,
): RawHtml {
  if (ids.length === 0) return html`<span class="muted">none</span>`;
  return joinHtml(
    ids.map((id, i) => {
      const t = byId.get(id);
      return html`${i > 0 ? ", " : ""}${
        t
          ? html`${stateBadge(t.state)} ${ticketLink(t)}`
          : html`<span class="muted mono" title="not present in this db">${id}</span>`
      }`;
    }),
  );
}

export function renderRelationshipsSection(
  ticket: Ticket,
  byId: ReadonlyMap<TicketId, Ticket>,
  reverseEdges: ReverseEdgeIndex,
): RawHtml {
  const relatesToIds = [
    ...new Set([...ticket.relates_to, ...(reverseEdges.relatedFrom.get(ticket.id) ?? [])]),
  ];
  return html`<section class="section">
  <h2>Relationships</h2>
  <dl class="meta-grid">
    <dt>Blocks →</dt><dd>${renderTicketRefList(ticket.blocks, byId)}</dd>
    <dt>← Blocked by</dt><dd>${renderTicketRefList(reverseEdges.blockedBy.get(ticket.id) ?? [], byId)}</dd>
    <dt>Relates to</dt><dd>${renderTicketRefList(relatesToIds, byId)}</dd>
    <dt>Discovered from →</dt><dd>${renderTicketRefList(ticket.discovered_from, byId)}</dd>
    <dt>← Discovered here</dt><dd>${renderTicketRefList(reverseEdges.discovered.get(ticket.id) ?? [], byId)}</dd>
  </dl>
</section>`;
}

/**
 * The live `blocked`/`stale` overlays WITH REASONS (this ticket's brief) —
 * distinct from {@link renderRelationshipsSection}'s edges: an edge is a
 * structural fact (persists regardless of state), an overlay reason is
 * "why is THIS badge lit up right now" (only non-done/dropped blockers;
 * only whichever staleness clock actually applies to the current state).
 * Rendered as its own line under the title so it's visible without
 * scrolling, same placement as the badges themselves.
 */
export function renderOverlayReasons(
  blockers: readonly Ticket[],
  byId: ReadonlyMap<TicketId, Ticket>,
  staleReason: StaleReason | null,
  config: { defaults: { stale_after: string; review_stale_after: string } },
  now: number,
): RawHtml {
  const blockedLine =
    blockers.length > 0
      ? html`<p class="reason">${blockedBadge()} blocked by ${renderTicketRefList(
          blockers.map((b) => b.id),
          byId,
        )}</p>`
      : "";
  const staleLine = staleReason
    ? html`<p class="reason">${staleBadge()} ${
        staleReason.state === "review"
          ? html`awaiting review since ${staleReason.since} (idle ${formatDurationShort(msSince(staleReason.since, now))}, threshold ${config.defaults.review_stale_after})`
          : html`no activity since ${staleReason.since} (idle ${formatDurationShort(msSince(staleReason.since, now))}, threshold ${config.defaults.stale_after})`
      }</p>`
    : "";
  return html`${blockedLine}${staleLine}`;
}

/** Root-to-parent breadcrumb from `ticket.path` (D6: "ordered list of
 * local ancestor ids from the root down to, but not including, this
 * ticket; empty for a root") ending in the ticket's own (unlinked) name. */
export function ancestryBreadcrumb(ticket: Ticket, byId: ReadonlyMap<TicketId, Ticket>): RawHtml {
  if (ticket.path.length === 0) return html`<span class="muted">(root)</span>`;
  const crumbs = ticket.path.map((id) => {
    const t = byId.get(id);
    return t ? ticketLink(t) : html`<span class="muted mono">${id}</span>`;
  });
  return joinHtml([
    ...crumbs.map((crumb, i) => (i === 0 ? crumb : html` › ${crumb}`)),
    html` › ${ticket.name}`,
  ]);
}

function renderPlanVersions(session: Session): RawHtml {
  if (session.plan.length === 0) return html`<p class="muted">No plan recorded.</p>`;
  const latestVersion = Math.max(...session.plan.map((p) => p.version));
  return joinHtml(
    session.plan.map((version) => {
      const checkedCount = version.steps.filter((s) => s.checked).length;
      const isLatest = version.version === latestVersion;
      return html`<details ${isLatest ? "open" : ""}>
  <summary>Plan v${version.version} (${checkedCount}/${version.steps.length} checked) — ${version.created_at}</summary>
  <ul class="plan-steps">${joinHtml(
    version.steps.map(
      (step) => html`<li class="${step.checked ? "checked" : "unchecked"}">${step.text}</li>`,
    ),
  )}</ul>
</details>`;
    }),
  );
}

function renderSession(session: Session, ticket: Ticket): RawHtml {
  const durationLabel =
    session.ended_at !== null
      ? `${session.started_at} → ${session.ended_at}`
      : `${session.started_at} → (active)`;
  // `id="session-<id>"` — a deep-link target for the "Active session" meta
  // row below, so following it lands on the session's own card rather than
  // just the top of the (potentially long) sessions list.
  return html`<div class="card" id="session-${session.id}">
  <div class="tree-node">
    <strong>${session.actor.name}</strong> (${session.actor.kind})
    <span class="badge">${session.harness.kind}</span>
    ${session.harness.session_id ? html`<span class="mono muted">${session.harness.session_id}</span>` : ""}
  </div>
  <p class="mono muted">${session.id}</p>
  <p class="muted">${durationLabel}</p>
  <p class="muted">git: ${session.git.branch ?? "—"} @ ${session.git.commit_at_start ?? "—"}</p>
  ${renderPlanVersions(session)}
  ${session.end_summary ? html`<p><strong>End summary:</strong> ${session.end_summary}</p>` : ""}
  ${
    session.transcript_ref
      ? html`<p><a href="/tickets/${ticket.id}/sessions/${session.id}/transcript">View transcript →</a></p>`
      : html`<p class="muted">No transcript captured for this session.</p>`
  }
</div>`;
}

export async function handleTicketDetail(
  req: BunRequest<"/tickets/:ref">,
  dataSource: WebDataSource,
  now: number,
): Promise<Response> {
  const ref = req.params.ref;
  const [ticket, { config, warning: configWarning }, allTickets] = await Promise.all([
    dataSource.findTicketByRef(ref),
    dataSource.getConfig(),
    dataSource.listTickets(),
  ]);
  if (!ticket) {
    return notFoundPage("tickets", `No ticket matches "${ref}".`);
  }

  const [sessions, events] = await Promise.all([
    dataSource.listSessionsForTicket(ticket.id),
    dataSource.listEventsForTicket(ticket.id),
  ]);

  // ticket_01KY9S0172V8AYCYV9KWS6RC9P: `latest_note`/`last_activity_at` as
  // `slop show` actually displays them — EFFECTIVE, not necessarily what's
  // stored verbatim on the ticket file (src/repo/db-index.ts's
  // `deriveEffectiveOverlay`, reused via overlays.ts's
  // `deriveEffectiveTickets`). `events` here already includes every
  // ticket-kind event for this ticket (WebDataSource's own contract), so
  // no extra read is needed beyond what the timeline below already fetched.
  const effectiveTicket = deriveEffectiveTickets([ticket], events)[0] ?? ticket;

  const thresholds = staleThresholdsFromConfig(config);
  const staleReason = computeStaleReason(effectiveTicket, thresholds, now);
  const stale = staleReason !== null;
  const blockers = liveBlockers(ticket.id, allTickets);
  const blocked = blockers.length > 0;

  const byId = new Map<TicketId, Ticket>(allTickets.map((t) => [t.id, t]));
  const reverseEdges = buildReverseEdgeIndex(allTickets);
  const localParent =
    ticket.parent !== undefined && isTicketId(ticket.parent) ? byId.get(ticket.parent) : undefined;
  const children = allTickets.filter((t) => t.parent === ticket.id);
  const handle = shortTicketCode(ticket.id);

  const specSection = html`<section class="section">
  <h2>Spec</h2>
  <p>${ticket.spec.summary}</p>
  ${ticket.spec.details_md ? html`<div class="details-md">${raw(renderMarkdownToString(ticket.spec.details_md))}</div>` : ""}
  ${
    ticket.spec.acceptance.length > 0
      ? html`<h3>Acceptance</h3><ul>${joinHtml(ticket.spec.acceptance.map((a) => html`<li>${a}</li>`))}</ul>`
      : ""
  }
  ${
    ticket.spec.context.length > 0
      ? html`<h3>Context</h3><ul>${joinHtml(ticket.spec.context.map((c) => html`<li>${c}</li>`))}</ul>`
      : ""
  }
  ${
    Object.keys(ticket.spec.meta).length > 0
      ? html`<h3>Meta</h3><dl class="meta-grid">${joinHtml(
          Object.entries(ticket.spec.meta).map(
            ([k, v]) =>
              html`<dt>${k}</dt><dd>${typeof v === "string" ? v : JSON.stringify(v)}</dd>`,
          ),
        )}</dl>`
      : ""
  }
</section>`;

  const resolutionSection = renderResolutionSection(ticket);
  const relationshipsSection = renderRelationshipsSection(ticket, byId, reverseEdges);

  const reviewSection =
    ticket.state === "review" && ticket.review
      ? html`<section class="section">
  <h2>Review</h2>
  <p>
    ${renderMrLink(ticket.review.mr)}
  </p>
  <p class="muted">Requested by ${ticket.review.by.name} at ${ticket.review.requested_at} — awaiting review for ${formatDurationShort(msSince(ticket.review.requested_at, now))}${stale ? html` ${staleBadge()}` : ""}</p>
</section>`
      : "";

  const activeSessionCell =
    ticket.active_session === null
      ? html`<span class="muted">none</span>`
      : sessions.some((s) => s.id === ticket.active_session)
        ? html`<a class="mono" href="#session-${ticket.active_session}">${ticket.active_session}</a>`
        : html`<span class="mono muted">${ticket.active_session}</span>`;

  const provenanceCell = html`${ticket.provenance.method} by ${ticket.provenance.created_by.name}${
    ticket.provenance.split_from
      ? html` (split from ${renderTicketRefList([ticket.provenance.split_from], byId)})`
      : ""
  }`;

  const body = html`<h1>
  ${stateBadge(ticket.state)} ${priorityBadge(ticket.priority)} ${ticket.name}
  ${stale ? staleBadge() : ""}
  ${blocked ? blockedBadge() : ""}
</h1>
<p class="mono muted">${handle} · ${ticket.id} · ${ticket.slug}</p>
${renderOverlayReasons(blockers, byId, staleReason, config, now)}
<dl class="meta-grid">
  <dt>Owner</dt><dd>${ticket.owner?.name ?? "—"}</dd>
  <dt>Labels</dt><dd>${labelChips(ticket.labels)}</dd>
  <dt>Adhoc</dt><dd>${ticket.adhoc ? "yes" : "no"}</dd>
  <dt>Parent</dt><dd>${
    localParent
      ? ticketLink(localParent)
      : ticket.parent !== undefined
        ? externalParentBadge(ticket.parent, config)
        : html`<span class="muted">— (root)</span>`
  }</dd>
  <dt>Children</dt><dd>${children.length > 0 ? joinHtml(children.map((c, i) => html`${i > 0 ? ", " : ""}${ticketLink(c)}`)) : html`<span class="muted">none</span>`}</dd>
  <dt>Ancestry</dt><dd>${ancestryBreadcrumb(ticket, byId)}</dd>
  <dt>Active session</dt><dd>${activeSessionCell}</dd>
  <dt>Latest note</dt><dd>${effectiveTicket.latest_note ?? html`<span class="muted">none</span>`}</dd>
  <dt>Last activity</dt><dd title="${effectiveTicket.last_activity_at}">${formatRelative(effectiveTicket.last_activity_at, now)}</dd>
  <dt>Created</dt><dd>${ticket.created_at}</dd>
  <dt>Updated</dt><dd>${ticket.updated_at}</dd>
  <dt>Provenance</dt><dd>${provenanceCell}</dd>
</dl>

${reviewSection}
${specSection}
${resolutionSection}
${relationshipsSection}

<section class="section">
  <h2>Updates timeline</h2>
  ${renderTimeline(events)}
</section>

<section class="section">
  <h2>Sessions</h2>
  ${sessions.length > 0 ? joinHtml(sessions.map((s) => renderSession(s, ticket))) : html`<p class="muted">No sessions yet.</p>`}
</section>`;

  return pageResponse({
    title: ticket.name,
    nav: null,
    project: config.project,
    configWarning,
    body,
  });
}
