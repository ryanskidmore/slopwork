import type { Command } from "commander";
import type { Actor } from "../../core/index.js";
import {
  EXIT_CODES,
  fixedClock,
  shortTicketCode,
  systemClock,
  ticketEventContext,
} from "../../core/index.js";
import type { JsoncPatchEntry, Ticket } from "../../core/index.js";
import type { StorageBackend } from "../../core/storage-contract.js";
import { repoPaths, requireRepoRoot } from "../../repo/index.js";
import { openStorage } from "../../storage/index.js";
import { validateTicketEdges } from "../../tickets/edges.js";
import { parseParentRef, recomputeAncestry } from "../../tickets/parent.js";
import type { ParentResolution } from "../../tickets/parent.js";
import {
  buildUpdate,
  parseBlocksOpText,
  parseDiscoveredFromOpText,
  parseRelatesToOpText,
} from "../../tickets/update.js";
import type { BlocksOp, DiscoveredFromOp, RelatesToOp, UpdateInput } from "../../tickets/update.js";
import { loadConfig, resolveActor } from "../actor.js";
import { SlopError } from "../errors.js";
import {
  type BulkOutcome,
  collect,
  parsePriority,
  printWarning,
  readStdin,
  resolveBulkRefs,
  runSingleOrBulk,
} from "./shared.js";

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
  discoveredFrom: string[];
  owner?: string;
  clearOwner?: boolean;
  parent?: string;
  clearParent?: boolean;
  json?: boolean;
}

/**
 * The note, iff `opts` is a PURE progress call — `--progress` and NOTHING
 * else — `undefined` otherwise. ticket_01KY9RWFM80BKNE2CDX85QMKGS: this is
 * the one `update` call shape that goes lock-free below; every other
 * combination (including `--progress` alongside a real field) keeps
 * today's locked read-modify-write path unchanged. t-9uvbr extends the
 * disqualifying list with the new `--discovered-from`/`--clear-owner`/
 * `--clear-parent` flags — each is a real field change, same as
 * `--owner`/`--parent` already were.
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
    opts.discoveredFrom.length > 0 ||
    opts.owner !== undefined ||
    opts.clearOwner === true ||
    opts.parent !== undefined ||
    opts.clearParent === true
  ) {
    return undefined;
  }
  return opts.progress;
}

/** One ref's update outcome — what {@link updateOneRef} returns, shared by
 * both the single-ref and bulk (t-mmngo) rendering paths below. */
interface UpdateOneResult {
  ticket: Ticket;
  reparentedDescendants: number;
  /** Non-fatal notices (e.g. a malformed `jira:`-shaped `--parent` ref's
   * format warning) — printed by the caller AFTER this ref's own
   * transaction commits, same convention every other soft warning in this
   * codebase follows. */
  warnings: string[];
}

/**
 * closing-loop-commands-lack-json: the `--json` result shape for ONE ref —
 * a small, stable shape naming exactly the fields the human-readable
 * output already prints, with `handle` added for parity with `new
 * --json`'s own result (E1) — every mutator that reads a ticket back
 * should surface the same short, typeable handle, not just the commands
 * that create one. Field names deliberately match `new`'s JSON keys
 * (`id`/`slug`/`handle`/`name`/`state`/`priority`) rather than inventing a
 * parallel vocabulary. `reparented_descendants` (edit-vi-fallback-hangs
 * -agents) is purely additive — 0 on every call that isn't a `--parent`/
 * `--clear-parent` reparent. Reused verbatim (t-mmngo) as the `result`
 * field of each successful row in bulk `--json`'s `results[]` — a bulk
 * caller reading one row's `result` sees exactly what a single-ref
 * `update --json` would have printed for that ref alone.
 */
function updateJsonBody(
  ticket: Pick<Ticket, "id" | "slug" | "name" | "state" | "priority">,
  reparentedDescendants: number,
): {
  id: string;
  slug: string;
  handle: string;
  name: string;
  state: string;
  priority: number;
  reparented_descendants: number;
} {
  return {
    id: ticket.id,
    slug: ticket.slug,
    handle: shortTicketCode(ticket.id),
    name: ticket.name,
    state: ticket.state,
    priority: ticket.priority,
    reparented_descendants: reparentedDescendants,
  };
}

