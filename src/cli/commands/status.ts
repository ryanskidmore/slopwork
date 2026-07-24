/**
 * `slop status` — design.md §4.2 ("project pulse: counts by state,
 * in-progress w/ sessions, stale, awaiting review (with MR links)"),
 * §4.7 item 4 ("`slop status` + `slop web` fully replace 'scroll the
 * terminal to find out what happened.'"); work item D4.
 *
 * ## Performance ("< 1s on 1k tickets")
 *
 * Reads from {@link loadIndex} — one JSONC file (self-healing, fingerprint
 * -checked; see db-index.ts) — never `listTickets`/`listTicketsTolerant`
 * over every ticket file. The only per-entity reads this command performs
 * are targeted and small in practice, never O(all tickets):
 *   - one `readSession` per **in_progress** ticket's `active_session` (for
 *     the in-progress section's actor/harness/age — this data isn't in
 *     the index, and there are normally only a handful of these at once);
 *   - one `readTicket` per **review**-state ticket (for `review.mr`/
 *     `review.requested_at`/`review.by` — `IndexTicketRow` doesn't carry
 *     `review` at all, so this is the only way to get the MR link; again,
 *     normally a handful).
 * Both reads are fault-tolerant (a missing/corrupt file degrades that one
 * row rather than crashing the command — see {@link fetchSessionSafe}/
 * {@link fetchTicketSafe}) and run in parallel via `Promise.all`.
 *
 * ## Reading B4's derived index fields generically; C5's staleness is live
 *
 * `IndexTicketRow.blocked_count` is `number | null` — `null` means a
 * pre-B4 index that hasn't been rebuilt since (a narrow, self-healing
 * gap — db-index.ts's doc). This command maps it straight through to
 * `tickets/status.ts`'s pure aggregation, which treats "every row's field
 * is null" as "not computed" (see that module's doc).
 *
 * `stale`/`review_stale` no longer work that way (C5): `IndexTicketRow`
 * carries `stale_at`/`review_stale_at` — content-derived DEADLINES, not
 * booleans (see db-index.ts's "C5" doc section for why a live boolean
 * can never be safely baked into the index). This command computes the
 * live boolean itself, per row, via `tickets/staleness.ts`'s
 * `isStale`/`isReviewStale` against THIS command's own resolved clock
 * (see "Clock seam" below) — `now > stale_at`, so the exact same on-disk
 * index row reads as fresh or stale purely depending on when `status` is
 * run. This is the read-time half of C5's design; `stale_at` itself never
 * changes just because time passed.
 *
 * ## Clock seam
 *
 * Humanised ages, and now (C5) the live stale/review-stale booleans, are
 * a function of "now". Real usage always uses {@link systemClock}.
 * `SLOP_STATUS_FAKE_NOW`, mirroring `slop web`'s `SLOP_WEB_FAKE_NOW` (see
 * `src/cli/commands/web.ts`, DECISIONS.md's D5 entries), pins the clock
 * instead when set to a parseable date — undocumented as a user-facing
 * flag, read only here, and how `tests/acceptance/D4.test.ts` and
 * `tests/acceptance/C5.test.ts` get deterministic output out of a real
 * spawned `dist/slop status` process.
 *
 * ## `--json` shape
 *
 * ```json
 * {
 *   "generated_at": "<ISO timestamp>",
 *   "counts": { "draft":0, "open":0, "in_progress":0, "review":0, "done":0, "dropped":0, "total":0 },
 *   "derived": { "blocked": number | null, "stale": number },
 *   "in_progress": [
 *     {
 *       "id", "slug", "name", "priority",
 *       "session": {
 *         "id", "actor", "harness", "started_at",
 *         "age_ms": number, "age_human": "2h"
 *       } | null
 *     }, ...
 *   ],   // sorted oldest-session-first; null session = active_session unset or unreadable
 *   "review": [
 *     { "id", "slug", "name", "mr": string | null, "requested_at", "by", "age_ms", "age_human", "review_stale": boolean }, ...
 *   ],   // sorted longest-waiting-first; review_stale (C5) marks it WITHOUT hiding the mr link
 *   "stale": [ { "id", "slug", "name", "state": "in_progress" | "review" }, ... ],
 *   // always an array now (C5 has landed) — never null.
 *   "problems": [ { "id", "message" }, ... ],  // session/ticket files this run couldn't read; usually []
 *   "elided": ["<note>", ...]  // E1's --budget; only non-empty when a budget forced elision
 * }
 * ```
 *
 * `--json` was previously never truncated ("the human view is what stays
 * to 'one screen'; `--json` is the full-fidelity agent path") — **E1 adds
 * `--budget N`**, which now bounds BOTH views (this is exactly the
 * "every read respects budget" acceptance clause). Without `--budget`,
 * behavior is unchanged — `--json` still returns everything, `capRows`
 * still keeps the human view to one screen. With it, this command elides
 * whole rows least-important-first: `stale` rows first (the section
 * already implied by the `stale`/`review_stale` flags elsewhere), then
 * `review` rows (from the least-long-waiting end), then `in_progress` rows
 * (from the least-stale end) — `counts`/`derived`/`problems` are always
 * kept in full (small, fixed-size, and the whole point of a "pulse" view).
 * `--json`'s new `elided` array (always present, like `ready`/`search`/
 * `events`) names what was dropped; never corrupts the JSON at any budget
 * (`core/budget.ts`'s `renderEntriesWithBudget`, same helper `ready`/
 * `search`/`events` use).
 */
