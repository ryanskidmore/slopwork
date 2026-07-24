import type { Command } from "commander";
import { repoPaths, requireRepoRoot, resolveTicketRef, updateTicket } from "../../repo/index.js";
import { assertUndraftable } from "../../tickets/draft.js";
import { buildUpdate } from "../../tickets/update.js";
import { loadConfig, resolveActor } from "../actor.js";

async function runUndraft(ref: string): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });

  const current = await resolveTicketRef(paths, ref);
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
    process.stdout.write(
      `${current.id}  (slug: ${current.slug}) is already open — no changes made\n` +
        `  ${current.name}\n`,
    );
    return;
  }

  const { ticket, patch, verb, payload } = buildUpdate(current, {
    state: "open",
    labelOps: [],
  });

  await updateTicket(paths, current.id, patch, ticket, { actor, session: null }, { verb, payload });

  process.stdout.write(
    `undrafted ${ticket.id}  (slug: ${ticket.slug})\n` +
      `  ${ticket.name}\n` +
      `  state: ${ticket.state}\n`,
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
