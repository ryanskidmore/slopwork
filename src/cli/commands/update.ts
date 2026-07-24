import type { Command } from "commander";
import {
  readTicket,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
  updateTicket,
  withLock,
} from "../../repo/index.js";
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

  // A read outside the lock is fine for resolving <ref> -> id (and
  // surfacing NOT_FOUND/AMBIGUOUS_REF quickly on a cold ref); the decisive
  // read-modify-write happens fresh, under the lock, below — same
  // convention as start.ts/stop.ts/done.ts (see start.ts's comment on
  // `initialTicket`) — otherwise a concurrent `start`/`stop`/`done` landing
  // between this read and the write below would be silently reverted by
  // `updateTicket`'s `writeCanonical(expectedAfter)` fallback.
  const initialTicket = await resolveTicketRef(paths, ref);

  const specRaw =
    opts.spec === undefined ? undefined : opts.spec === "-" ? await readStdin() : opts.spec;

  const ticket = await withLock(paths.lockFile, async () => {
    const current = await readTicket(paths, initialTicket.id);

    const input: UpdateInput = {
      progress: opts.progress,
      state: opts.state,
      priority: opts.priority,
      labelOps: opts.label,
      name: opts.name,
      specRaw,
    };

    const { ticket, patch, verb, payload } = buildUpdate(current, input);

    await updateTicket(
      paths,
      current.id,
      patch,
      ticket,
      { actor, session: null },
      { verb, payload },
    );

    return ticket;
  });

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
