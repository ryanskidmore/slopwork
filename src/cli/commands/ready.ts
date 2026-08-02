/**
 * `slop ready` — design.md §2, §4.2; work item B4, staleness wiring C5.
 *
 * `ready` = open ∧ no live blockers ∧ no active session. Drafts and review
 * items never appear (design.md §2). The pure selection/ordering this
 * command wraps lives in `src/tickets/ready.ts` — see that module's doc
 * for the exact `--resumable` scope (including C5's widened predicate)
 * and the `--budget` eliding strategy.
 *
 * ## C5: staleness feeds `--resumable`
 *
 * `filterResumableRows` (tickets/ready.ts) now ALSO includes an
 * in_progress/review ticket whose session is still technically active but
 * has gone stale (`stale_at`/`review_stale_at`, computed content-derived
 * at index-build time — db-index.ts — compared against `now` at READ time
 * — tickets/staleness.ts's `isStale`/`isReviewStale`). This command
 * supplies that `now` via {@link resolveClock}, mirroring `status.ts`'s
 * `SLOP_STATUS_FAKE_NOW` clock seam (this file's is `SLOP_READY_FAKE_NOW`
 * — `ready` had no clock override before C5; this introduces one,
 * following the same pattern) — real usage always uses `systemClock`, and
 * `tests/acceptance/C5.test.ts` pins it for deterministic assertions.
 *
 * ## C5: a stale review ticket surfaces WITH its MR link
 *
 * `IndexTicketRow` carries no `review` data (db-index.ts's row is a
 * summary, not the full ticket — same reasoning `status.ts` documents for
 * its own per-review-ticket read). So for every RESUMABLE row in `review`
 * state, this command does one `readTicket` to fetch `review.mr` — bounded
 * by how many resumable review tickets exist (normally a handful), same
 * fault-tolerance contract as `status.ts`'s `fetchTicketSafe` (an
 * unreadable ticket degrades that one row's `mr` to `null` rather than
 * crashing the command). `ready` (the strict, non-resumable section) never
 * needs this — review-state tickets never appear there at all.
 *
 * ## `--json` shape
 *
 * ```json
 * {
 *   "ready": [
 *     { "id", "slug", "handle", "name", "state", "priority", "labels", "why" }, ...
 *   ],
 *   "resumable_requested": boolean,
 *   "resumable": [
 *     { "id", "slug", "handle", "name", "state", "priority", "labels", "why", "mr"? }, ...
 *   ],
 *   "elided": ["<note>", ...],   // only non-empty when --budget forced elision
 *   "hint": "<string> | null"    // non-null only when both arrays above are empty
 * }
 * ```
 *
 * `resumable` is always present as a key (even without `--resumable`) so a
 * script never has to special-case a missing field — it's simply `[]`
 * unless `resumable_requested` is `true`. Every row carries exactly what
 * `slop start` needs next (id, slug, handle, name, priority, labels) plus
 * `why` this ticket is in the list — this work item's brief. `handle` is
 * the short `t-<code>` ref (core/ids.ts's `shortTicketCode`, computed —
 * never stored — same as `slop new`/`slop show`/`slop status`), so an
 * agent picking work here can start it with the short ref, not just the
 * full id. `mr` (C5) is only present on `review`-state rows — `string |
 * null`, `null` meaning "review-state, but no MR link on file yet" (D15:
 * entering review without `--mr` is allowed, just nagged).
 */
import type { Command } from "commander";
import type { Clock, TicketId } from "../../core/index.js";
import { fixedClock, shortTicketCode, systemClock } from "../../core/index.js";
import { repoPaths, requireRepoRoot } from "../../repo/index.js";
import { CONTEXT_PACK_BUDGET_UNIT } from "../../sessions/context-budget.js";
import type { StorageBackend } from "../../storage/index.js";
import { openStorage } from "../../storage/index.js";
import type { ReadyEntry } from "../../tickets/ready.js";
import {
  buildReadyEntries,
  filterReadyRows,
  filterResumableRows,
  renderReadyWithBudget,
} from "../../tickets/ready.js";
import { collect, parseBudgetOption, parsePriority } from "./shared.js";

interface ReadyCommandOptions {
  label?: string[];
  owner?: string;
  priority?: number;
  resumable?: boolean;
  includeAwaiting?: boolean;
  json?: boolean;
  budget?: number;
}

interface ReadyJsonRow {
  id: string;
  slug: string;
  /** handle-t-code-missing-from: short `t-<code>` ref — see module doc. */
  handle: string;
  name: string;
  state: string;
  priority: number;
  labels: string[];
  why: string;
  /** C5: only present on `review`-state rows — see module doc. */
  mr?: string | null;
}

/** Testing-only clock override — mirrors `status.ts`'s `SLOP_STATUS_FAKE_NOW`
 * (see this file's module doc, "C5: staleness feeds --resumable"). */
function resolveClock(): Clock {
  const raw = process.env.SLOP_READY_FAKE_NOW;
  if (!raw) return systemClock;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return systemClock;
  return fixedClock(parsed);
}

/** One `readTicket` per resumable review-state ticket, to surface its MR
 * link (C5) — `IndexTicketRow` carries no `review` field. Fault-tolerant:
 * an unreadable ticket degrades to `mr: null` for that row rather than
 * crashing the command, same contract as `status.ts`'s `fetchTicketSafe`. */
