import type { Command } from "commander";
import { fixedClock, shortTicketCode, systemClock } from "../../core/index.js";
import type { JsoncPatchEntry, Ticket } from "../../core/index.js";
import {
  appendEvent,
  listTickets,
  readTicket,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
  updateTicket,
  withLock,
} from "../../repo/index.js";
import { validateTicketEdges } from "../../tickets/edges.js";
import { recomputeAncestry, resolveParentRef } from "../../tickets/parent.js";
import { buildUpdate, parseBlocksOpText, parseRelatesToOpText } from "../../tickets/update.js";
import type { BlocksOp, RelatesToOp, UpdateInput } from "../../tickets/update.js";
import { loadConfig, resolveActor } from "../actor.js";
import { collect, parsePriority, printWarning, readStdin } from "./shared.js";

interface UpdateCommandOptions {
  progress?: string;
  state?: string;
  priority?: number;
  label: string[];
  name?: string;
  spec?: string;
  summary?: string;
  details?: string;
  acceptance: string[];
  context: string[];
  relatesTo: string[];
  blocks: string[];
  owner?: string;
  parent?: string;
  json?: boolean;
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
    opts.spec !== undefined ||
    opts.summary !== undefined ||
    opts.details !== undefined ||
    opts.acceptance.length > 0 ||
    opts.context.length > 0 ||
    opts.relatesTo.length > 0 ||
    opts.blocks.length > 0 ||
    opts.owner !== undefined ||
    opts.parent !== undefined
  ) {
    return undefined;
  }
  return opts.progress;
}

/**
 * closing-loop-commands-lack-json: `--json` result — a small, stable
 * shape naming exactly the fields the human-readable output already
 * prints, with `handle` added for parity with `new --json`'s own result
 * (E1) — every mutator that reads a ticket back should surface the same
 * short, typeable handle, not just the commands that create one. Field
 * names deliberately match `new`'s JSON keys (`id`/`slug`/`handle`/`name`/
 * `state`/`priority`) rather than inventing a parallel vocabulary.
 * `reparented_descendants` (edit-vi-fallback-hangs-agents) is purely
 * additive — 0 on every call that isn't a `--parent` reparent — so it
 * doesn't disturb this already-documented shape (same "additive, existing
 * consumers only read known keys" reasoning `new --json`'s own `handle`
 * used when it was added).
 */
function printUpdated(
  ticket: Pick<Ticket, "id" | "slug" | "name" | "state" | "priority">,
  json: boolean | undefined,
  reparentedDescendants = 0,
): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          id: ticket.id,
          slug: ticket.slug,
          handle: shortTicketCode(ticket.id),
          name: ticket.name,
          state: ticket.state,
          priority: ticket.priority,
          reparented_descendants: reparentedDescendants,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(
    `updated ${ticket.id}  (slug: ${ticket.slug})\n` +
      `  ${ticket.name}\n` +
      `  state: ${ticket.state}  priority: ${ticket.priority}\n` +
      (reparentedDescendants > 0
        ? `  reparented — root_id/path recomputed for ${reparentedDescendants} descendant(s)\n`
        : ""),
  );
}

