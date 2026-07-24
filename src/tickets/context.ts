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
 * section-aware).
 *
 * No live command calls this with a `budgetChars` today: `slop show
 * --context`/`slop context` both went through `sessions/context-budget.ts`'s
 * `renderContextPackWithBudget` instead (E1's smarter, section-aware
 * elider — drops oldest sessions, then long `spec.details_md`, before ever
 * falling back to a raw slice of ITS OWN output, never this function's).
 * `budgetChars` stays a supported parameter of this function itself
 * (exercised directly by this file's own tests) rather than being removed,
 * since it's still the simplest correct primitive `renderContextPackWithBudget`
 * builds on.
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
    // budget-flags-units-and-validation: for a `budgetChars` smaller than
    // TRUNCATION_NOTE's own length, `slice(0, keep) + TRUNCATION_NOTE` used
    // to overshoot — `keep` floors at 0, but the note itself still gets
    // appended in full, so the result stays longer than `budgetChars` (e.g.
    // `budgetChars=10` still returned all ~32 characters of the note alone).
    // A raw slice, with no note, is the only thing that can never exceed a
    // budget this tiny — same reasoning context-budget.ts's smarter elider
    // uses for ITS own last-resort raw-slice step.
    text =
      budgetChars < TRUNCATION_NOTE.length
        ? text.slice(0, Math.max(0, budgetChars))
        : `${text.slice(0, budgetChars - TRUNCATION_NOTE.length)}${TRUNCATION_NOTE}`;
  }
  return text;
}
