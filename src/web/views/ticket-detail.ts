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
import { isTicketId } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import { type RawHtml, html, joinHtml, raw, safeUrl } from "../html.js";
import {
  computeBlockedTicketIds,
  formatDurationShort,
  formatRelative,
  isTicketStale,
  msSince,
  staleThresholdsFromConfig,
} from "../overlays.js";
import { renderMarkdownToString } from "../markdown.js";
import {
  blockedBadge,
  externalParentBadge,
  labelChips,
  notFoundPage,
  pageResponse,
  priorityBadge,
  stateBadge,
  staleBadge,
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

function renderTimeline(events: readonly Event[]): RawHtml {
  if (events.length === 0) return html`<p class="muted">No events yet.</p>`;
  // Oldest-first internally (event-id/ULID order, per WebDataSource's contract); reversed here for newest-first display — see this file's header comment for why.
  const newestFirst = [...events].reverse();
  return html`<ul class="timeline">${joinHtml(
    newestFirst.map(
      (event) => html`<li>
  <span class="ts" title="${event.at}">${event.at}</span>
  <strong>${event.actor.name}</strong> (${event.actor.kind}) — ${eventLabel(event)}
  ${renderPayload(event.payload)}
</li>`,
    ),
  )}</ul>`;
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
  return html`<div class="card">
  <div class="tree-node">
    <strong>${session.actor.name}</strong> (${session.actor.kind})
    <span class="badge">${session.harness.kind}</span>
    ${session.harness.session_id ? html`<span class="mono muted">${session.harness.session_id}</span>` : ""}
  </div>
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
  const [ticket, config, allTickets] = await Promise.all([
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

  const thresholds = staleThresholdsFromConfig(config);
  const stale = isTicketStale(ticket, thresholds, now);
  const blocked = computeBlockedTicketIds(allTickets).has(ticket.id);

  const byId = new Map<TicketId, Ticket>(allTickets.map((t) => [t.id, t]));
  const localParent =
    ticket.parent !== undefined && isTicketId(ticket.parent) ? byId.get(ticket.parent) : undefined;
  const children = allTickets.filter((t) => t.parent === ticket.id);

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

  const body = html`<h1>
  ${stateBadge(ticket.state)} ${priorityBadge(ticket.priority)} ${ticket.name}
  ${stale ? staleBadge() : ""}
  ${blocked ? blockedBadge() : ""}
</h1>
<p class="mono muted">${ticket.id} · ${ticket.slug}</p>
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
  <dt>Last activity</dt><dd title="${ticket.last_activity_at}">${formatRelative(ticket.last_activity_at, now)}</dd>
  <dt>Created</dt><dd>${ticket.created_at}</dd>
</dl>

${reviewSection}
${specSection}
${resolutionSection}

<section class="section">
  <h2>Updates timeline</h2>
  ${renderTimeline(events)}
</section>

<section class="section">
  <h2>Sessions</h2>
  ${sessions.length > 0 ? joinHtml(sessions.map((s) => renderSession(s, ticket))) : html`<p class="muted">No sessions yet.</p>`}
</section>`;

  return pageResponse({ title: ticket.name, nav: null, project: config.project, body });
}