import type { Command } from "commander";
import type {
  Clock,
  RenderFormat,
  Session,
  SessionId,
  Ticket,
  TicketId,
} from "../../core/index.js";
import {
  fixedClock,
  renderEntriesWithBudget,
  shortTicketCode,
  systemClock,
  TICKET_STATES,
} from "../../core/index.js";
import type { IndexTicketRow, RepoPaths } from "../../repo/index.js";
import {
  loadIndex,
  readSession,
  readTicket,
  repoPaths,
  requireRepoRoot,
} from "../../repo/index.js";
import { CONTEXT_PACK_BUDGET_UNIT } from "../../sessions/context-budget.js";
import { isReviewStale, isStale } from "../../tickets/staleness.js";
import type {
  DerivedOverlayCounts,
  InProgressTicketRow,
  ReviewTicketRow,
  StaleTicketRow,
  StateCounts,
  StatusTicketRow,
} from "../../tickets/status.js";
import {
  aggregateDerivedCounts,
  aggregateStateCounts,
  capRows,
  humanizeAge,
  msSince,
  sortInProgressRows,
  sortReviewRows,
  staleTicketRows,
} from "../../tickets/status.js";
import { parseIntegerOption } from "./shared.js";

interface StatusCommandOptions {
  json?: boolean;
  budget?: number;
}

interface StatusProblem {
  id: string;
  message: string;
}

/** Testing-only clock override — see this file's module doc, "Clock seam". */
function resolveClock(): Clock {
  const raw = process.env.SLOP_STATUS_FAKE_NOW;
  if (!raw) return systemClock;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return systemClock;
  return fixedClock(parsed);
}

/** C5: `stale`/`reviewStale` are computed LIVE here, against `now` — never
 * read off the index directly (the index only stores the `stale_at`/
 * `review_stale_at` deadline; see this file's module doc). */
function toStatusRow(row: IndexTicketRow, now: Date): StatusTicketRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    state: row.state,
    blockedCount: row.blocked_count,
    stale: isStale(row, now),
    reviewStale: isReviewStale(row, now),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One `readSession` per in_progress ticket — never `listSessions` (which
 * would read every session in the db). Never throws: a missing/corrupt
 * session file degrades that one ticket's `session` to `null` (recorded
 * in `problems`, warned on stderr) rather than crashing `status`. */
async function fetchSessionSafe(
  paths: RepoPaths,
  id: SessionId,
  problems: StatusProblem[],
): Promise<Session | null> {
  try {
    return await readSession(paths, id);
  } catch (err) {
    const message = errorMessage(err);
    problems.push({ id, message });
    process.stderr.write(`warning: could not read session ${id}: ${message}\n`);
    return null;
  }
}