export async function runUpdate(ref: string, opts: UpdateCommandOptions): Promise<void> {
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

    printUpdated(initialTicket, opts.json);
    return;
  }

  const specRaw =
    opts.spec === undefined ? undefined : opts.spec === "-" ? await readStdin() : opts.spec;
  const detailsRaw =
    opts.details === undefined
      ? undefined
      : opts.details === "-"
        ? await readStdin()
        : opts.details;

  // edit-vi-fallback-hangs-agents: collected here, printed AFTER the lock
  // below resolves — never before validation succeeds (nags-print-before
  // -validation-review's discipline) — so a malformed `jira:`-shaped
  // `--parent` ref's format-mismatch warning (§8.2 item 5, `new --parent`'s
  // own `resolveParentRef` behavior) never fires ahead of a doomed call
  // that failed for some OTHER reason (e.g. a degree-cap CONFLICT from the
  // same `--blocks` flags).
  const warnings: string[] = [];

  const { ticket, reparentedDescendants } = await withLock(paths.lockFile, async () => {
    const current = await readTicket(paths, initialTicket.id);

    // `--relates-to <±ref>` refs are resolved here, fresh, under the same
    // lock as `current` above — mirroring `new`'s `--blocks` resolution
    // (tickets/new.ts), just relocated to this CLI layer because
    // `tickets/update.ts` is deliberately kept pure/no-I/O (see its top
    // doc). A ref that fails to resolve throws NOT_FOUND/AMBIGUOUS_REF/
    // USAGE_ERROR straight out of `resolveTicketRef`, before `buildUpdate`
    // (and thus any write) ever runs.
    const relatesToOps: RelatesToOp[] = [];
    for (const raw of opts.relatesTo) {
      const { op, ref } = parseRelatesToOpText(raw);
      const target = await resolveTicketRef(paths, ref);
      relatesToOps.push({ op, id: target.id });
    }

    // `--blocks <±ref>` — identical resolution shape, edit-vi-fallback
    // -hangs-agents's extension of the same pattern (see tickets/update.ts's
    // `BlocksOp` doc for the `blocks`-vs-`relates_to` distinction).
    const blocksOps: BlocksOp[] = [];
    for (const raw of opts.blocks) {
      const { op, ref } = parseBlocksOpText(raw);
      const target = await resolveTicketRef(paths, ref);
      blocksOps.push({ op, id: target.id });
    }

    // `--parent <ref>` — resolved the exact same way `new --parent` is
    // (tickets/parent.ts's `resolveParentRef`: a local ref via
    // `resolveTicketRef`, or an external `jira:`-shaped ref accepted as-is
    // with a warn-only format check). `undefined` (never even attempted)
    // when `--parent` was omitted — mirrors `relatesToOps`/`blocksOps`
    // only ever being resolved from what was actually given.
    const parentResolution =
      opts.parent !== undefined ? await resolveParentRef(paths, opts.parent) : undefined;
    if (parentResolution?.kind === "external" && parentResolution.warning) {
      warnings.push(parentResolution.warning);
    }

    const input: UpdateInput = {
      progress: opts.progress,
      state: opts.state,
      priority: opts.priority,
      labelOps: opts.label,
      name: opts.name,
      specRaw,
      summaryRaw: opts.summary,
      detailsRaw,
      acceptance: opts.acceptance,
      context: opts.context,
      relatesToOps,
      blocksOps,
      ownerRaw: opts.owner,
      parentResolution,
    };

    // One clock reading shared by the ticket write AND its event: keeps
    // `deriveEffectiveOverlay` (db-index.ts) a byte-for-byte no-op here
    // when `--progress` rides along with a real field change, since the
    // accompanying event's `at` can then never disagree with the ticket's
    // own `last_activity_at`/`updated_at` it's describing.
    const clock = fixedClock(systemClock.now());
    const built = buildUpdate(current, input, clock);
    let { ticket, patch } = built;
    const { verb, payload } = built;

    // B3: `relates_to`/`blocks`/`parent` are the edge fields `update` can
    // touch (ticket_01KYA3Z9FNZ2FDMDRWNKR9EV7J;
    // edit-vi-fallback-hangs-agents extends this to `blocks`/`parent`) —
    // whenever the patch actually changes any of them, re-run the exact
    // same degree-cap/target-existence/cycle validation `new`'s own edge
    // flags go through (edges.ts's `validateTicketEdges`, the single entry
    // point its own doc says every edge-mutating write path should call)
    // before this ticket is ever persisted. Gated on the patch (not merely
    // "was an edge flag given") so a fully redundant `--relates-to`/
    // `--blocks` (e.g. `+already-present`) with nothing else given — a
    // real, already-handled no-op patch — never pays for a `listTickets`
    // scan it doesn't need. `discovered_from` remains untouched by
    // `update` (never appears in `UPDATE_TOUCHABLE_FIELDS`), so its own
    // slice of `validateTicketEdges`'s checks stays a no-op against this
    // particular write — cheap insurance against an already-inconsistent
    // (e.g. hand-edited) db, not dead code.
    let reparentedDescendants = 0;
    const touchesEdges = patch.some((entry) =>
      (["blocks", "relates_to", "parent"] as const).includes(
        entry.path[0] as "blocks" | "relates_to" | "parent",
      ),
    );
    if (touchesEdges) {
      const others = await listTickets(paths);
      validateTicketEdges(ticket, others);

      // `--parent` changed: `buildUpdate` only ever sets `ticket.parent`
      // itself (it has no `others` to recompute ancestry with — see
      // tickets/update.ts's top doc) — `root_id`/`path` here are still
      // `current`'s stale values. `recomputeAncestry` (parent.ts, same
      // function `edit.ts`'s own reparent path uses) derives the correct
      // ones from the NOW-validated `parent` chain, plus every EXISTING
      // descendant's own `root_id`/`path` that must move with it.
      // `validateTicketEdges` above has already confirmed `parent` is
      // acyclic and (if local) resolves to a real ticket in `others` —
      // `recomputeAncestry`'s own documented precondition.
      if (patch.some((entry) => entry.path[0] === "parent")) {
        const { ticket: reparented, descendants, changed } = recomputeAncestry(ticket, others);
        if (changed) {
          ticket = reparented;
          // `patch` already carries the (correct) new `parent` value from
          // `buildUpdate` above — only `root_id`/`path` need adding on
          // top; patch.ts's own doc: a patch only needs to CONTAIN every
          // changed field, never be perfectly minimal.
          patch = [
            ...patch,
            { path: ["root_id"], value: reparented.root_id },
            { path: ["path"], value: reparented.path },
          ];
          reparentedDescendants = descendants.length;

          // `patch` is guaranteed non-empty here — it already contained a
          // `parent` entry to reach this branch at all, plus the
          // `root_id`/`path` entries just appended above.
          await updateTicket(
            paths,
            current.id,
            patch,
            ticket,
            { actor, session: null },
            { verb, payload },
            clock,
          );

          for (const descendant of descendants) {
            // Fencing contract (lock.ts): re-check between each entity
            // write once more than one write is happening under this
            // acquisition — same discipline edit.ts's own descendant loop
            // follows.
            const descendantPatch: JsoncPatchEntry[] = [
              { path: ["root_id"], value: descendant.root_id },
              { path: ["path"], value: descendant.path },
              { path: ["updated_at"], value: descendant.updated_at },
            ];
            await updateTicket(
              paths,
              descendant.id,
              descendantPatch,
              descendant,
              { actor, session: null },
              {
                verb: "ticket.updated",
                payload: { method: "update", reparent_root: ticket.id },
              },
            );
          }

          return { ticket, reparentedDescendants };
        }
      }
    }

    if (patch.length === 0) {
      // Deferred item: a genuinely no-op update — nothing in
      // UPDATE_TOUCHABLE_FIELDS actually changed (e.g. `--state
      // <same-state>`, `--priority <same>`, a fully redundant `--label`)
      // — has nothing to persist or describe. Early-return with no write
      // and no event, rather than (as before) still taking the lock's
      // write and emitting an empty-payload event for a call that
      // changed nothing.
      return { ticket, reparentedDescendants };
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

    return { ticket, reparentedDescendants };
  });

  for (const w of warnings) printWarning(w);
  printUpdated(ticket, opts.json, reparentedDescendants);
}