function printUpdated(result: UpdateOneResult, json: boolean | undefined): void {
  for (const w of result.warnings) printWarning(w);
  const { ticket, reparentedDescendants } = result;
  if (json) {
    process.stdout.write(
      `${JSON.stringify(updateJsonBody(ticket, reparentedDescendants), null, 2)}\n`,
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

/**
 * t-mmngo: bulk (`refs.length > 1`) rendering — one line of text per ref
 * (this ticket's brief, verbatim), or a `results[]` envelope for `--json`.
 * A failing ref's TEXT line goes to STDERR (never stdout — the "errors
 * never on stdout" discipline docs/cli-reference.md documents for `--json`
 * extended here to text mode too, so stdout only ever carries real
 * results); its `--json` entry still lives in the ONE `results[]` array on
 * stdout, since that's the whole point of a structured per-ref outcome —
 * embedding a `{ok: false, error}` row inside an otherwise-valid JSON
 * document is not the same thing as printing a bare error to stdout.
 */
function renderBulkUpdate(
  outcomes: readonly BulkOutcome<UpdateOneResult>[],
  json: boolean | undefined,
): void {
  for (const outcome of outcomes) {
    if (outcome.ok && outcome.data) {
      for (const w of outcome.data.warnings) printWarning(w);
    }
  }

  if (json) {
    const results = outcomes.map((outcome) =>
      outcome.ok && outcome.data
        ? {
            ref: outcome.ref,
            ok: true,
            exit_code: outcome.exitCode,
            result: updateJsonBody(outcome.data.ticket, outcome.data.reparentedDescendants),
          }
        : { ref: outcome.ref, ok: false, exit_code: outcome.exitCode, error: outcome.error },
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          results,
          ok: outcomes.every((o) => o.ok),
          succeeded: outcomes.filter((o) => o.ok).length,
          failed: outcomes.filter((o) => !o.ok).length,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  for (const outcome of outcomes) {
    if (outcome.ok && outcome.data) {
      const { ticket, reparentedDescendants } = outcome.data;
      process.stdout.write(
        `${outcome.ref} -> updated ${ticket.id} (${ticket.slug})  state: ${ticket.state}  ` +
          `priority: ${ticket.priority}` +
          (reparentedDescendants > 0
            ? `  reparented: ${reparentedDescendants} descendant(s)`
            : "") +
          "\n",
      );
    } else {
      process.stderr.write(`error: ${outcome.ref}: ${outcome.error} (exit ${outcome.exitCode})\n`);
    }
  }
}

/** Everything one `update` call needs to touch <ref> — resolved once per
 * ref, sharing the flags/config/actor/backend/stdin-read-once values the
 * caller (t-mmngo's bulk driver, or the single-ref path) already gathered. */
async function updateOneRef(
  backend: StorageBackend,
  actor: Actor,
  specRaw: string | undefined,
  detailsRaw: string | undefined,
  opts: UpdateCommandOptions,
  ref: string,
): Promise<UpdateOneResult> {
  // A read outside the lock is fine for resolving <ref> -> id (and
  // surfacing NOT_FOUND/AMBIGUOUS_REF quickly on a cold ref); the decisive
  // read-modify-write happens fresh, under the lock, below — same
  // convention as start.ts/stop.ts/done.ts (see start.ts's comment on
  // `initialTicket`) — otherwise a concurrent `start`/`stop`/`done` landing
  // between this read and the write below would be silently reverted by
  // `updateTicket`'s `writeCanonical(expectedAfter)` fallback.
  const initialTicket = await backend.resolveTicketRef(ref);

  // ticket_01KY9RWFM80BKNE2CDX85QMKGS: a pure `--progress` call never
  // reads/writes the ticket file and never takes `paths.lockFile` — it
  // just appends a `ticket.updated` event carrying the note. N agents can
  // do this against the SAME ticket at the same instant with zero write
  // contention: each call mints its own ULID event file, and ULID
  // filenames never collide (entity-file.ts's `createEntityFileCanonical`
  // doc) — nothing here needs mutual exclusion at all.
  const note = pureProgressNote(opts);
  if (note !== undefined) {
    if (note !== initialTicket.latest_note) {
      await backend.appendEvent(
        ticketEventContext(actor, initialTicket),
        { kind: "ticket", id: initialTicket.id },
        { verb: "ticket.updated", payload: { progress: note } },
      );
    }
    return { ticket: initialTicket, reparentedDescendants: 0, warnings: [] };
  }

  // edit-vi-fallback-hangs-agents: collected here, printed AFTER the lock
  // below resolves — never before validation succeeds (nags-print-before
  // -validation-review's discipline) — so a malformed `jira:`-shaped
  // `--parent` ref's format-mismatch warning (§8.2 item 5, `new --parent`'s
  // own `resolveParentRef` behavior) never fires ahead of a doomed call
  // that failed for some OTHER reason (e.g. a degree-cap CONFLICT from the
  // same `--blocks` flags).
  const warnings: string[] = [];

  const { ticket, reparentedDescendants } = await backend.transact(async () => {
    const current = await backend.readTicket(initialTicket.id);

    // Parse in the same flag-group order the previous per-ref loops used,
    // then resolve every local target against one index snapshot. The
    // backend preserves input order and throws the first resolution failure,
    // while the surrounding transaction keeps this batch fresh relative to
    // the decisive read and write.
    const parsedRelatesTo: ReturnType<typeof parseRelatesToOpText>[] = [];
    const parsedBlocks: ReturnType<typeof parseBlocksOpText>[] = [];
    const parsedDiscoveredFrom: ReturnType<typeof parseDiscoveredFromOpText>[] = [];
    const targetRefs: string[] = [];
    let parseFailure: unknown;

    // Preserve the old loop's failure precedence when a later flag is
    // malformed: refs parsed before that flag still resolve first, so an
    // earlier NOT_FOUND/AMBIGUOUS_REF continues to win over the later usage
    // error. Fully valid input takes the single batch path below.
    parseFlags: {
      for (const raw of opts.relatesTo) {
        try {
          const parsed = parseRelatesToOpText(raw);
          parsedRelatesTo.push(parsed);
          targetRefs.push(parsed.ref);
        } catch (err) {
          parseFailure = err;
          break parseFlags;
        }
      }
      for (const raw of opts.blocks) {
        try {
          const parsed = parseBlocksOpText(raw);
          parsedBlocks.push(parsed);
          targetRefs.push(parsed.ref);
        } catch (err) {
          parseFailure = err;
          break parseFlags;
        }
      }
      for (const raw of opts.discoveredFrom) {
        try {
          const parsed = parseDiscoveredFromOpText(raw);
          parsedDiscoveredFrom.push(parsed);
          targetRefs.push(parsed.ref);
        } catch (err) {
          parseFailure = err;
          break parseFlags;
        }
      }
    }
    if (parseFailure !== undefined) {
      if (targetRefs.length > 0) await backend.resolveTicketRefs(targetRefs);
      throw parseFailure;
    }

    const parsedParent = opts.parent === undefined ? undefined : parseParentRef(opts.parent);
    if (parsedParent?.kind === "local") targetRefs.push(parsedParent.ref);
    const resolvedTargets =
      targetRefs.length > 0 ? await backend.resolveTicketRefs(targetRefs) : [];
    let resolvedIndex = 0;

    const relatesToOps: RelatesToOp[] = parsedRelatesTo.map(({ op }) => ({
      op,
      id: resolvedTargets[resolvedIndex++]!.id,
    }));
    const blocksOps: BlocksOp[] = parsedBlocks.map(({ op }) => ({
      op,
      id: resolvedTargets[resolvedIndex++]!.id,
    }));
    const discoveredFromOps: DiscoveredFromOp[] = parsedDiscoveredFrom.map(({ op }) => ({
      op,
      id: resolvedTargets[resolvedIndex++]!.id,
    }));

    const parentResolution: ParentResolution | undefined =
      opts.clearParent === true
        ? { kind: "none" }
        : parsedParent?.kind === "local"
          ? { kind: "local", ticket: resolvedTargets[resolvedIndex++]! }
          : parsedParent;
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
      discoveredFromOps,
      ownerRaw: opts.owner,
      clearOwner: opts.clearOwner,
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

    // B3: `relates_to`/`blocks`/`discovered_from`/`parent` are the edge
    // fields `update` can touch (ticket_01KYA3Z9FNZ2FDMDRWNKR9EV7J;
    // edit-vi-fallback-hangs-agents extends this to `blocks`/`parent`;
    // t-9uvbr extends it again to `discovered_from`) — whenever the patch
    // actually changes any of them, re-run the exact same degree-cap/
    // target-existence/cycle validation `new`'s own edge flags go through
    // (edges.ts's `validateTicketEdges`, the single entry point its own
    // doc says every edge-mutating write path should call) before this
    // ticket is ever persisted. Gated on the patch (not merely "was an
    // edge flag given") so a fully redundant `--relates-to`/`--blocks`/
    // `--discovered-from` (e.g. `+already-present`) with nothing else
    // given — a real, already-handled no-op patch — never pays for a
    // `listTickets` scan it doesn't need.
    let reparentedDescendants = 0;
    const touchesEdges = patch.some((entry) =>
      (["blocks", "relates_to", "discovered_from", "parent"] as const).includes(
        entry.path[0] as "blocks" | "relates_to" | "discovered_from" | "parent",
      ),
    );
    if (touchesEdges) {
      const others = await backend.listTickets();
      validateTicketEdges(ticket, others);

      // `--parent`/`--clear-parent` changed: `buildUpdate` only ever
      // sets/clears `ticket.parent` itself (it has no `others` to
      // recompute ancestry with — see tickets/update.ts's top doc) —
      // `root_id`/`path` here are still `current`'s stale values.
      // `recomputeAncestry` (parent.ts, same function `edit.ts`'s own
      // reparent path uses) derives the correct ones from the
      // NOW-validated `parent` chain (or its absence, for a clear), plus
      // every EXISTING descendant's own `root_id`/`path` that must move
      // with it. `validateTicketEdges` above has already confirmed
      // `parent` is acyclic and (if local) resolves to a real ticket in
      // `others` — `recomputeAncestry`'s own documented precondition.
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
          await backend.updateTicket(
            current.id,
            patch,
            ticket,
            ticketEventContext(actor, current),
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
            await backend.updateTicket(
              descendant.id,
              descendantPatch,
              descendant,
              ticketEventContext(actor, descendant),
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

    await backend.updateTicket(
      current.id,
      patch,
      ticket,
      ticketEventContext(actor, current),
      { verb, payload },
      clock,
    );

    return { ticket, reparentedDescendants };
  });

  return { ticket, reparentedDescendants, warnings };
}

export async function runUpdate(refs: string[], opts: UpdateCommandOptions): Promise<void> {
  // t-9uvbr: mutual exclusivity, checked up front — same "reject before
  // any I/O" discipline every other usage-mistake check in this codebase
  // follows (e.g. drop.ts's blank-`--reason` guard).
  if (opts.clearOwner === true && opts.owner !== undefined) {
    throw new SlopError(
      "--clear-owner and --owner are mutually exclusive — pass one or the other",
      EXIT_CODES.USAGE_ERROR,
    );
  }
  if (opts.clearParent === true && opts.parent !== undefined) {
    throw new SlopError(
      "--clear-parent and --parent are mutually exclusive — pass one or the other",
      EXIT_CODES.USAGE_ERROR,
    );
  }

  // t-mmngo: refs from stdin ("-") and a stdin-reading option flag both
  // want the SAME stdin — reject the ambiguous combination up front rather
  // than letting one silently starve the other of input.
  if (refs.length === 1 && refs[0] === "-" && (opts.spec === "-" || opts.details === "-")) {
    throw new SlopError(
      'cannot combine "-" (read refs from stdin) with --spec -/--details - (which also read ' +
        "stdin) — give refs literally, or pass --spec/--details a real value",
      EXIT_CODES.USAGE_ERROR,
    );
  }

  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });
  const backend = await openStorage(paths);

  // t-mmngo: `--spec`/`--details`/etc. are SHARED flags applying to every
  // ref — but stdin can only be read once, so `-` is resolved here, ONCE,
  // before resolving which refs to process at all (not inside a per-ref
  // loop, which would starve every ref after the first).
  const specRaw =
    opts.spec === undefined ? undefined : opts.spec === "-" ? await readStdin() : opts.spec;
  const detailsRaw =
    opts.details === undefined
      ? undefined
      : opts.details === "-"
        ? await readStdin()
        : opts.details;

  const resolvedRefs = await resolveBulkRefs(refs);

  await runSingleOrBulk(
    resolvedRefs,
    (ref) => updateOneRef(backend, actor, specRaw, detailsRaw, opts, ref),
    (result) => printUpdated(result, opts.json),
    (outcomes) => renderBulkUpdate(outcomes, opts.json),
  );
}

/** `slop update` — design.md §4.2; work item B1.
 *
 * The general mutator: `new`'s sugar flags and the dedicated verb commands
 * (`draft`/`undraft`/`review`/`stop`/`done`/`drop`/`plan --check`, …) are
 * all expressible in terms of `update`. Also the non-interactive path for
 * post-creation edge/owner repair (`--parent`/`--clear-parent`/`--blocks`/
 * `--discovered-from`/`--owner`/`--clear-owner`/`--relates-to`) that used
 * to require `slop edit` (edit-vi-fallback-hangs-agents) — `edit`'s
 * `$EDITOR` fallback can hang forever on a non-TTY; these flags never do.
 *
 * t-mmngo: accepts multiple `<refs...>` (or `-` to read refs from stdin,
 * one per line) — every shared flag applies to every ref, applied per-ref
 * (never all-or-nothing); see `runSingleOrBulk`'s doc (shared.ts) for the
 * exact single-vs-bulk output contract.
 */
export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description(
      "General ticket mutator (progress notes, state, priority, labels, name, spec, " +
        "relates-to, blocks, discovered-from, owner, parent); the verb commands are sugar " +
        'over this. Accepts multiple <refs...> (or "-" to read refs from stdin, one per ' +
        "line), applied per-ref.",
    )
    .argument("<refs...>", 'one or more tickets to update (or "-" to read refs from stdin)')
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
      "--discovered-from <±ref>",
      "add (+ref) or remove (-ref) a discovered-from edge (repeatable) — not cycle-checked, same as --relates-to",
      collect,
      [] as string[],
    )
    .option(
      "--owner <actor>",
      "set/replace the owning actor: a bare name (human, back-compat) or agent:<name>/human:<name>. " +
        "Mutually exclusive with --clear-owner.",
    )
    .option("--clear-owner", "clear the owning actor entirely. Mutually exclusive with --owner.")
    .option(
      "--parent <ref>",
      "reparent <ref> under this ticket, or an external ref (e.g. jira:PROJ-123); recomputes " +
        "root_id/path for <ref> AND every existing descendant. Mutually exclusive with --clear-parent.",
    )
    .option(
      "--clear-parent",
      "clear the parent, becoming a local root; recomputes root_id/path for this ticket and " +
        "every descendant, same as reparenting. Mutually exclusive with --parent.",
    )
    .option(
      "--json",
      "machine-readable result (id, slug, handle, name, state, priority, reparented_descendants) " +
        "for a single ref; {results[], ok, succeeded, failed} for multiple",
    )
    .action(runUpdate);
}
