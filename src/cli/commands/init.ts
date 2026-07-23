import type { Command } from "commander";
import { notImplemented } from "../errors.js";

/** `slop init` — design.md §4.2, §5.1; work item D1. */
export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description(
      "Initialize .slop/ in this repo: config.yaml (with repo/jira autodetection), " +
        "db/ directories, AGENTS.md, and gitignore entries.",
    )
    .action(() => notImplemented("init", "D1"));
}
