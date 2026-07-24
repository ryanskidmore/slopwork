import type { Command } from "commander";
import { fixedClock, systemClock } from "../../core/index.js";
import type { Ticket } from "../../core/index.js";
import {
  appendEvent,
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

/**
 * The note, iff `opts` is a PURE progress call — `--progress` and NOTHING
 * else — `undefined` otherwise. ticket_01KY9RWFM80BKNE2CDX85QMKGS: this is
 * the one `update` call shape that goes lock-free below; every other
 * combination (including `--progress` alongside a real field) keeps
 * today's locked read-modify-write path unchanged.
 */
function pureProgressNote(opts: UpdateCommandOptions): string | undefined {
  if (
    opts.progress === undefined ||
    opts.state !== undefined ||
    opts.priority !== undefined ||
    opts.label.length > 0 ||
    opts.name !== undefined ||
    opts.spec !== undefined
  ) {
    return undefined;
  }
  return opts.progress;
}

function printUpdated(ticket: Pick<Ticket, "id" | "slug" | "name" | "state" | "priority">): void {
  process.stdout.write(
    `updated ${ticket.id}  (slug: ${ticket.slug})\n` +
      `  ${ticket.name}\n` +
      `  state: ${ticket.state}  priority: ${ticket.priority}\n`,
  );
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

  // ticket_01KY9RWFM80BKNE2CDX85QMKGS: a pure `--progress` call never
  // reads/writes the ticket file and never takes `paths.lockFile` — it
  // just appends a `ticket.updated` event carrying the note. N agents can
  // do this against the SAME ticket at the same instant with zero write
  // contention: each call mints its own ULID event file, and ULID
  // filenames never collide (entity-file.ts's `createEntityFileCanonical`
  // doc) — nothing here needs mutual exclusion at all.
  // `latest_note`/`last_activity_at` become effective (derived) values,
  // folding this event on top of the ticket's stored baseline at READ
  // time (`src/repo/db-index.ts`'s `deriveEffectiveOverlay`) — `show`/
  // `status`/`ready`/staleness all read the derived value, never the
  // (possibly now-stale) field on the ticket file itself.
  const note = pureProgressNote(opts);
  if (note !== undefined) {
    // Deferred-item early return, progress flavor: identical to the note
    // we already saw for this ticket a moment ago (best-effort — this
    // read predates the call, same as `initialTicket` above always is) —
    // genuinely nothing to record, so append nothing. Mirrors buildUpdate's
    // own same-content no-op rule (tickets/update.ts's UPDATE_CONTENT_FIELDS)
    // for the single-writer case; under real concurrency this is purely an
    // optimization; it never has to be right for correctness; another
    // agent's genuinely different note is unaffected.
    if (note !== initialTicket.latest_note) {
      await appendEvent(
        paths,
        { actor, session: null },
        { kind: "ticket", id: initialTicket.id },
        { verb: "ticket.updated", payload: { progress: note } },
      );
    }

    printUpdated(initialTicket);
    return;
  }

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

    // One clock reading shared by the ticket write AND its event: keeps
    // `deriveEffectiveOverlay` (db-index.ts) a byte-for-byte no-op here
    // when `--progress` rides along with a real field change, since the
    // accompanying event's `at` can then never disagree with the ticket's
    // own `last_activity_at`/`updated_at` it's describing.
    const clock = fixedClock(systemClock.now());
    const { ticket, patch, verb, payload } = buildUpdate(current, input, clock);

    if (patch.length === 0) {
      // Deferred item: a genuinely no-op update — nothing in
      // UPDATE_TOUCHABLE_FIELDS actually changed (e.g. `--state
      // <same-state>`, `--priority <same>`, a fully redundant `--label`)
      // — has nothing to persist or describe. Early-return with no write
      // and no event, rather than (as before) still taking the lock's
      // write and emitting an empty-payload event for a call that
      // changed nothing.
      return ticket;
    }

    await updateTicket(
      paths,
      current.id,
      patch,
      ticket,
      { actor, session: null },
      { verb, payload },
      clock,
    );

    return ticket;
  });

  printUpdated(ticket);
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
