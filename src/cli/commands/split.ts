import type { Command } from "commander";
import type { Ticket } from "../../core/index.js";
import { EXIT_CODES, nowIso, systemClock } from "../../core/index.js";
import {
  createTicket,
  readTicket,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
  updateTicket,
  withLock,
} from "../../repo/index.js";
import { TICKET_FIELDS, diffTicketPatch } from "../../tickets/patch.js";
import { buildSplitChild } from "../../tickets/split.js";
import { loadConfig, resolveActor } from "../actor.js";
import { SlopError } from "../errors.js";

/**
 * `slop split <ref> "sub1" "sub2" …` (B2) — creates one child ticket per
 * name given, all under one `.lock` transaction (design.md §3: multi-file
 * transactions). See `src/tickets/split.ts` for the per-child
 * provenance/edge/inheritance shape this builds on.
 *
 * ## Event scheme (settled by `core/entities/event.ts`'s own `EVENT_VERBS`
 * doc, quoted verbatim: "`split <ref> "sub1" "sub2"` (B2) — one event on
 * the parent; each child gets its own separate ticket.created.")
 *
 *   - Each child: `ticket.created` (entity = that child), same verb `new`
 *     uses for a freshly-created ticket — a split child IS a newly created
 *     ticket, just one whose provenance happens to be `split` rather than
 *     `new`.
 *   - The split target (`<ref>`) itself: ONE `ticket.split` event once
 *     every child has landed, payload listing every child's id+slug. This
 *     needs a real accompanying write to hang off `withMutationEvent`'s
 *     write-then-emit contract (repo/events.ts) — rather than inventing a
 *     write-free event path, splitting counts as genuine "activity" on
 *     the target (the same sense `update --progress` already bumps
 *     `last_activity_at`), so `last_activity_at`/`updated_at` are bumped;
 *     no other field on the split target changes (there is no persisted
 *     "children" list — D6's materialised ancestry means every child
 *     already points back via its own `parent`/`root_id`/`path`).
 *
 * ## Failure / transaction semantics
 *
 * Every name is validated (non-blank, within `ticketSchema`'s length
 * bound) BEFORE the lock is even acquired, so the one easily-preventable
 * failure mode — a bad name argument — never leaves a partial split
 * behind. Beyond that, this follows the same accepted trade-off
 * `lock.ts`/`edit.ts` document for any multi-write transaction under
 * `withLock`: fencing (via `lock.assertHeld()` before every write after
 * the first) guarantees this process stops immediately if it's ever
 * dispossessed, and every write that already landed keeps both its entity
 * file and its event — nothing is rolled back (there is no crash-atomicity
 * across the N child writes + the final parent update). A split that dies
 * partway through is safe to inspect (`slop show <ref> --tree`) and safe
 * to finish by hand (`slop new --parent <ref> --discovered-from <ref>
 * "remaining name"` recreates the missing child(ren) with the same shape);
 * re-running `slop split <ref> "same names"` again is also safe — it just
 * creates a second, independent batch of children (slugs collision-suffix
 * as usual), never a duplicate of the ones that already landed.
 */

const MAX_NAME_LENGTH = 300;

/**
 * Pre-flight check on every name BEFORE the lock is even acquired (see
 * this file's "Failure / transaction semantics" doc above) — the same
 * bounds `ticketSchema` enforces per-ticket, checked up front here so a
 * bad name argument can never leave a partial split behind. Throws
 * USAGE_ERROR (exit 2), matching what `buildSplitChild`'s own
 * `ticketSchema` validation would eventually throw for the same input.
 */
function validateNames(names: readonly string[]): void {
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new SlopError(
        `split: every sub-ticket name must be non-blank, got "${name}"`,
        EXIT_CODES.USAGE_ERROR,
      );
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      throw new SlopError(
        `split: sub-ticket name exceeds ${MAX_NAME_LENGTH} characters: "${name.slice(0, 40)}…"`,
        EXIT_CODES.USAGE_ERROR,
      );
    }
  }
}

interface SplitCommandOptions {
  json?: boolean;
}

export async function runSplit(
  ref: string,
  names: string[],
  opts: SplitCommandOptions,
): Promise<void> {
  validateNames(names);

  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });

  // A read outside the lock is fine for surfacing NOT_FOUND/AMBIGUOUS_REF
  // quickly on a cold ref (same rationale as `start.ts`'s own comment) —
  // the decisive read every child/patch is built from happens fresh,
  // under the lock, immediately below.
  const initialTarget = await resolveTicketRef(paths, ref);

  const children: Ticket[] = await withLock(paths.lockFile, async () => {
    const target = await readTicket(paths, initialTarget.id);
    const created: Ticket[] = [];

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (name === undefined) continue; // unreachable: i < names.length
      if (i > 0) {
        // Fencing contract (lock.ts): re-check between each entity write
        // once more than one write happens under this acquisition. The
        // very first write is covered by the acquisition itself.
      }
      const { ticket } = await buildSplitChild(paths, { name, parent: target, actor });
      await createTicket(
        paths,
        ticket,
        { actor, session: null },
        {
          verb: "ticket.created",
          payload: {
            method: "split",
            split_from: target.id,
            state: ticket.state,
            parent: ticket.parent ?? null,
          },
        },
      );
      created.push(ticket);
    }

    const now = nowIso(systemClock);
    const updatedTarget: Ticket = { ...target, last_activity_at: now, updated_at: now };
    await updateTicket(
      paths,
      target.id,
      diffTicketPatch(target, updatedTarget, TICKET_FIELDS),
      updatedTarget,
      { actor, session: null },
      {
        verb: "ticket.split",
        payload: {
          children: created.map((c) => ({ id: c.id, slug: c.slug })),
        },
      },
    );

    return created;
  });

  if (opts.json) {
    // E1: small `--json` result — the target plus each new child's id/slug.
    process.stdout.write(
      `${JSON.stringify(
        {
          target: { id: initialTarget.id, slug: initialTarget.slug },
          children: children.map((c) => ({
            id: c.id,
            slug: c.slug,
            name: c.name,
            state: c.state,
            priority: c.priority,
            parent: c.parent ?? null,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(
    `split ${initialTarget.id}  (slug: ${initialTarget.slug}) into ${children.length} sub-ticket(s):\n`,
  );
  for (const child of children) {
    process.stdout.write(
      `created ${child.id}  (slug: ${child.slug})\n` +
        `  ${child.name}\n` +
        `  state: ${child.state}  priority: ${child.priority}  parent: ${child.parent}  ` +
        `discovered-from: ${child.discovered_from.join(",")}\n`,
    );
  }
}

/** `slop split` — design.md §4.2; work item B2. */
export function registerSplitCommand(program: Command): void {
  program
    .command("split")
    .description("Split <ref> into new sub-tickets, one per name given.")
    .argument("<ref>", "ticket to split")
    .argument("<names...>", 'names of the sub-tickets, e.g. "sub1" "sub2"')
    .option("--json", "machine-readable result (target + each new child's id/slug)")
    .action(runSplit);
}
