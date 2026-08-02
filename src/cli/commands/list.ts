/**
 * `slop list` (t-km7mb) — filtered ticket enumeration. The CLI has never
 * had a way to just *browse* tickets by filter (state/label/owner/
 * priority/parent/subtree/free-text) — `ready` is a specific "workable
 * now" query, `search` is ranked text search, `show`/`status` are
 * single-ticket/aggregate views. This closes that gap: everything the
 * read-only web UI's ticket-list filters can express
 * (`src/web/api/tickets.ts`) is expressible here too.
 *
 * The pure filter/sort/paginate logic lives in `src/tickets/list.ts` (unit
 * -tested there); this module gathers tickets (fault-tolerant, same
 * `listTicketsTolerant()` `slop search` already uses — see that module's
 * doc for why full `Ticket`s, not the derived index), resolves `--parent`/
 * `--subtree` refs, and renders text/`--json`/`--budget`.
 *
 * ## `--json` shape
 *
 * ```json
 * {
 *   "tickets": [
 *     { "id", "slug", "handle", "name", "state", "priority", "labels",
 *       "owner", "parent", "root_id", "last_activity_at" }, ...
 *   ],
 *   "total": number,          // matches after filters, BEFORE --limit/--offset
 *   "returned": number,       // tickets.length in THIS response (after paging, before --budget elision)
 *   "offset": number,
 *   "limit": number | null,
 *   "problems": [ { "id", "path", "message" }, ... ],  // ticket files skipped; usually []
 *   "elided": ["<note>", ...]  // only non-empty when --budget forced elision
 * }
 * ```
 */
import type { Command } from "commander";
import {
  EXIT_CODES,
  renderEntriesWithBudget,
  shortTicketCode,
  ticketStateSchema,
} from "../../core/index.js";
import type { Ticket, TicketId, TicketState } from "../../core/index.js";
import { computeAwaitingInputByTicket } from "../../repo/index.js";
import { repoPaths, requireRepoRoot } from "../../repo/index.js";
import { CONTEXT_PACK_BUDGET_UNIT } from "../../sessions/context-budget.js";
import type { TicketReadProblem } from "../../storage/index.js";
import { openStorage } from "../../storage/index.js";
import { filterTickets, paginateTickets } from "../../tickets/list.js";
import { SlopError } from "../errors.js";
import { collect, parseBudgetOption, parseIntegerOption, parsePriority } from "./shared.js";

interface ListCommandOptions {
  state: string[];
  label: string[];
  owner?: string;
  priority?: number;
  parent?: string;
  subtree?: string;
  awaitingInput?: boolean;
  limit?: number;
  offset?: number;
  json?: boolean;
  budget?: number;
}

/** `--limit`/`--offset` share this: a non-negative integer (0 is a legal
 * "return/skip nothing", unlike `search --limit`'s positive-only rule —
 * `list` is enumeration/pagination, not a "top N results" cap). */
function parseNonNegativeInteger(flag: string): (value: string) => number {
  return (value: string): number => {
    const parsed = parseIntegerOption(flag)(value);
    if (parsed < 0) {
      throw new SlopError(
        `${flag} must be a non-negative integer, got "${value}"`,
        EXIT_CODES.USAGE_ERROR,
      );
    }
    return parsed;
  };
}

/** Same per-problem rendering `db-index.ts`'s `formatIndexProblems`/
 * `search.ts`'s `formatSearchProblems` use (path + indented, actionable
 * error message) but with a header accurate to THIS call site. */
function formatListProblems(problems: readonly TicketReadProblem[]): string {
  const header = `${problems.length} ticket file(s) could not be read and were skipped by this listing:`;
  const body = problems.map((p) => {
    const indented = p.message
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    return `  - ${p.path}\n${indented}`;
  });
  return [header, ...body].join("\n");
}

interface ListJsonRow {
  id: string;
  slug: string;
  handle: string;
  name: string;
  state: string;
  priority: number;
  labels: string[];
  owner: Ticket["owner"];
  parent: string | null;
  root_id: string;
  last_activity_at: string;
  /** G4 (t-jggg9): `true` iff this ticket has >=1 unanswered question. */
  awaiting_input: boolean;
}

function toJsonRow(t: Ticket, awaitingInputIds: ReadonlySet<TicketId>): ListJsonRow {
  return {
    id: t.id,
    slug: t.slug,
    handle: shortTicketCode(t.id),
    name: t.name,
    state: t.state,
    priority: t.priority,
    labels: t.labels,
    owner: t.owner,
    parent: t.parent ?? null,
    root_id: t.root_id,
    last_activity_at: t.last_activity_at,
    awaiting_input: awaitingInputIds.has(t.id),
  };
}

function formatRow(t: Ticket, awaitingInputIds: ReadonlySet<TicketId>): string {
  const labels = t.labels.length > 0 ? `  labels: ${t.labels.join(",")}` : "";
  const owner = t.owner ? `  owner: ${t.owner.name} (${t.owner.kind})` : "";
  // G4: badge mirrors the web list's overlay badge treatment — a plain
  // bracketed tag, not a whole extra column, same spirit as `ready.ts`'s
  // `[STALE]` review tag.
  const awaitingInput = awaitingInputIds.has(t.id) ? "  [AWAITING INPUT]" : "";
  return `  [P${t.priority}] ${t.id}  ${t.slug}  (${t.state})  "${t.name}"${labels}${owner}${awaitingInput}`;
}

