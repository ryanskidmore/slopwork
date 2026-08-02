import type { Command } from "commander";
import { repoPaths, requireRepoRoot } from "../../repo/index.js";
import { openStorage } from "../../storage/index.js";
import {
  CONTEXT_PACK_BUDGET_UNIT,
  renderContextPackJsonWithBudget,
  renderContextPackWithBudget,
} from "../../sessions/context-budget.js";
import { buildContextPackData } from "../../sessions/context-pack.js";
import { loadConfig } from "../actor.js";
import { parseBudgetOption } from "./shared.js";

interface ContextCommandOptions {
  budget?: number;
  json?: boolean;
}

/**
 * `--budget N` here counts in characters, same as every other
 * budget-taking command (`ready`/`search`/`status`/`events`/`show
 * --context` — see core/budget.ts's `BUDGET_UNIT`, the single unit every
 * one of them documents and enforces).
 *
 * budget-flags-units-and-validation: this used to be its own local copy of
 * the negative-rejecting validation (`context` was the ONLY `--budget`
 * command that rejected negatives; every other command's `--budget` used
 * the generic, negative-accepting `parseIntegerOption`, silently degrading
 * to "elide everything" instead). Kept as a thin alias — rather than a
 * bare re-export — of the now-shared `shared.ts#parseBudgetOption` every
 * command uses, purely so this file's own `.option(...)` call site and
 * `context.test.ts`'s existing `parseBudgetFlag` import both keep working
 * unchanged.
 */
export const parseBudgetFlag = parseBudgetOption;

export async function runContext(ref: string, opts: ContextCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const backend = await openStorage(paths);

  // Read-only, start to finish: resolveTicketRef/buildContextPackData never
  // write anything, and nothing here calls a repo-layer mutation function
  // — design.md §4.2 is explicit that `context` is "no state change".
  const ticket = await backend.resolveTicketRef(ref);
  const data = await buildContextPackData(backend, ticket, config);

  if (opts.json) {
    // E1: structured form, budget-aware without ever corrupting JSON — see
    // context-budget.ts's renderContextPackJsonWithBudget /
    // core/budget.ts's module doc for the "never corrupt JSON on a
    // success exit" contract this shares with `ready`/`search`/`events`/
    // `status`/`show --context --json`.
    const { text } = renderContextPackJsonWithBudget(data, opts.budget);
    process.stdout.write(text);
    return;
  }

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
        "spec.details_md before ever hard-truncating (see src/sessions/context-budget.ts); with " +
        "--json, degrades to a minimal-but-always-valid envelope instead of ever corrupting the JSON",
      parseBudgetFlag,
    )
    .option("--json", "machine-readable, structured context pack")
    .action(runContext);
}
