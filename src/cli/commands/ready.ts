/**
 * `slop ready` — design.md §2, §4.2; work item B4.
 *
 * `ready` = open ∧ no live blockers ∧ no active session. Drafts and review
 * items never appear (design.md §2). The pure selection/ordering this
 * command wraps lives in `src/tickets/ready.ts` — see that module's doc
 * for the exact `--resumable` scope today vs. what C5 adds, and for the
 * `--budget` eliding strategy.
 *
 * ## `--json` shape
 *
 * ```json
 * {
 *   "ready": [
 *     { "id", "slug", "name", "state", "priority", "labels", "why" }, ...
 *   ],
 *   "resumable_requested": boolean,
 *   "resumable": [
 *     { "id", "slug", "name", "state", "priority", "labels", "why" }, ...
 *   ],
 *   "elided": ["<note>", ...],   // only non-empty when --budget forced elision
 *   "hint": "<string> | null"    // non-null only when both arrays above are empty
 * }
 * ```
 *
 * `resumable` is always present as a key (even without `--resumable`) so a
 * script never has to special-case a missing field — it's simply `[]`
 * unless `resumable_requested` is `true`. Every row carries exactly what
 * `slop start` needs next (id, slug, name, priority, labels) plus `why`
 * this ticket is in the list — this work item's brief.
 */
import type { Command } from "commander";
import { loadIndex, repoPaths, requireRepoRoot } from "../../repo/index.js";
import { CONTEXT_PACK_BUDGET_UNIT } from "../../sessions/context-budget.js";
import type { ReadyEntry } from "../../tickets/ready.js";
import {
  buildReadyEntries,
  filterReadyRows,
  filterResumableRows,
  renderReadyWithBudget,
} from "../../tickets/ready.js";
import { parseIntegerOption } from "./shared.js";

interface ReadyCommandOptions {
  label?: string;
  resumable?: boolean;
  json?: boolean;
  budget?: number;
}

interface ReadyJsonRow {
  id: string;
  slug: string;
  name: string;
  state: string;
  priority: number;
  labels: string[];
  why: string;
}

function toJsonRow(entry: ReadyEntry): ReadyJsonRow {
  const { row } = entry;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    state: row.state,
    priority: row.priority,
    labels: row.labels,
    why: entry.why,
  };
}

function renderJson(
  kept: readonly ReadyEntry[],
  elisions: readonly string[],
  resumableRequested: boolean,
  hint: string | null,
): string {
  const ready = kept.filter((e) => e.section === "ready").map(toJsonRow);
  const resumable = kept.filter((e) => e.section === "resumable").map(toJsonRow);
  const body = {
    ready,
    resumable_requested: resumableRequested,
    resumable,
    elided: elisions,
    hint,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function formatRow(entry: ReadyEntry): string {
  const { row } = entry;
  const labels = row.labels.length > 0 ? `  labels: ${row.labels.join(",")}` : "";
  return `  [P${row.priority}] ${row.id}  ${row.slug}  "${row.name}"${labels}  — ${entry.why}`;
}

function renderText(
  kept: readonly ReadyEntry[],
  elisions: readonly string[],
  resumableRequested: boolean,
  hint: string | null,
): string {
  const ready = kept.filter((e) => e.section === "ready");
  const resumable = kept.filter((e) => e.section === "resumable");
  const lines: string[] = [];

  if (hint !== null) {
    lines.push(hint);
  } else {
    lines.push(`ready (${ready.length}):`);
    for (const entry of ready) lines.push(formatRow(entry));
    if (resumableRequested) {
      lines.push("");
      lines.push(`resumable (${resumable.length}):`);
      for (const entry of resumable) lines.push(formatRow(entry));
    }
  }

  if (elisions.length > 0) {
    lines.push("");
    lines.push(`(--budget, ${CONTEXT_PACK_BUDGET_UNIT}):`);
    for (const note of elisions) lines.push(`  - ${note}`);
  }

  return `${lines.join("\n")}\n`;
}

function hintFor(entryCount: number, resumableRequested: boolean): string | null {
  if (entryCount > 0) return null;
  return (
    "nothing ready right now — run `slop status` to see what's blocking" +
    (resumableRequested ? "" : ", or pass --resumable to include stopped in_progress/review work")
  );
}

async function runReady(opts: ReadyCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const { index } = await loadIndex(paths);

  const resumableRequested = opts.resumable === true;
  const ready = filterReadyRows(index.tickets, { label: opts.label });
  const resumable = resumableRequested ? filterResumableRows(index.tickets, { label: opts.label }) : [];
  const entries = buildReadyEntries(ready, resumable);
  const hint = hintFor(entries.length, resumableRequested);

  const rendered = renderReadyWithBudget(
    entries,
    (kept, elisions) =>
      opts.json
        ? renderJson(kept, elisions, resumableRequested, hint)
        : renderText(kept, elisions, resumableRequested, hint),
    opts.budget,
  );
  process.stdout.write(rendered.text);
}

export function registerReadyCommand(program: Command): void {
  program
    .command("ready")
    .description("List ready tickets: open, no live blockers, no active session.")
    .option("--label <label>", "filter to tickets carrying this label")
    .option("--resumable", "also include stopped in_progress/review tickets worth resuming")
    .option("--json", "machine-readable output")
    .option(
      "--budget <n>",
      `cap output size to N ${CONTEXT_PACK_BUDGET_UNIT} (elides lowest-priority/least-relevant tickets first)`,
      parseIntegerOption("--budget"),
    )
    .action(runReady);
}