async function fetchReviewMrLinks(
  backend: StorageBackend,
  ids: readonly TicketId[],
): Promise<Map<TicketId, string | null>> {
  const pairs = await Promise.all(
    ids.map(async (id): Promise<[TicketId, string | null]> => {
      try {
        const ticket = await backend.readTicket(id);
        return [id, ticket.review?.mr ?? null];
      } catch (err) {
        process.stderr.write(
          `warning: could not read ticket ${id} for its MR link: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return [id, null];
      }
    }),
  );
  return new Map(pairs);
}

function toJsonRow(entry: ReadyEntry, mrLinks: ReadonlyMap<string, string | null>): ReadyJsonRow {
  const { row } = entry;
  return {
    id: row.id,
    slug: row.slug,
    handle: shortTicketCode(row.id),
    name: row.name,
    state: row.state,
    priority: row.priority,
    labels: row.labels,
    why: entry.why,
    mr: row.state === "review" ? (mrLinks.get(row.id) ?? null) : undefined,
  };
}

function renderJson(
  kept: readonly ReadyEntry[],
  elisions: readonly string[],
  resumableRequested: boolean,
  hint: string | null,
  mrLinks: ReadonlyMap<string, string | null>,
): string {
  const ready = kept.filter((e) => e.section === "ready").map((e) => toJsonRow(e, mrLinks));
  const resumable = kept.filter((e) => e.section === "resumable").map((e) => toJsonRow(e, mrLinks));
  const body = {
    ready,
    resumable_requested: resumableRequested,
    resumable,
    elided: elisions,
    hint,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function formatRow(entry: ReadyEntry, mrLinks: ReadonlyMap<string, string | null>): string {
  const { row } = entry;
  const labels = row.labels.length > 0 ? `  labels: ${row.labels.join(",")}` : "";
  const mrText = row.state === "review" ? `  mr: ${mrLinks.get(row.id) ?? "(no MR link yet)"}` : "";
  return `  [P${row.priority}] ${row.id}  ${row.slug}  "${row.name}"${labels}${mrText}  — ${entry.why}`;
}

function renderText(
  kept: readonly ReadyEntry[],
  elisions: readonly string[],
  resumableRequested: boolean,
  hint: string | null,
  mrLinks: ReadonlyMap<string, string | null>,
): string {
  const ready = kept.filter((e) => e.section === "ready");
  const resumable = kept.filter((e) => e.section === "resumable");
  const lines: string[] = [];

  if (hint !== null) {
    lines.push(hint);
  } else {
    lines.push(`ready (${ready.length}):`);
    for (const entry of ready) lines.push(formatRow(entry, mrLinks));
    if (resumableRequested) {
      lines.push("");
      lines.push(`resumable (${resumable.length}):`);
      for (const entry of resumable) lines.push(formatRow(entry, mrLinks));
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

export async function runReady(opts: ReadyCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const clock = resolveClock();
  const backend = await openStorage(paths);
  const { index } = await backend.loadIndex(clock);

  const resumableRequested = opts.resumable === true;
  // t-175oq: --label is now repeatable (AND, matching `slop list`'s own
  // semantics) and joined by --owner/--priority — every given filter must
  // match (see `tickets/ready.ts`'s `ReadyQueryOptions` doc).
  const queryOptions = {
    labels: opts.label ?? [],
    owner: opts.owner,
    priority: opts.priority,
    // G4 (t-jggg9): excludes awaiting_input rows by default — see
    // tickets/ready.ts's ReadyQueryOptions.includeAwaiting doc.
    includeAwaiting: opts.includeAwaiting,
  };
  const ready = filterReadyRows(index.tickets, queryOptions);
  const resumable = resumableRequested
    ? filterResumableRows(index.tickets, clock.now(), queryOptions)
    : [];
  const entries = buildReadyEntries(ready, resumable);
  const hint = hintFor(entries.length, resumableRequested);

  // C5: MR links for every resumable review-state row (ready's own
  // section never carries review-state rows — design.md §2).
  const reviewIds = resumable.filter((r) => r.row.state === "review").map((r) => r.row.id);
  const mrLinks = await fetchReviewMrLinks(backend, reviewIds);

  const rendered = renderReadyWithBudget(
    entries,
    (kept, elisions) =>
      opts.json
        ? renderJson(kept, elisions, resumableRequested, hint, mrLinks)
        : renderText(kept, elisions, resumableRequested, hint, mrLinks),
    opts.budget,
    opts.json ? "json" : "text",
  );
  process.stdout.write(rendered.text);
}

export function registerReadyCommand(program: Command): void {
  program
    .command("ready")
    .description("List ready tickets: open, no live blockers, no active session.")
    .option(
      "--label <label>",
      "filter to tickets carrying this label (repeatable; AND — every given label must be present)",
      collect,
      [] as string[],
    )
    .option("--owner <name>", "filter to tickets owned by this exact actor name")
    .option("--priority <0-3>", "filter to tickets at exactly this priority", parsePriority)
    .option(
      "--resumable",
      "also include stopped or stale in_progress/review tickets worth resuming",
    )
    .option(
      "--include-awaiting",
      "include tickets with an unanswered question (awaiting_input) — excluded by default " +
        "(G4): a ticket blocked on a human answer just stalls an agent that starts it",
    )
    .option("--json", "machine-readable output")
    .option(
      "--budget <n>",
      `cap output size to N ${CONTEXT_PACK_BUDGET_UNIT} (elides lowest-priority/least-relevant tickets first)`,
      parseBudgetOption,
    )
    .action(runReady);
}
