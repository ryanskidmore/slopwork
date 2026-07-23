import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop search` — design.md §4.2; work item D2 (SlopQL proper is F6). */
export function registerSearchCommand(program: Command): void {
  program
    .command("search")
    .description("Naive text scan over ticket names, specs, and progress notes.")
    .argument("<text>", "text to search for")
    .action(() => notImplemented("search", "D2"));
}