function buildJson(
  kept: readonly Ticket[],
  total: number,
  offset: number,
  limit: number | undefined,
  problems: readonly TicketReadProblem[],
  elisions: readonly string[],
  awaitingInputIds: ReadonlySet<TicketId>,
): string {
  const body = {
    tickets: kept.map((t) => toJsonRow(t, awaitingInputIds)),
    total,
    returned: kept.length,
    offset,
    limit: limit ?? null,
    problems,
    elided: elisions,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function buildText(
  kept: readonly Ticket[],
  total: number,
  elisions: readonly string[],
  awaitingInputIds: ReadonlySet<TicketId>,
): string {
  const lines: string[] = [`${kept.length} of ${total} matching ticket(s):`];
  for (const t of kept) lines.push(formatRow(t, awaitingInputIds));
  if (elisions.length > 0) {
    lines.push("");
    lines.push(`(--budget, ${CONTEXT_PACK_BUDGET_UNIT}):`);
    for (const note of elisions) lines.push(`  - ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runList(text: string | undefined, opts: ListCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const backend = await openStorage(paths);

  const states: TicketState[] = [];
  for (const raw of opts.state) {
    const parsed = ticketStateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SlopError(
        `--state "${raw}" is not a known state (draft|open|in_progress|review|done|dropped)`,
        EXIT_CODES.USAGE_ERROR,
      );
    }
    states.push(parsed.data);
  }

  // `--parent`/`--subtree` resolve the same way any other `<ref>` does
  // (full id/slug/short prefix/`t-<code>`) — a bad ref throws NOT_FOUND/
  // AMBIGUOUS_REF/USAGE_ERROR straight out of `resolveTicketRef`, before
  // any listing work happens.
  const parentId: TicketId | undefined =
    opts.parent !== undefined ? (await backend.resolveTicketRef(opts.parent)).id : undefined;
  const subtreeId: TicketId | undefined =
    opts.subtree !== undefined ? (await backend.resolveTicketRef(opts.subtree)).id : undefined;

  const [{ tickets, problems }, events] = await Promise.all([
    backend.listTicketsTolerant(),
    // G4 (t-jggg9): a whole-db event read, once, to derive the
    // awaiting_input badge/filter — same "bulk read, not N+1" shape
    // `deriveEffectiveTickets`'s web-side callers already use.
    backend.listEventsTolerant(),
  ]);
  if (problems.length > 0) {
    process.stderr.write(`warning: ${formatListProblems(problems)}\n`);
  }

  const awaitingInputByTicket = computeAwaitingInputByTicket(events);
  const awaitingInputIds = new Set<TicketId>(
    [...awaitingInputByTicket.entries()]
      .filter(([, overlay]) => overlay.awaitingInput)
      .map(([id]) => id),
  );

  const filtered = filterTickets(tickets, {
    states,
    labels: opts.label,
    owner: opts.owner,
    priority: opts.priority,
    parentId,
    subtreeId,
    text,
    awaitingInputIds,
    awaitingInput: opts.awaitingInput,
  });

  const offset = opts.offset ?? 0;
  const { page, total } = paginateTickets(filtered, offset, opts.limit);

  const rendered = renderEntriesWithBudget(
    page,
    (kept, elisions) =>
      opts.json
        ? buildJson(kept, total, offset, opts.limit, problems, elisions, awaitingInputIds)
        : buildText(kept, total, elisions, awaitingInputIds),
    opts.budget,
    { format: opts.json ? "json" : "text", noun: "ticket" },
  );
  process.stdout.write(rendered.text);
}

/** `slop list` — t-km7mb: filtered ticket enumeration, filling the gap
 * between `ready` (a specific "workable now" query) and `search` (ranked
 * text search) — plain browsing/filtering, matching everything the web
 * UI's ticket-list filters already do. */
export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description(
      "Enumerate tickets with filters (state/label/owner/priority/parent/subtree/free-text) — " +
        "everything the web UI's ticket-list filters can express, from the CLI. Deterministic " +
        "sort: state, then priority, then age (oldest first).",
    )
    .argument("[text]", "free-text match against name/slug/spec.summary")
    .option(
      "--state <state>",
      "filter to this state (repeatable; OR — any given state matches; omit for every state, including drafts)",
      collect,
      [] as string[],
    )
    .option(
      "--label <label>",
      "filter to tickets carrying this label (repeatable; AND — every given label must be present)",
      collect,
      [] as string[],
    )
    .option("--owner <name>", "filter to tickets owned by this exact actor name")
    .option("--priority <0-3>", "filter to tickets at exactly this priority", parsePriority)
    .option("--parent <ref>", "filter to DIRECT children of this ticket")
    .option(
      "--subtree <ref>",
      "filter to the whole descendant tree rooted at this ticket, inclusive of the ticket itself",
    )
    .option(
      "--awaiting-input",
      "filter to tickets with an unanswered question (G4) — every row still carries an " +
        "awaiting_input badge/field regardless of this flag",
    )
    .option(
      "--limit <n>",
      "cap the number of tickets returned (after filtering/sorting)",
      parseNonNegativeInteger("--limit"),
    )
    .option(
      "--offset <n>",
      "skip this many matching tickets before applying --limit",
      parseNonNegativeInteger("--offset"),
    )
    .option("--json", "machine-readable output")
    .option(
      "--budget <n>",
      `cap output size to N ${CONTEXT_PACK_BUDGET_UNIT} (elides lowest-priority/least-relevant tickets first)`,
      parseBudgetOption,
    )
    .action(runList);
}
