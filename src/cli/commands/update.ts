import type { Command } from "commander";
import { repoPaths, requireRepoRoot, resolveTicketRef, updateTicket } from "../../repo/index.js";
import { buildUpdate } from "../../tickets/update.js";
import type { UpdateInput } from "../../tickets/update.js";
import { loadConfig, resolveActor } from "../actor.js";
import { collect, parsePriority, readStdin } from "./shared.js";

interface UpdateCommandOptions {
  progress?: string;
  state?: string;
  priority?: number;
  label: string[];
  name?: string;
  spec?: string;
}

async function runUpdate(ref: string, opts: UpdateCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });

  const current = await resolveTicketRef(paths, ref);

  const specRaw =
    opts.spec === undefined ? undefined : opts.spec === "-" ? await readStdin() : opts.spec;

  const input: UpdateInput = {
    progress: opts.progress,
    state: opts.state,
    priority: opts.priority,
    labelOps: opts.label,
    name: opts.name,
    specRaw,
  };

  const { ticket, patch, verb, payload } = buildUpdate(current, input);

  await updateTicket(paths, current.id, patch, ticket, { actor, session: null }, { verb, payload });

  process.stdout.write(
    `updated ${ticket.id}  (slug: ${ticket.slug})\n` +
      `  ${ticket.name}\n` +
      `  state: ${ticket.state}  priority: ${ticket.priority}\n`,
  );
}

/** `slop update` — design.md §4.2; work item B1.
 *
 * The general mutator: `new`'s sugar flags and the dedicated verb commands
 * (`draft`/`undraft`/`review`/`stop`/`done`/`drop`/`plan --check`, …) are
 * all expressible in terms of `update`.
 */
export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description(
      "General ticket mutator (progress notes, state, priority, labels, name, spec); " +
        "the verb commands are sugar over this.",
    )
    .argument("<ref>", "ticket to update")
    .option("--progress <note>", "append a progress note and bump last_activity_at")
    .option(
      "--state <state>",
      "set stored state directly (draft|open|in_progress|review|done|dropped)",
    )
    .option("--priority <0-3>", "priority: 0 urgent .. 3 low", parsePriority)
    .option(
      "--label <±label>",
      "add (+label) or remove (-label) a label (repeatable)",
      collect,
      [] as string[],
    )
    .option("--name <name>", "rename the ticket")
    .option("--spec <json>", 'replace the ticket spec as JSON; pass "-" to read from stdin')
    .action(runUpdate);
}
