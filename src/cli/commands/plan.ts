import type { Command } from "commander";
import { notImplemented } from "../errors.js";
import { parseIntegerOption } from "./shared.js";

/** `slop plan` — design.md §2, §4.2; work item C2.
 *
 * Either sets/revises the session's step checklist (`slop plan <ref> "step
 * 1" "step 2"`) or checks/unchecks one step (`--check N` / `--uncheck N`).
 */
export function registerPlanCommand(program: Command): void {
  program
    .command("plan")
    .description("Set/revise the active session's plan, or check/uncheck a step.")
    .argument("<ref>", "ticket whose session plan to change")
    .argument("[steps...]", 'plan steps, e.g. "step 1" "step 2"')
    .option("--check <n>", "check off step N", parseIntegerOption("--check"))
    .option("--uncheck <n>", "uncheck step N", parseIntegerOption("--uncheck"))
    .action(() => notImplemented("plan", "C2"));
}
