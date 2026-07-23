/**
 * `slop show <ref> --context` (B1, design.md §4.2/§5.2): the context
 * pack — spec, ancestry, blockers, prior sessions. Sessions land for real
 * with C1 (`start` creates them); this renders whatever sessions already
 * exist for the ticket today (none, in a freshly-`new`'d repo) through
 * the exact same {@link ContextPackData.sessions} field C1's `start`/
 * `context` commands should keep populating — the section is structured
 * to extend (add plan-progress detail per session, etc.), not rewrite.
 */
import type { Config, Session, Ticket } from "../core/index.js";
import { renderSessionPlanSection } from "../sessions/plan-render.js";
import { jiraBrowseUrl } from "./jira.js";

export interface ContextPackData {
  ticket: Ticket;
  config: Config;
  /** Local ancestors, root-first, NOT including `ticket` itself (i.e. `ticket.path` resolved to full tickets). */
  ancestors: Ticket[];
  /** The local root's own external `parent` ref (D1), if any — set only when the local root itself has one. */
  externalParentRef?: string;
  /** Tickets that block this one and haven't finished (state not `done`/`dropped`). */
  blockers: Ticket[];
  /** Sessions for this ticket, most-recent-first. Empty until C1 lands `start`. */
  sessions: Session[];
}

/** Rough token->char conversion for `--budget N` (E1 generalises this
 * properly; this is the "if you can do so cheaply" version B1's brief
 * asks for) — ~4 characters per token is a standard rough-order-of
 * -magnitude estimate for English prose and JSON-ish text alike. */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

export function budgetCharsFromTokens(budgetTokens: number): number {
  return Math.max(0, Math.floor(budgetTokens * CHARS_PER_TOKEN_ESTIMATE));
}

const TRUNCATION_NOTE = "\n\n… [truncated to fit --budget]";

function sessionLine(session: Session): string {
  const status = session.ended_at ? `ended ${session.ended_at}` : "active";
  return (
    `  - ${session.id} actor=${session.actor.name} harness=${session.harness.kind} ` +
    `started=${session.started_at} (${status})`
  );
}

/**
 * Render the context pack as plain text. `budgetChars`, when given, caps
 * the output length (post-render truncation with a note — cheap, not
 * section-aware; E1's `--budget` generalisation can make this smarter).
 */
export function renderContextPack(data: ContextPackData, budgetChars?: number): string {
  const { ticket } = data;
  const lines: string[] = [];

  lines.push(`# Context: ${ticket.name} (${ticket.slug})`);
  lines.push(`${ticket.id}  state=${ticket.state}  priority=${ticket.priority}`);
  lines.push("");

  lines.push("## Spec");
  lines.push(ticket.spec.summary);
  if (ticket.spec.details_md.trim().length > 0) {
    lines.push("");
    lines.push(ticket.spec.details_md);
  }
  if (ticket.spec.acceptance.length > 0) {
    lines.push("");
    lines.push("Acceptance:");
    for (const a of ticket.spec.acceptance) lines.push(`  - ${a}`);
  }
  if (ticket.spec.context.length > 0) {
    lines.push("");
    lines.push("Context notes:");
    for (const c of ticket.spec.context) lines.push(`  - ${c}`);
  }
  lines.push("");

  lines.push("## Ancestry");
  if (data.externalParentRef !== undefined) {
    const url = jiraBrowseUrl(data.config, data.externalParentRef);
    lines.push(`  ↑ external parent: ${data.externalParentRef}${url ? ` (${url})` : ""}`);
  }
  if (data.ancestors.length === 0) {
    lines.push(
      data.externalParentRef !== undefined ? "  (local root)" : "  (root ticket, no parent)",
    );
  } else {
    for (const a of data.ancestors) lines.push(`  ${a.name} [${a.slug}] (${a.state})`);
  }
  lines.push("");

  lines.push("## Blockers");
  if (data.blockers.length === 0) {
    lines.push("  none");
  } else {
    for (const b of data.blockers) lines.push(`  - ${b.name} [${b.slug}] (${b.state})`);
  }
  lines.push("");

  lines.push("## Prior sessions");
  if (data.sessions.length === 0) {
    lines.push("  none yet");
  } else {
    for (const s of data.sessions) {
      lines.push(sessionLine(s));
      // C2: step status (+ version history, so "plan v2 diffable from v1"
      // is observable here, not just true of the underlying data) —
      // `[]` when this session has no plan, so older/unplanned sessions
      // add no extra lines.
      lines.push(...renderSessionPlanSection(s));
    }
  }

  let text = lines.join("\n");
  if (budgetChars !== undefined && text.length > budgetChars) {
    const keep = Math.max(0, budgetChars - TRUNCATION_NOTE.length);
    text = `${text.slice(0, keep)}${TRUNCATION_NOTE}`;
  }
  return text;
}