/** One `readTicket` per review-state ticket — the index row has no
 * `review` field (db-index.ts's `IndexTicketRow` doesn't carry it), so
 * this is the only way to get `review.mr`/`requested_at`/`by`. Same
 * fault-tolerance contract as {@link fetchSessionSafe}. */
async function fetchTicketSafe(
  paths: RepoPaths,
  id: TicketId,
  problems: StatusProblem[],
): Promise<Ticket | null> {
  try {
    return await readTicket(paths, id);
  } catch (err) {
    const message = errorMessage(err);
    problems.push({ id, message });
    process.stderr.write(`warning: could not read ticket ${id}: ${message}\n`);
    return null;
  }
}

interface StatusData {
  counts: StateCounts;
  derived: DerivedOverlayCounts;
  inProgress: InProgressTicketRow[];
  review: ReviewTicketRow[];
  stale: StaleTicketRow[];
  problems: StatusProblem[];
}

async function gatherStatus(paths: RepoPaths, clock: Clock): Promise<StatusData> {
  const now = clock.now();
  const nowMs = now.getTime();
  const { index } = await loadIndex(paths, clock);
  const rows = index.tickets;
  const statusRows = rows.map((row) => toStatusRow(row, now));

  const counts = aggregateStateCounts(statusRows);
  const derived = aggregateDerivedCounts(statusRows);
  const stale = staleTicketRows(statusRows);

  const problems: StatusProblem[] = [];

  const inProgressPairs = await Promise.all(
    rows
      .filter((row) => row.state === "in_progress")
      .map(async (row) => {
        const session = row.active_session
          ? await fetchSessionSafe(paths, row.active_session, problems)
          : null;
        return { row, session };
      }),
  );
  const inProgress = sortInProgressRows(
    inProgressPairs.map(({ row, session }) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      priority: row.priority,
      session: session
        ? {
            id: session.id,
            actor: session.actor.name,
            harness: session.harness.kind,
            startedAt: session.started_at,
            ageMs: msSince(session.started_at, nowMs),
          }
        : null,
    })),
  );

  const reviewPairs = await Promise.all(
    rows
      .filter((row) => row.state === "review")
      .map(async (row) => ({ row, ticket: await fetchTicketSafe(paths, row.id, problems) })),
  );
  const review: ReviewTicketRow[] = [];
  for (const { row, ticket } of reviewPairs) {
    if (!ticket?.review) continue; // unreadable, or (shouldn't happen given the schema's refine) missing review data
    review.push({
      id: row.id,
      slug: row.slug,
      name: row.name,
      mr: ticket.review.mr ?? null,
      requestedAt: ticket.review.requested_at,
      by: ticket.review.by.name,
      ageMs: msSince(ticket.review.requested_at, nowMs),
      // C5: the index row already carries the content-derived deadline
      // (review_stale_at, from the SAME review.requested_at) — this is the
      // read-time boolean, computed against this command's own clock. The
      // acceptance criterion this satisfies: a stale review ticket
      // surfaces in this exact section, WITH its `mr` link above, still
      // shown for every review row regardless of staleness.
      reviewStale: isReviewStale(row, now),
    });
  }

  return { counts, derived, inProgress, review: sortReviewRows(review), stale, problems };
}

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

const LABEL_WIDTH = Math.max(
  ...TICKET_STATES.map((s) => s.length),
  "total".length,
  "blocked".length,
);

function renderCountsSection(counts: StateCounts, derived: DerivedOverlayCounts): string[] {
  const lines: string[] = [];
  for (const state of TICKET_STATES) {
    lines.push(`  ${state.padEnd(LABEL_WIDTH)}  ${String(counts[state]).padStart(5)}`);
  }
  lines.push(`  ${"-".repeat(LABEL_WIDTH + 7)}`);
  lines.push(`  ${"total".padEnd(LABEL_WIDTH)}  ${String(counts.total).padStart(5)}`);
  lines.push("");
  lines.push(
    `  ${"blocked".padEnd(LABEL_WIDTH)}  ${
      derived.blocked === null ? "—".padStart(5) : String(derived.blocked).padStart(5)
    }${derived.blocked === null ? "  (not yet computed — B4)" : ""}`,
  );
  lines.push(`  ${"stale".padEnd(LABEL_WIDTH)}  ${String(derived.stale).padStart(5)}`);
  return lines;
}

