import type { Command } from "commander";
import { DEFAULT_PRIORITY } from "../../core/index.js";
import { createTicket, repoPaths, requireRepoRoot, withLock } from "../../repo/index.js";
import { buildNewTicket } from "../../tickets/new.js";
import type { NewTicketInput } from "../../tickets/new.js";
import { loadConfig, resolveActor } from "../actor.js";
import { collect, parsePriority, printWarning, readStdin } from "./shared.js";

interface NewCommandOptions {
  spec?: string;
  parent?: string;
  blocks: string[];
  discoveredFrom?: string;
  label: string[];
  draft?: boolean;
  adhoc?: boolean;
  owner?: string;
  priority?: number;
  json?: boolean;
}

async function runNew(name: string, opts: NewCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });

  const specRaw =
    opts.spec === undefined ? undefined : opts.spec === "-" ? await readStdin() : opts.spec;

  const input: NewTicketInput = {
    name,
    specRaw,
    parentRaw: opts.parent,
    blocksRaw: opts.blocks,
    discoveredFromRaw: opts.discoveredFrom,
    labels: opts.label,
    draft: opts.draft ?? false,
    adhoc: opts.adhoc ?? false,
    ownerRaw: opts.owner,
    priority: opts.priority ?? DEFAULT_PRIORITY,
    actor,
  };

  // The slug-uniqueness check (via the index) and the ticket-file create
  // happen under the same lock so two concurrent `slop new` calls can
  // never race into the same slug (design.md §3's `.lock`, targeted at
  // exactly this kind of multi-step "read then write" transaction).
  const { ticket, warnings } = await withLock(paths.lockFile, async () => {
    const built = await buildNewTicket(paths, input);
    await createTicket(
      paths,
      built.ticket,
      { actor, session: null },
      {
        verb: "ticket.created",
        payload: {
          method: "new",
          state: built.ticket.state,
          adhoc: built.ticket.adhoc,
          parent: built.ticket.parent ?? null,
        },
      },
    );
    return built;
  });

  for (const warning of warnings) printWarning(warning);

  if (opts.json) {
    // E1: small `--json` result for a mutator that creates an entity — the
    // id/slug the next command in an agent's loop needs, not a full ticket
    // dump (that's `slop show <ref> --json`'s job).
    process.stdout.write(
      `${JSON.stringify(
        {
          id: ticket.id,
          slug: ticket.slug,
          name: ticket.name,
          state: ticket.state,
          priority: ticket.priority,
          parent: ticket.parent ?? null,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(
    `created ${ticket.id}  (slug: ${ticket.slug})\n` +
      `  ${ticket.name}\n` +
      `  state: ${ticket.state}  priority: ${ticket.priority}` +
      `${ticket.parent !== undefined ? `  parent: ${ticket.parent}` : ""}\n`,
  );
}

/** `slop new` — design.md §4.2; work item B1. */
export function registerNewCommand(program: Command): void {
  program
    .command("new")
    .description('Create a new ticket, e.g. slop new "Adding new auth provider".')
    .argument("<name>", "short ticket name")
    .option("--spec <json>", 'ticket spec as JSON; pass "-" to read from stdin')
    .option("--parent <ref>", "parent ticket ref, slug, or external ref (e.g. jira:PROJ-123)")
    .option(
      "--blocks <ref>",
      "ref of a ticket this one blocks (repeatable)",
      collect,
      [] as string[],
    )
    .option("--discovered-from <ref>", "ref of the ticket this work was discovered while doing")
    .option("--label <key:value>", "label in key:value form (repeatable)", collect, [] as string[])
    .option("--draft", "create in draft state (drafts never appear in `ready`)")
    .option("--adhoc", "mark as created outside normal planning")
    .option("--owner <actor>", "owning actor (roots require a human owner, D1)")
    .option("--priority <0-3>", "priority: 0 urgent .. 3 low, default 2", parsePriority)
    .option("--json", "machine-readable result (id, slug, name, state, priority, parent)")
    .action(runNew);
}
