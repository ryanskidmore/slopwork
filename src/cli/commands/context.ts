import type { Command } from "commander";
import { EXIT_CODES } from "../../core/index.js";
import { repoPaths, requireRepoRoot, resolveTicketRef } from "../../repo/index.js";
import {
  CONTEXT_PACK_BUDGET_UNIT,
  renderContextPackJsonWithBudget,
  renderContextPackWithBudget,
} from "../../sessions/context-budget.js";
import { buildContextPackData } from "../../sessions/context-pack.js";
import { loadConfig } from "../actor.js";
import { SlopError } from "../errors.js";

interface ContextCommandOptions {
  budget?: number;
  json?: boolean;
}

/** `--budget N` here counts in characters (see context-budget.ts's doc for
 * why this deliberately differs from `show --context --budget`'s rough
 * token estimate) — validated as a non-negative integer, same "usage
 * mistake, reject eagerly" treatment `start.ts`'s `--harness` gets. Throws
 * a {@link SlopError} (USAGE_ERROR, exit 2) — E1's exit-code audit fix
 * (see `shared.ts`'s `parseIntegerOption` doc for why a bare `Error` here
 * would silently exit 1 instead).
 *
 * **Input-validation fix:** `Number.parseInt` silently truncates
 * leading-numeric garbage — `--budget 100abc` used to parse as `100`
 * instead of being rejected. The value's full trimmed text must now match
 * `/^-?\d+$/` (a complete integer, nothing trailing) before it's accepted
 * at all; the existing non-negative bound is unchanged. */
export function parseBudgetFlag(value: string): number {
  const trimmed = value.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!/^-?\d+$/.test(trimmed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new SlopError(
      `--budget must be a non-negative integer (${CONTEXT_PACK_BUDGET_UNIT}), got "${value}"`,
      EXIT_CODES.USAGE_ERROR,
    );
  }
  return parsed;
}

export async function runContext(ref: string, opts: ContextCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);

  // Read-only, start to finish: resolveTicketRef/buildContextPackData never
  // write anything, and nothing here calls a repo-layer mutation function
  // — design.md §4.2 is explicit that `context` is "no state change".
  const ticket = await resolveTicketRef(paths, ref);
  const data = await buildContextPackData(paths, ticket, config);

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
