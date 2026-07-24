import type { Command } from "commander";
import type { Config, Ticket } from "../../core/index.js";
import { isTicketId, shortTicketCode } from "../../core/index.js";
import {
  deriveEffectiveOverlay,
  listTickets,
  queryEvents,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
} from "../../repo/index.js";
import type { RepoPaths } from "../../repo/index.js";
import {
  CONTEXT_PACK_BUDGET_UNIT,
  renderContextPackJsonWithBudget,
  renderContextPackWithBudget,
} from "../../sessions/context-budget.js";
import { buildContextPackData } from "../../sessions/context-pack.js";
import { formatTicketDetail } from "../../tickets/detail.js";
import { jiraBrowseUrl } from "../../tickets/jira.js";
import type { TreeNode } from "../../tickets/tree.js";
import { buildTree, renderTreeLines } from "../../tickets/tree.js";
import { loadConfig } from "../actor.js";
import { parseIntegerOption } from "./shared.js";

interface ShowCommandOptions {
  context?: boolean;
  tree?: boolean;
  budget?: number;
  json?: boolean;
}

/** The root of `ticket`'s local tree, plus its external parent ref (D1)
 * if the root itself has one — shared by both the text and `--json`
 * `--tree` renderings below. */
async function loadTreeFor(
  paths: RepoPaths,
  ticket: Ticket,
): Promise<{ tree: TreeNode; externalParentRef: string | undefined }> {
  const all = await listTickets(paths);
  const rootTicket = all.find((t) => t.id === ticket.root_id) ?? ticket;
  const tree = buildTree(rootTicket.id, all);
  const externalParentRef =
    rootTicket.parent !== undefined && !isTicketId(rootTicket.parent)
      ? rootTicket.parent
      : undefined;
  return { tree, externalParentRef };
}

async function printTree(paths: RepoPaths, config: Config, ticket: Ticket): Promise<void> {
  const { tree, externalParentRef } = await loadTreeFor(paths, ticket);
  const jiraUrl = externalParentRef !== undefined ? jiraBrowseUrl(config, externalParentRef) : null;
  const lines = renderTreeLines(tree, ticket.id, externalParentRef, jiraUrl);
  process.stdout.write(`${lines.join("\n")}\n`);
}

interface TreeNodeJson {
  id: string;
  slug: string;
  name: string;
  state: string;
  priority: number;
  labels: string[];
  is_target: boolean;
  children: TreeNodeJson[];
}

/**
 * ticket_01KY9RWFM80BKNE2CDX85QMKGS: `latest_note`/`last_activity_at` as
 * `show` should actually display them — effective, not necessarily what's
 * stored verbatim on the ticket file. A lock-free `update --progress`
 * call (`src/cli/commands/update.ts`) never rewrites the ticket file, so
 * the freshest note can live only in its event; this folds every such
 * event for `ticket` on top of its stored baseline, one small per-ticket
 * event read (`queryEvents({ ticket })`, not a full index/event-log scan)
 * — the same combination `src/repo/db-index.ts`'s `buildIndex` does for
 * `status`/`ready`, applied here to the single ticket `show` already
 * resolved. A single-writer ticket (every `--progress` note went through
 * the locked path, or none at all) gets back the exact same ticket:
 * `deriveEffectiveOverlay` is a no-op whenever no event is newer than the
 * ticket's own stored `last_activity_at`.
 */
async function effectiveTicket(paths: RepoPaths, ticket: Ticket): Promise<Ticket> {
  const events = await queryEvents(paths, { ticket: ticket.id });
  const overlay = deriveEffectiveOverlay(ticket, events);
  return { ...ticket, ...overlay };
}

function treeNodeJson(node: TreeNode, targetId: string): TreeNodeJson {
  const { ticket } = node;
  return {
    id: ticket.id,
    slug: ticket.slug,
    name: ticket.name,
    state: ticket.state,
    priority: ticket.priority,
    labels: ticket.labels,
    is_target: ticket.id === targetId,
    children: node.children.map((c) => treeNodeJson(c, targetId)),
  };
}

/**
 * `--json` (E1). Shape:
 * ```json
 * {
 *   "ticket": { ...the full stored Ticket... },
 *   "jira_url": "<url> | null",           // only when ticket.parent is external (jira: ref)
 *   "tree": { "external_parent_ref", "jira_url", "root": <TreeNode> } | undefined,  // iff --tree
 *   "context": { ...ContextPackJsonBody..., "elided": [] } | undefined              // iff --context
 * }
 * ```
 * **`--budget` floor behavior**: budget bounds ONLY the `context`
 * sub-object (same contract as standalone `slop context --json --budget`
 * — reused directly, not re-derived). `ticket`/`tree` are never elided: a
 * single ticket (plus its tree) is the legitimate case design.md/E1's
 * brief calls out where a tiny budget can't be honored without destroying
 * the point of the command — `show` without `--context` returns exactly
 * one ticket's data, which is not a list to elide from. Pass `--context`
 * for budget-bounded output; without it, `--budget` has no effect on
 * `--json`'s ticket/tree fields.
 */
