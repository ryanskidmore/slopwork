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
 * ## Reading B4/C5's derived index fields generically
 *
 * `IndexTicketRow.blocked_count`/`stale`/`review_stale` are `<T> | null`
 * until B4/C5 populate them (A3 always writes `null` today). This command
 * never special-cases "those fields don't exist yet" — it maps them
 * straight through to `tickets/status.ts`'s pure aggregation functions,
 * which already treat "every row's field is null" as "not computed" (see
 * that module's doc). The result: the moment B4/C5 land and start writing
 * real values, `status`'s blocked/stale counts and the stale section
 * start showing real data with no change to this file.
 *
 * ## Clock seam
 *
 * Humanised ages are a function of "now". Real usage always uses
 * {@link systemClock}. `SLOP_STATUS_FAKE_NOW`, mirroring `slop web`'s
 * `SLOP_WEB_FAKE_NOW` (see `src/cli/commands/web.ts`, DECISIONS.md's D5
 * entries), pins the clock instead when set to a parseable date —
 * undocumented as a user-facing flag, read only here, and how
 * `tests/acceptance/D4.test.ts` gets deterministic humanised-age strings
 * out of a real spawned `dist/slop status` process.
 *
 * ## `--json` shape
 *
 * ```json
 * {
 *   "generated_at": "<ISO timestamp>",
 *   "counts": { "draft":0, "open":0, "in_progress":0, "review":0, "done":0, "dropped":0, "total":0 },
 *   "derived": { "blocked": number | null, "stale": number | null },
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
 *     { "id", "slug", "name", "mr": string | null, "requested_at", "by", "age_ms", "age_human" }, ...
 *   ],   // sorted longest-waiting-first
 *   "stale": [ { "id", "slug", "name", "state": "in_progress" | "review" }, ... ] | null,
 *   // `stale` is null iff `derived.stale` is null (C5 hasn't landed) —
 *   // never an empty array standing in for "unknown".
 *   "problems": [ { "id", "message" }, ... ]   // session/ticket files this run couldn't read; usually []
 * }
 * ```
 *
 * `--json` is never truncated (see `tickets/status.ts`'s `STATUS_LIST_CAP`
 * doc) — the human view is what stays to "one screen"; `--json` is the
 * full-fidelity agent path.
 */
import type { Command } from "commander";
import type { Clock, Session, SessionId, Ticket, TicketId } from "../../core/index.js";
import { fixedClock, systemClock, TICKET_STATES } from "../../core/index.js";
import type { IndexTicketRow, RepoPaths } from "../../repo/index.js";
import {
  loadIndex,
  readSession,
  readTicket,
  repoPaths,
  requireRepoRoot,
} from "../../repo/index.js";
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

interface StatusCommandOptions {
  json?: boolean;
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

function toStatusRow(row: IndexTicketRow): StatusTicketRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    state: row.state,
    blockedCount: row.blocked_count,
    stale: row.stale,
    reviewStale: row.review_stale,
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
  const nowMs = clock.now().getTime();
  const { index } = await loadIndex(paths, clock);
  const rows = index.tickets;
  const statusRows = rows.map(toStatusRow);

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
  lines.push(
    `  ${"stale".padEnd(LABEL_WIDTH)}  ${
      derived.stale === null ? "—".padStart(5) : String(derived.stale).padStart(5)
    }${derived.stale === null ? "  (not yet computed — C5)" : ""}`,
  );
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
    lines.push(`  ${row.slug.padEnd(30)}  ${row.id}  ${sessionText}`);
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
    lines.push(
      `  ${row.slug.padEnd(30)}  ${row.id}  ${row.mr ?? "(no MR link yet)"}  ${row.by}  ${humanizeAge(row.ageMs)}`,
    );
  }
  if (omitted > 0) lines.push(`  … and ${omitted} more`);
  return lines;
}

function renderStaleSection(
  rows: readonly StaleTicketRow[],
  derivedStale: number | null,
): string[] {
  if (derivedStale === null) {
    return ["Stale: — (not yet computed — C5)"];
  }
  const lines: string[] = [`Stale (${rows.length}):`];
  if (rows.length === 0) {
    lines.push("  (none)");
    return lines;
  }
  const { shown, omitted } = capRows(rows);
  for (const row of shown) {
    lines.push(`  ${row.slug.padEnd(30)}  ${row.id}  ${row.state}`);
  }
  if (omitted > 0) lines.push(`  … and ${omitted} more`);
  return lines;
}

function printHuman(data: StatusData): void {
  if (data.counts.total === 0) {
    process.stdout.write('no tickets yet — `slop new "..."` to create one\n');
    return;
  }

  const lines: string[] = [`Slopworks status — ${data.counts.total} ticket(s)`, ""];
  lines.push(...renderCountsSection(data.counts, data.derived));
  lines.push("");
  lines.push(...renderInProgressSection(data.inProgress));
  lines.push("");
  lines.push(...renderReviewSection(data.review));
  lines.push("");
  lines.push(...renderStaleSection(data.stale, data.derived.stale));

  process.stdout.write(`${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// --json rendering
// ---------------------------------------------------------------------------

function printJson(data: StatusData, generatedAtIso: string): void {
  const body = {
    generated_at: generatedAtIso,
    counts: data.counts,
    derived: data.derived,
    in_progress: data.inProgress.map((row) => ({
      id: row.id,
      slug: row.slug,
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
      name: row.name,
      mr: row.mr,
      requested_at: row.requestedAt,
      by: row.by,
      age_ms: row.ageMs,
      age_human: humanizeAge(row.ageMs),
    })),
    stale: data.derived.stale === null ? null : data.stale,
    problems: data.problems,
  };
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}

async function runStatus(opts: StatusCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const clock = resolveClock();

  const data = await gatherStatus(paths, clock);

  if (opts.json) {
    printJson(data, clock.now().toISOString());
    return;
  }
  printHuman(data);
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
    .action(runStatus);
}
