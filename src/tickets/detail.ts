/**
 * `slop show <ref>` (B1)'s default (no `--context`/`--tree`) output: id,
 * slug, name, state, priority, labels, owner, parent, spec, edges,
 * timestamps, latest note — design.md §4.1 item 1's full field list.
 * Explicit acceptance clause: a `jira:` parent must render here, browse
 * URL included when `remotes.jira` is configured.
 */
import type { Config, Ticket } from "../core/index.js";
import { isTicketId } from "../core/index.js";
import { jiraBrowseUrl } from "./jira.js";

function listOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

function formatMetaLines(meta: Record<string, unknown>): string[] {
  const keys = Object.keys(meta);
  if (keys.length === 0) return [];
  return ["  meta:", ...keys.map((k) => `    ${k}: ${JSON.stringify(meta[k])}`)];
}

function formatParentLine(ticket: Ticket, config: Config): string {
  if (ticket.parent === undefined) return "parent: (none — root ticket)";
  if (isTicketId(ticket.parent)) return `parent: ${ticket.parent}  (local)`;
  const url = jiraBrowseUrl(config, ticket.parent);
  return `parent: ${ticket.parent}  (external)${url ? `  ${url}` : "  (no remotes.jira configured)"}`;
}

function formatReviewLine(ticket: Ticket): string | null {
  if (!ticket.review) return null;
  const mr = ticket.review.mr ? `mr=${ticket.review.mr}` : "mr=(none yet)";
  return `review: requested_at=${ticket.review.requested_at} by=${ticket.review.by.name} ${mr}`;
}

export function formatTicketDetail(ticket: Ticket, config: Config): string {
  const lines: string[] = [];

  lines.push(ticket.id);
  lines.push(`slug: ${ticket.slug}`);
  lines.push(`name: ${ticket.name}`);
  lines.push(`state: ${ticket.state}${ticket.adhoc ? "  (adhoc)" : ""}`);
  lines.push(`priority: ${ticket.priority}`);
  lines.push(`labels: ${listOrNone(ticket.labels)}`);
  lines.push(`owner: ${ticket.owner ? `${ticket.owner.name} (${ticket.owner.kind})` : "(none)"}`);
  lines.push(formatParentLine(ticket, config));
  lines.push(`root: ${ticket.root_id}`);
  lines.push(`path: ${ticket.path.length > 0 ? ticket.path.join(" > ") : "(root)"}`);
  const reviewLine = formatReviewLine(ticket);
  if (reviewLine) lines.push(reviewLine);

  lines.push("");
  lines.push("spec:");
  lines.push(`  summary: ${ticket.spec.summary}`);
  if (ticket.spec.details_md.trim().length > 0) {
    lines.push("  details_md:");
    for (const l of ticket.spec.details_md.split("\n")) lines.push(`    ${l}`);
  }
  if (ticket.spec.acceptance.length > 0) {
    lines.push("  acceptance:");
    for (const a of ticket.spec.acceptance) lines.push(`    - ${a}`);
  }
  if (ticket.spec.context.length > 0) {
    lines.push("  context:");
    for (const c of ticket.spec.context) lines.push(`    - ${c}`);
  }
  lines.push(...formatMetaLines(ticket.spec.meta));

  lines.push("");
  lines.push("edges:");
  lines.push(`  blocks: ${listOrNone(ticket.blocks)}`);
  lines.push(`  relates_to: ${listOrNone(ticket.relates_to)}`);
  lines.push(`  discovered_from: ${listOrNone(ticket.discovered_from)}`);

  lines.push("");
  lines.push(`active_session: ${ticket.active_session ?? "(none)"}`);
  lines.push(`latest_note: ${ticket.latest_note ?? "(none)"}`);
  lines.push(`last_activity_at: ${ticket.last_activity_at}`);
  lines.push(`created_at: ${ticket.created_at}`);
  lines.push(`updated_at: ${ticket.updated_at}`);
  const splitFrom = ticket.provenance.split_from
    ? `  split_from=${ticket.provenance.split_from}`
    : "";
  lines.push(
    `provenance: method=${ticket.provenance.method} created_by=${ticket.provenance.created_by.name}${splitFrom}`,
  );

  return lines.join("\n");
}
