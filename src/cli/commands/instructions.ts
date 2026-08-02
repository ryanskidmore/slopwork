/**
 * `slop instructions` — design.md §4.2, §5.1; work item D1.
 *
 * Prints this project's local onboarding rules to stdout: the same
 * canonical content (src/cli/onboarding/) rendered into `.slop/AGENTS.md`
 * by `slop init`, with `config.yaml`'s `project`/`remotes.jira`
 * interpolated fresh from disk every time this is run (so it never goes
 * stale relative to a hand-edited config.yaml the way a committed file
 * could).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { configSchema, parseConfigYamlText } from "../../core/index.js";
import { repoPaths, requireRepoRoot } from "../../repo/index.js";
import { renderInstructions } from "../onboarding/render.js";
import { SlopError } from "../errors.js";

export async function runInstructions(): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const configPath = join(paths.slopDir, "config.yaml");

  const text = await readFile(configPath, "utf8").catch((err) => {
    throw new SlopError(
      `could not read .slop/config.yaml (${(err as Error).message}) — run \`slop init\`.`,
    );
  });

  let raw: unknown;
  try {
    raw = parseConfigYamlText(text);
  } catch (err) {
    throw new SlopError(`.slop/config.yaml could not be parsed: ${(err as Error).message}`);
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new SlopError(
      `.slop/config.yaml does not match the expected shape: ` +
        result.error.issues.map((i) => i.message).join("; "),
    );
  }
  const config = result.data;

  process.stdout.write(
    renderInstructions({ project: config.project, jiraUrl: config.remotes.jira || undefined }),
  );
}

/** `slop instructions` — design.md §4.2, §5.1; work item D1. */
export function registerInstructionsCommand(program: Command): void {
  program
    .command("instructions")
    .description(
      "Print this project's agent onboarding rules: the ready -> start -> plan -> " +
        "update --progress -> review --mr -> done loop, and house rules.",
    )
    .action(async () => {
      await runInstructions();
    });
}