function renderInProgressSection(rows: readonly InProgressTicketRow[]): string[] {
  const lines: string[] = [`In progress (${rows.length}, oldest session first):`];
  if (rows.length === 0) {
    lines.push("  (none)");
    return lines;
  }
  const { shown, omitted } = capRows(rows);
  for (const row of shown) {
    const sessionText = row.session
      ? `${row.session.actor} (${row.session.harness})  ${humanizeAge(row.session.ageMs)}`
      : "(no active session on file)";
    // ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1: the short t-<code> handle,
    // computed (never stored) alongside id/slug so a human/agent sees it
    // right where they'd otherwise copy the full id to reuse.
    lines.push(`  ${row.slug.padEnd(30)}  ${row.id}  (${shortTicketCode(row.id)})  ${sessionText}`);
  }
  if (omitted > 0) lines.push(`  … and ${omitted} more`);
  return lines;
}

function renderReviewSection(rows: readonly ReviewTicketRow[]): string[] {
  const lines: string[] = [`Awaiting review (${rows.length}, longest-waiting first):`];
  if (rows.length === 0) {
    lines.push("  (none)");
    return lines;
  }
  const { shown, omitted } = capRows(rows);
  for (const row of shown) {
    // C5: reviewStale marks the row WITHOUT hiding its MR link — the mr
    // field above always renders regardless of staleness (this work
    // item's acceptance: "stale review ticket surfaces with MR link").
    const staleTag = row.reviewStale ? "  [STALE]" : "";
    lines.push(
      `  ${row.slug.padEnd(30)}  ${row.id}  (${shortTicketCode(row.id)})  ${row.mr ?? "(no MR link yet)"}  ${row.by}  ${humanizeAge(row.ageMs)}${staleTag}`,
    );
  }
  if (omitted > 0) lines.push(`  … and ${omitted} more`);
  return lines;
}

function renderStaleSection(rows: readonly StaleTicketRow[]): string[] {
  const lines: string[] = [`Stale (${rows.length}):`];
  if (rows.length === 0) {
    lines.push("  (none)");
    return lines;
  }
  const { shown, omitted } = capRows(rows);
  for (const row of shown) {
    lines.push(`  ${row.slug.padEnd(30)}  ${row.id}  (${shortTicketCode(row.id)})  ${row.state}`);
  }
  if (omitted > 0) lines.push(`  … and ${omitted} more`);
  return lines;
}

