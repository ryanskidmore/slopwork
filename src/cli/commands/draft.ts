import type { Command } from "commander";
import { repoPaths, requireRepoRoot, resolveTicketRef, updateTicket } from "../../repo/index.js";
import { assertDraftable } from "../../tickets/draft.js";
import { buildUpdate } from "../../tickets/update.js";
import { loadConfig, resolveActor } from "../actor.js";

async function runDraft(ref: string): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });

  const current = await resolveTicketRef(paths, ref);
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
    process.stdout.write(
      `${current.id}  (slug: ${current.slug}) is already draft — no changes made\n` +
        `  ${current.name}\n`,
    );
    return;
  }

  const { ticket, patch, verb, payload } = buildUpdate(current, {
    state: "draft",
    labelOps: [],
  });

  await updateTicket(paths, current.id, patch, ticket, { actor, session: null }, { verb, payload });

  process.stdout.write(
    `drafted ${ticket.id}  (slug: ${ticket.slug})\n` +
      `  ${ticket.name}\n` +
      `  state: ${ticket.state}\n`,
  );
}

/** `slop draft` — design.md §4.2, D13; work item B2. Sugar over `update
 * --state draft` (open -> draft only — see `tickets/draft.ts`). */
export function registerDraftCommand(program: Command): void {
  program
    .command("draft")
    .description("Move a ticket to draft state (drafts are never `ready` and never started).")
    .argument("<ref>", "ticket to move to draft")
    .action(runDraft);
}
