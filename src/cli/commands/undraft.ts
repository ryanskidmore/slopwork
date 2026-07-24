import type { Command } from "commander";
import {
  readTicket,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
  updateTicket,
  withLock,
} from "../../repo/index.js";
import { assertUndraftable } from "../../tickets/draft.js";
import { buildUpdate } from "../../tickets/update.js";
import { loadConfig, resolveActor } from "../actor.js";

async function runUndraft(ref: string): Promise<void> {
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
    // Load-bearing guard — see `tickets/draft.ts`'s module doc for why
    // `undraft` cannot just reuse `update`'s generic transition table alone
    // (it would also silently accept `in_progress -> open`, `stop`'s edge).
    assertUndraftable(current);

    // E1: an already-open ticket is a legitimate no-op (assertUndraftable's
    // own doc calls this "idempotent"), but the write itself is skipped
    // entirely — no bumped updated_at, no ticket.updated event — and the
    // message says "already open" rather than the misleading "undrafted"
    // (which used to print even though the ticket was never drafted in the
    // first place). A genuine illegal transition (in_progress/review/done/
    // dropped) still exits 6 above, unaffected by this early return.
    if (current.state === "open") {
      return { ticket: current, alreadyOpen: true };
    }

    const { ticket, patch, verb, payload } = buildUpdate(current, {
      state: "open",
      labelOps: [],
    });

    await updateTicket(
      paths,
      current.id,
      patch,
      ticket,
      { actor, session: null },
      { verb, payload },
    );

    return { ticket, alreadyOpen: false };
  });

  if (result.alreadyOpen) {
    process.stdout.write(
      `${result.ticket.id}  (slug: ${result.ticket.slug}) is already open — no changes made\n` +
        `  ${result.ticket.name}\n`,
    );
    return;
  }

  process.stdout.write(
    `undrafted ${result.ticket.id}  (slug: ${result.ticket.slug})\n` +
      `  ${result.ticket.name}\n` +
      `  state: ${result.ticket.state}\n`,
  );
}

/** `slop undraft` — design.md §4.2, D13; work item B2. Sugar over `update
 * --state open` (draft -> open only — see `tickets/draft.ts`). */
export function registerUndraftCommand(program: Command): void {
  program
    .command("undraft")
    .description("Move a draft ticket to open, making it eligible for `ready`.")
    .argument("<ref>", "draft ticket to open")
    .action(runUndraft);
}
