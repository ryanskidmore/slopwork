import type { Command } from "commander";
import { shortTicketCode } from "../../core/index.js";
import {
  readTicket,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
  updateTicket,
  withLock,
} from "../../repo/index.js";
import { assertDraftable } from "../../tickets/draft.js";
import { buildUpdate } from "../../tickets/update.js";
import { loadConfig, resolveActor } from "../actor.js";

interface DraftCommandOptions {
  json?: boolean;
}

export async function runDraft(ref: string, opts: DraftCommandOptions = {}): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });

  // A read outside the lock is fine for resolving <ref> -> id; the
  // decisive read-modify-write happens fresh, under the lock, below — same
  // convention as start.ts/stop.ts/done.ts (see start.ts's comment on
  // `initialTicket`) — otherwise a concurrent `start`/`stop`/`done` landing
  // between this read and the write below would be silently reverted by
  // `updateTicket`'s `writeCanonical(expectedAfter)` fallback.
  const initialTicket = await resolveTicketRef(paths, ref);

  const result = await withLock(paths.lockFile, async () => {
    const current = await readTicket(paths, initialTicket.id);
    // The one guard `update.ts`'s generic transition table can't express on
    // its own — see `tickets/draft.ts`'s module doc.
    assertDraftable(current);

    // E1: an already-draft ticket is a legitimate no-op (assertDraftable's
    // own doc calls this "idempotent"), but the write itself is skipped
    // entirely — no bumped updated_at, no ticket.updated event — and the
    // message says "already draft" rather than the misleading "drafted"
    // (which used to print even though nothing changed). A genuine illegal
    // transition (in_progress/review/done/dropped) still exits 6 above,
    // unaffected by this early return.
    if (current.state === "draft") {
      return { ticket: current, alreadyDraft: true };
    }

    const { ticket, patch, verb, payload } = buildUpdate(current, {
      state: "draft",
      labelOps: [],
      acceptance: [],
      context: [],
    });

    await updateTicket(
      paths,
      current.id,
      patch,
      ticket,
      { actor, session: null },
      { verb, payload },
    );

    return { ticket, alreadyDraft: false };
  });

  if (opts.json) {
    // closing-loop-commands-lack-json (nice-to-have): same small shape as
    // `update --json`'s own result, plus `already_draft` naming the
    // no-op case the text output distinguishes with different wording.
    process.stdout.write(
      `${JSON.stringify(
        {
          id: result.ticket.id,
          slug: result.ticket.slug,
          handle: shortTicketCode(result.ticket.id),
          name: result.ticket.name,
          state: result.ticket.state,
          already_draft: result.alreadyDraft,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (result.alreadyDraft) {
    process.stdout.write(
      `${result.ticket.id}  (slug: ${result.ticket.slug}) is already draft — no changes made\n` +
        `  ${result.ticket.name}\n`,
    );
    return;
  }

  process.stdout.write(
    `drafted ${result.ticket.id}  (slug: ${result.ticket.slug})\n` +
      `  ${result.ticket.name}\n` +
      `  state: ${result.ticket.state}\n`,
  );
}

/** `slop draft` — design.md §4.2, D13; work item B2. Sugar over `update
 * --state draft` (open -> draft only — see `tickets/draft.ts`). */
export function registerDraftCommand(program: Command): void {
  program
    .command("draft")
    .description("Move a ticket to draft state (drafts are never `ready` and never started).")
    .argument("<ref>", "ticket to move to draft")
    .option("--json", "machine-readable result (id, slug, handle, name, state, already_draft)")
    .action(runDraft);
}