/** `slop update` — design.md §4.2; work item B1.
 *
 * The general mutator: `new`'s sugar flags and the dedicated verb commands
 * (`draft`/`undraft`/`review`/`stop`/`done`/`drop`/`plan --check`, …) are
 * all expressible in terms of `update`. Also the non-interactive path for
 * post-creation edge/owner repair (`--parent`/`--blocks`/`--owner`
 * /`--relates-to`) that used to require `slop edit` (edit-vi-fallback
 * -hangs-agents) — `edit`'s `$EDITOR` fallback can hang forever on a
 * non-TTY; these flags never do.
 */
export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description(
      "General ticket mutator (progress notes, state, priority, labels, name, spec, " +
        "relates-to, blocks, owner, parent); the verb commands are sugar over this.",
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
    .option(
      "--spec <json>",
      'replace the ticket spec as JSON; pass "-" to read from stdin. Mutually exclusive with ' +
        "--summary/--details/--acceptance/--context.",
    )
    .option(
      "--summary <text>",
      "replace the spec summary — structured alternative to --spec (leaves the rest of the spec untouched)",
    )
    .option(
      "--details <text>",
      "replace the spec details_md prose — structured alternative to --spec " +
        '(leaves the rest of the spec untouched); pass "-" to read from stdin',
    )
    .option(
      "--acceptance <text>",
      "replace the spec's acceptance[] wholesale — structured alternative to --spec " +
        "(repeatable; leaves the rest of the spec untouched)",
      collect,
      [] as string[],
    )
    .option(
      "--context <text>",
      "replace the spec's context[] wholesale — structured alternative to --spec " +
        "(repeatable; leaves the rest of the spec untouched)",
      collect,
      [] as string[],
    )
    .option(
      "--relates-to <±ref>",
      "add (+ref) or remove (-ref) a relates-to edge — symmetric, informational (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--blocks <±ref>",
      "add (+ref) or remove (-ref) a blocks edge — cycle-checked, same as `new --blocks` (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--owner <actor>",
      "set/replace the owning actor (no supported way to clear via update — hand-edit via `slop edit` for that)",
    )
    .option(
      "--parent <ref>",
      "reparent <ref> under this ticket, or an external ref (e.g. jira:PROJ-123); recomputes " +
        "root_id/path for <ref> AND every existing descendant. No supported way to clear a parent " +
        "via update — hand-edit via `slop edit` for that.",
    )
    .option(
      "--json",
      "machine-readable result (id, slug, handle, name, state, priority, reparented_descendants)",
    )
    .action(runUpdate);
}
