/**
 * Page shell, nav, and small badge renderers shared by every view in this
 * directory. Kept together so the six §4.4 views render with one
 * consistent look rather than six slightly different ones.
 */
import type { Config, Ticket, TicketState } from "../../core/index.js";
import { parseParentRef } from "../../core/index.js";
import { type HtmlValue, type RawHtml, escapeAttr, html, joinHtml, raw } from "../html.js";

export type NavKey = "tickets" | "tree" | "review" | "stale" | null;

const NAV_ITEMS: Array<{ key: NavKey; href: string; label: string }> = [
  { key: "tickets", href: "/tickets", label: "Tickets" },
  { key: "tree", href: "/tree", label: "Tree" },
  { key: "review", href: "/review", label: "Review" },
  { key: "stale", href: "/stale", label: "Stale" },
];

export function renderPage(opts: {
  title: string;
  nav: NavKey;
  project?: string;
  body: RawHtml;
}): string {
  const projectLabel = opts.project ? ` — ${opts.project}` : "";
  const navHtml = joinHtml(
    NAV_ITEMS.map(
      (item) =>
        html`<a href="${item.href}" class="navlink${item.key === opts.nav ? " active" : ""}">${item.label}</a>`,
    ),
  );
  const page = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}${projectLabel} · slop web</title>
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<header class="topbar">
  <div class="brand">slop web${projectLabel}</div>
  <nav>${navHtml}</nav>
</header>
<main>
${opts.body}
</main>
</body>
</html>`;
  return page.raw;
}

export function htmlResponse(bodyHtml: string, status = 200): Response {
  return new Response(bodyHtml, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function pageResponse(
  opts: { title: string; nav: NavKey; project?: string; body: RawHtml },
  status = 200,
): Response {
  return htmlResponse(renderPage(opts), status);
}

export function notFoundPage(nav: NavKey, message: string): Response {
  return pageResponse(
    { title: "Not found", nav, body: html`<h1>Not found</h1><p>${message}</p>` },
    404,
  );
}

const STATE_LABELS: Record<TicketState, string> = {
  draft: "Draft",
  open: "Open",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
  dropped: "Dropped",
};

export function stateBadge(state: TicketState): RawHtml {
  return html`<span class="badge state-${state}">${STATE_LABELS[state]}</span>`;
}

const PRIORITY_LABELS = ["P0 urgent", "P1", "P2", "P3 low"];

export function priorityBadge(priority: number): RawHtml {
  const label = PRIORITY_LABELS[priority] ?? `P${priority}`;
  return html`<span class="badge priority-${priority}">${label}</span>`;
}

export function blockedBadge(): RawHtml {
  return html`<span class="badge blocked" title="Has a live blocker">Blocked</span>`;
}

export function staleBadge(): RawHtml {
  return html`<span class="badge stale" title="No activity past the configured threshold">Stale</span>`;
}

export function labelChips(labels: readonly string[]): RawHtml {
  if (labels.length === 0) return raw("");
  return html`${labels.map((l) => html`<span class="chip">${l}</span>`)}`;
}

/**
 * design.md §4.4 / D1: an external `parent` (e.g. `jira:PROJ-123`)
 * terminates the local tree — rendered as a badge, never as a
 * traversable node. Builds the Jira browse URL from `remotes.jira`
 * (design.md §3) when the ref's system is `jira` and a base URL is
 * configured; otherwise renders the raw ref as inert text so it's still
 * visible without pretending to be a working link.
 */
export function externalParentBadge(ref: string, config: Config): RawHtml {
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
  if (system === "jira" && config.remotes.jira) {
    const url = `${config.remotes.jira.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`;
    return html`<a class="badge external-parent jira" href="${url}" target="_blank" rel="noopener noreferrer" title="External parent in Jira">↑ ${ref}</a>`;
  }
  return html`<span class="badge external-parent" title="External parent (no remote URL configured)">↑ ${ref}</span>`;
}

export function ticketLink(ticket: Ticket, text?: HtmlValue): RawHtml {
  return html`<a href="/tickets/${escapeAttr(ticket.id)}">${text ?? ticket.name}</a>`;
}