async function runShowJson(
  paths: RepoPaths,
  config: Config,
  ticket: Ticket,
  opts: ShowCommandOptions,
): Promise<void> {
  const jiraUrl =
    ticket.parent !== undefined && !isTicketId(ticket.parent)
      ? jiraBrowseUrl(config, ticket.parent)
      : null;
  // ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1: the short t-<code> handle, derived
  // (never stored — core/ids.ts's shortTicketCode) and added as a
  // top-level key so it's always present regardless of --tree/--context,
  // without touching either of those sub-objects' own budget-bounded
  // shape (E1's `--budget` floor-behavior contract for this command only
  // covers `context`; a stray extra top-level key never risks it).
  const body: Record<string, unknown> = {
    // ticket_01KY9RWFM80BKNE2CDX85QMKGS: effective, not stored-verbatim —
    // see effectiveTicket's doc.
    ticket: await effectiveTicket(paths, ticket),
    handle: shortTicketCode(ticket.id),
    jira_url: jiraUrl,
  };

  if (opts.tree) {
    const { tree, externalParentRef } = await loadTreeFor(paths, ticket);
    const treeJiraUrl =
      externalParentRef !== undefined ? jiraBrowseUrl(config, externalParentRef) : null;
    body.tree = {
      external_parent_ref: externalParentRef ?? null,
      jira_url: treeJiraUrl,
      root: treeNodeJson(tree, ticket.id),
    };
  }

  if (opts.context) {
    const data = await buildContextPackData(paths, ticket, config);
    // Never corrupts JSON at any budget — see core/budget.ts's module doc
    // and context-budget.ts's renderContextPackJsonWithBudget.
    const { body: contextBody } = renderContextPackJsonWithBudget(data, opts.budget);
    body.context = contextBody;
  }

  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}

async function runShow(ref: string, opts: ShowCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);

  const ticket = await resolveTicketRef(paths, ref);

  if (opts.json) {
    await runShowJson(paths, config, ticket, opts);
    return;
  }

  let printedSomething = false;

  if (opts.tree) {
    await printTree(paths, config, ticket);
    printedSomething = true;
  }

  if (opts.context) {
    const data = await buildContextPackData(paths, ticket, config);
    // E1: reconciled onto the same character-counted, smart-eliding
    // budget helper `slop context --budget` uses (previously this used a
    // separate, rougher ~4-chars/token estimate — see
    // sessions/context-budget.ts's module doc for why that was a real,
    // documented inconsistency between the two `--budget` flags).
    const { text } = renderContextPackWithBudget(data, opts.budget);
    process.stdout.write(`${text}\n`);
    printedSomething = true;
  }

  if (!printedSomething) {
    // ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1: surface the t-<code> handle here
    // too — but only on this plain (no --tree/--context) path.
    // formatTicketDetail (tickets/detail.ts) itself is left untouched
    // (detail.test.ts pins its output directly), and --context's own
    // printed text is exactly `renderContextPackWithBudget`'s budgeted
    // output with nothing else around it (E1: `bounded.stdout.length <=
    // budget + 1` — prepending a line here would inflate that past the
    // budget by the line's own length), so this stays out of that path.
    // ticket_01KY9RWFM80BKNE2CDX85QMKGS: formatTicketDetail itself stays
    // untouched (detail.test.ts pins its output directly against whatever
    // Ticket it's handed) — the effective `latest_note`/`last_activity_at`
    // are folded in here, before the call, instead.
    process.stdout.write(
      `handle: ${shortTicketCode(ticket.id)}\n${formatTicketDetail(await effectiveTicket(paths, ticket), config)}\n`,
    );
  }
}

/** `slop show` — design.md §4.2; work item B1. */
export function registerShowCommand(program: Command): void {
  program
    .command("show")
    .description("Show a ticket's details: spec, state, edges, sessions, and history.")
    .argument("<ref>", "ticket to show")
    .option("--context", "include the full context pack")
    .option("--tree", "render the ticket's ancestry/descendant tree")
    .option(
      "--budget <n>",
      `cap --context output to N ${CONTEXT_PACK_BUDGET_UNIT} (has no effect without --context — a ` +
        "single ticket/tree is never elided; see this command's floor-behavior doc)",
      parseIntegerOption("--budget"),
    )
    .option("--json", "machine-readable output (ticket, and --tree/--context when given)")
    .action(runShow);
}
