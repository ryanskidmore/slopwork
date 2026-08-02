import type { Command } from "commander";
import { DEFAULT_PRIORITY, shortTicketCode } from "../../core/index.js";
import { repoPaths, requireRepoRoot } from "../../repo/index.js";
import { openStorage } from "../../storage/index.js";
import { buildNewTicket } from "../../tickets/new.js";
import type { NewTicketInput } from "../../tickets/new.js";
import { loadConfig, resolveActor } from "../actor.js";
import { collect, parsePriority, printWarning, readStdin } from "./shared.js";

interface NewCommandOptions {
  spec?: string;
  summary?: string;
  details?: string;
  acceptance: string[];
  context: string[];
  parent?: string;
  blocks: string[];
  relatesTo: string[];
  discoveredFrom?: string;
  label: string[];
  draft?: boolean;
  adhoc?: boolean;
  owner?: string;
  priority?: number;
  slug?: string;
  json?: boolean;
}

export async function runNew(name: string, opts: NewCommandOptions): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });
  const backend = await openStorage(paths);

  const specRaw =
    opts.spec === undefined ? undefined : opts.spec === "-" ? await readStdin() : opts.spec;
  const detailsRaw =
    opts.details === undefined
      ? undefined
      : opts.details === "-"
        ? await readStdin()
        : opts.details;

  const input: NewTicketInput = {
    name,
    specRaw,
    summaryRaw: opts.summary,
    detailsRaw,
    acceptance: opts.acceptance,
    context: opts.context,
    parentRaw: opts.parent,
    blocksRaw: opts.blocks,
    relatesToRaw: opts.relatesTo,
    discoveredFromRaw: opts.discoveredFrom,
    labels: opts.label,
    draft: opts.draft ?? false,
    adhoc: opts.adhoc ?? false,
    ownerRaw: opts.owner,
    priority: opts.priority ?? DEFAULT_PRIORITY,
    actor,
    slugRaw: opts.slug,
  };

  // The slug-uniqueness check (via the index) and the ticket-file create
  // happen under the same lock so two concurrent `slop new` calls can
  // never race into the same slug (design.md §3's `.lock`, targeted at
  // exactly this kind of multi-step "read then write" transaction).
  const { ticket, warnings } = await backend.transact(async () => {
    const built = await buildNewTicket(backend, input);
    await backend.createTicket(
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

  // Short, stable, typeable handle (ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1) —
  // derived from the id, not stored (core/ids.ts's shortTicketCode), so
  // there's nothing new on `ticket` to read here; just compute it.
  const handle = shortTicketCode(ticket.id);

  if (opts.json) {
    // E1: small `--json` result for a mutator that creates an entity — the
    // id/slug the next command in an agent's loop needs, not a full ticket
    // dump (that's `slop show <ref> --json`'s job). `handle` is additive
    // (E1's existing consumers only read specific known keys), so this
    // doesn't disturb the documented shape.
    process.stdout.write(
      `${JSON.stringify(
        {
          id: ticket.id,
          slug: ticket.slug,
          handle,
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

  // The `created <id>  (slug: <slug>)` first line is a stable, widely
  // depended-on contract — many other commands' own tests bootstrap a
  // ticket via this CLI and parse that EXACT line with a regex (see e.g.
  // draft.test.ts/undraft.test.ts/update.test.ts's own `CREATED_LINE`).
  // The handle is therefore surfaced on its own line right after it,
  // never folded into that line's parentheses.
  process.stdout.write(
    `created ${ticket.id}  (slug: ${ticket.slug})\n` +
      `  handle: ${handle}\n` +
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
    .option(
      "--spec <json>",
      'ticket spec as JSON; pass "-" to read from stdin. Mutually exclusive with ' +
        "--summary/--details/--acceptance/--context.",
    )
    .option(
      "--summary <text>",
      "spec summary — structured alternative to --spec (default: the ticket name)",
    )
    .option(
      "--details <text>",
      'spec details_md prose — structured alternative to --spec; pass "-" to read from stdin',
    )
    .option(
      "--acceptance <text>",
      "an acceptance criterion — structured alternative to --spec (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--context <text>",
      "a context note/file/URL pointer — structured alternative to --spec (repeatable)",
      collect,
      [] as string[],
    )
    .option("--parent <ref>", "parent ticket ref, slug, or external ref (e.g. jira:PROJ-123)")
    .option(
      "--blocks <ref>",
      "ref of a ticket this one blocks (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--relates-to <ref>",
      "ref of a ticket this one relates to — symmetric, informational (repeatable)",
      collect,
      [] as string[],
    )
    .option("--discovered-from <ref>", "ref of the ticket this work was discovered while doing")
    .option(
      "--label <key:value>",
      "label in key:value form (repeatable); no leading +/- — that's update's ±label syntax",
      collect,
      [] as string[],
    )
    .option("--draft", "create in draft state (drafts never appear in `ready`)")
    .option("--adhoc", "mark as created outside normal planning")
    // docs-exit-3-documented-as: this used to say "(roots require a human
    // owner, D1)" — D1 is design.md's POLICY that root tickets should have
    // a human owner, but enforcing it is a separate, not-yet-built work
    // item (design.md §6, F4 "Root ownership enforcement"). Nothing today
    // rejects `slop new` for a root ticket with no `--owner` (owner is a
    // plain nullable field, core/entities/ticket.ts), so the old text
    // claimed a requirement the CLI doesn't actually enforce.
    .option("--owner <actor>", "owning actor for this ticket (optional; defaults to unowned)")
    .option("--priority <0-3>", "priority: 0 urgent .. 3 low, default 2", parsePriority)
    .option(
      "--slug <slug>",
      'short, branch-style handle (e.g. "fix/ui-not-showing"); ' +
        "auto-generated from the name when omitted",
    )
    .option("--json", "machine-readable result (id, slug, name, state, priority, parent)")
    .action(runNew);
}