function buildHuman(data: StatusData, elisions: readonly string[]): string {
  if (data.counts.total === 0) {
    return 'no tickets yet — `slop new "..."` to create one\n';
  }

  const lines: string[] = [`Slopwork status — ${data.counts.total} ticket(s)`, ""];
  lines.push(...renderCountsSection(data.counts, data.derived));
  lines.push("");
  lines.push(...renderInProgressSection(data.inProgress));
  lines.push("");
  lines.push(...renderReviewSection(data.review));
  lines.push("");
  lines.push(...renderStaleSection(data.stale));

  if (elisions.length > 0) {
    lines.push("");
    lines.push(`(--budget, ${CONTEXT_PACK_BUDGET_UNIT}):`);
    for (const note of elisions) lines.push(`  - ${note}`);
  }

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// --json rendering
// ---------------------------------------------------------------------------

function buildJson(data: StatusData, generatedAtIso: string, elisions: readonly string[]): string {
  const body = {
    generated_at: generatedAtIso,
    counts: data.counts,
    derived: data.derived,
    in_progress: data.inProgress.map((row) => ({
      id: row.id,
      slug: row.slug,
      // ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1: additive field, computed
      // (never stored) — see core/ids.ts's shortTicketCode.
      handle: shortTicketCode(row.id),
      name: row.name,
      priority: row.priority,
      session: row.session
        ? {
            id: row.session.id,
            actor: row.session.actor,
            harness: row.session.harness,
            started_at: row.session.startedAt,
            age_ms: row.session.ageMs,
            age_human: humanizeAge(row.session.ageMs),
          }
        : null,
    })),
    review: data.review.map((row) => ({
      id: row.id,
      slug: row.slug,
      handle: shortTicketCode(row.id),
      name: row.name,
      mr: row.mr,
      requested_at: row.requestedAt,
      by: row.by,
      age_ms: row.ageMs,
      age_human: humanizeAge(row.ageMs),
      review_stale: row.reviewStale,
    })),
    // handle-t-code-missing-from: stale rows now carry `handle` too, same
    // as in_progress/review above — it used to be left as the raw
    // StaleTicketRow[] (id/slug/name/state only), so tests/acceptance/
    // D4.test.ts and C5.test.ts's `toEqual([{ id, slug, name, state },
    // ...])` pins were updated alongside this to include it.
    stale: data.stale.map((row) => ({
      id: row.id,
      slug: row.slug,
      handle: shortTicketCode(row.id),
      name: row.name,
      state: row.state,
    })),
    problems: data.problems,
    elided: elisions,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// E1: `--budget` — elide whole rows, least-important-last, across the
// three list sections in ONE combined elision-priority order:
// in_progress (most important — active work) > review (awaiting a human)
// > stale (a derived, largely-redundant-with-the-above overlay). Dropping
// from the tail of the combined array therefore drops stale rows first,
// then review, then in_progress — see this file's module doc. `counts`/
// `derived`/`problems` are never elided (small, fixed-size, and the whole
// point of a pulse view).
// ---------------------------------------------------------------------------

type StatusEntry =
  | { kind: "in_progress"; row: InProgressTicketRow }
  | { kind: "review"; row: ReviewTicketRow }
  | { kind: "stale"; row: StaleTicketRow };

function buildStatusEntries(data: StatusData): StatusEntry[] {
  return [
    ...data.inProgress.map((row): StatusEntry => ({ kind: "in_progress", row })),
    ...data.review.map((row): StatusEntry => ({ kind: "review", row })),
    ...data.stale.map((row): StatusEntry => ({ kind: "stale", row })),
  ];
}

function filterStatusData(data: StatusData, kept: readonly StatusEntry[]): StatusData {
  return {
    ...data,
    inProgress: kept
      .filter((e): e is Extract<StatusEntry, { kind: "in_progress" }> => e.kind === "in_progress")
      .map((e) => e.row),
    review: kept
      .filter((e): e is Extract<StatusEntry, { kind: "review" }> => e.kind === "review")
      .map((e) => e.row),
    stale: kept
      .filter((e): e is Extract<StatusEntry, { kind: "stale" }> => e.kind === "stale")
      .map((e) => e.row),
  };
}

export async function runStatus(opts: StatusCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const clock = resolveClock();

  const data = await gatherStatus(paths, clock);
  const generatedAtIso = clock.now().toISOString();
  const format: RenderFormat = opts.json ? "json" : "text";

  const entries = buildStatusEntries(data);
  const rendered = renderEntriesWithBudget(
    entries,
    (kept, elisions) => {
      const filtered = filterStatusData(data, kept);
      return opts.json
        ? buildJson(filtered, generatedAtIso, elisions)
        : buildHuman(filtered, elisions);
    },
    opts.budget,
    { format, noun: "row" },
  );
  process.stdout.write(rendered.text);
}

/** `slop status` — design.md §4.2; work item D4. */
export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description(
      "Project pulse: counts by state, in-progress tickets with sessions, stale " +
        "items, and tickets awaiting review with MR links.",
    )
    .option("--json", "machine-readable output")
    .option(
      "--budget <n>",
      `cap output size to N ${CONTEXT_PACK_BUDGET_UNIT} (elides stale rows, then review rows, then ` +
        "in_progress rows, least-important-first; counts/derived are always kept in full)",
      parseIntegerOption("--budget"),
    )
    .action(runStatus);
}
