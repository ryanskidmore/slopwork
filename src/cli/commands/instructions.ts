import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop instructions` — design.md §4.2, §5.1; work item D1. */
export function registerInstructionsCommand(program: Command): void {
  program
    .command("instructions")
    .description(
      "Print this project's agent onboarding rules: the ready -> start -> plan -> " +
        "update --progress -> review --mr -> done loop, and house rules.",
    )
    .action(() => notImplemented("instructions", "D1"));
}
