import type { Command } from "commander";
import { repoPaths, requireRepoRoot, resolveTicketRef } from "../../repo/index.js";
import {
  CONTEXT_PACK_BUDGET_UNIT,
  renderContextPackWithBudget,
} from "../../sessions/context-budget.js";
import { buildContextPackData } from "../../sessions/context-pack.js";
import { loadConfig } from "../actor.js";

interface ContextCommandOptions {
  budget?: number;
}

/** `--budget N` here counts in characters (see context-budget.ts's doc for
 * why this deliberately differs from `show --context --budget`'s rough
 * token estimate) — validated as a non-negative integer, same "usage
 * mistake, reject eagerly" treatment `start.ts`'s `--harness` gets. */
function parseBudgetFlag(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `--budget must be a non-negative integer (${CONTEXT_PACK_BUDGET_UNIT}), got "${value}"`,
    );
  }
  return parsed;
}

async function runContext(ref: string, opts: ContextCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);

  // Read-only, start to finish: resolveTicketRef/buildContextPackData never
  // write anything, and nothing here calls a repo-layer mutation function
  // — design.md §4.2 is explicit that `context` is "no state change".
  const ticket = await resolveTicketRef(paths, ref);
  const data = await buildContextPackData(paths, ticket, config);
  const { text } = renderContextPackWithBudget(data, opts.budget);
  process.stdout.write(`${text}\n`);
}

/** `slop context` — design.md §4.2, §5.2; work item C1. */
export function registerContextCommand(program: Command): void {
  program
    .command("context")
    .description(
      "Reprint <ref>'s context pack (spec, ancestry, blockers, prior sessions) " +
        "mid-session, without changing state.",
    )
    .argument("<ref>", "ticket whose context pack to print")
    .option(
      "--budget <n>",
      `cap the context pack to N ${CONTEXT_PACK_BUDGET_UNIT}, eliding oldest sessions then long ` +
        "spec.details_md before ever hard-truncating (see src/sessions/context-budget.ts)",
      parseBudgetFlag,
    )
    .action(runContext);
}
