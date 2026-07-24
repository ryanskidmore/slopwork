import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import type { ExitCode, JsoncPatchEntry } from "../../core/index.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import {
  atomicWriteFile,
  listTickets,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
  ticketFilePath,
  updateTicket,
  withLock,
} from "../../repo/index.js";
import { validateEditedTicketText } from "../../tickets/edit.js";
import { validateTicketEdges } from "../../tickets/edges.js";
import { fullFieldPatch } from "../../tickets/patch.js";
import { recomputeAncestry } from "../../tickets/parent.js";
import { loadConfig, resolveActor } from "../actor.js";
import { SlopError } from "../errors.js";

/** `$VISUAL` first, then `$EDITOR`, then a platform-appropriate fallback:
 * `vi` is present on essentially every real Unix system this binary
 * targets (see README's Bun/CI requirements — Linux/macOS is the tested
 * platform), but stock Windows has no `vi` at all, so falling back to it
 * there would always fail to launch. `notepad` is on every stock Windows
 * install and is the analogous "always there" fallback for `win32`
 * (best-effort, unverified — no Windows environment to test the actual
 * launch against; see the `--transcript`-style "graceful degrade, never
 * crash" posture used elsewhere in this codebase). A launch failure even
 * for that fallback (e.g. a minimal container with no editor at all) is
 * where the "clear error if none" half of B1's brief actually fires — see
 * `runEdit`'s `result.error` handling below. */
export function pickEditorCommand(): string {
  if (process.env.VISUAL) return process.env.VISUAL;
  if (process.env.EDITOR) return process.env.EDITOR;
  return process.platform === "win32" ? "notepad" : "vi";
}

/**
 * Shared "don't lose the user's edit" rescue path (B1's original behavior,
 * extended by B3 to cover graph-validation failures too — cycle/degree-cap/
 * dangling-edge, not just schema failures): park the rejected text
 * somewhere recoverable, restore the real file to its last-known-good
 * content, then throw with `exitCode` so the caller's own exit code
 * (USAGE_ERROR for a schema failure; whatever `edges.ts` raised — CONFLICT
 * or NOT_FOUND — for a graph failure) is preserved rather than flattened
 * to one fixed code.
 */
async function rescueAndRollback(
  filePath: string,
  before: string,
  after: string,
  ticketId: string,
  ref: string,
  headline: string,
  errors: string[],
  exitCode: ExitCode,
): Promise<never> {
  const rescuePath = join(tmpdir(), `slop-edit-${ticketId}-${Date.now()}.jsonc`);
  await writeFile(rescuePath, after, "utf8");
  await atomicWriteFile(filePath, before);
  throw new SlopError(
    [
      headline,
      ...errors,
      `your edit is preserved at ${rescuePath} — fix it and re-run \`slop edit ${ref}\`, or ` +
        "copy the corrected content back in by hand.",
    ].join("\n"),
    exitCode,
  );
}

async function runEdit(ref: string): Promise<void> {
  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });

  const ticket = await resolveTicketRef(paths, ref);
  const filePath = ticketFilePath(paths, ticket.id);
  const before = await readFile(filePath, "utf8");

  const editorCmd = pickEditorCommand();
  const parts = editorCmd
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  const bin = parts[0];
  if (!bin) {
    throw new SlopError(
      "no editor configured — set $VISUAL or $EDITOR (e.g. `export EDITOR=vim`)",
      EXIT_CODES.USAGE_ERROR,
    );
  }
  const args = [...parts.slice(1), filePath];

  // Design.md's own wording — "open the ticket's JSONC file in $EDITOR" —
  // is taken literally: the editor works on the real db file in place, so
  // a normal save-and-quit needs no extra copy/merge step. Anything that
  // goes wrong from here (abort, invalid JSON, failed schema validation)
  // restores `before` before this function returns, so the on-disk file
  // is never left in a state worse than "unchanged."
  const result = spawnSync(bin, args, { stdio: "inherit" });

  if (result.error) {
    throw new SlopError(
      `could not launch editor "${editorCmd}" (${result.error.message}); set $VISUAL or ` +
        "$EDITOR to a working editor command",
      EXIT_CODES.GENERIC_ERROR,
    );
  }

  if (result.status !== 0) {
    // A nonzero exit conventionally means "abort, don't save" (the same
    // convention `git commit`'s $EDITOR handling uses). Whatever the
    // editor may have already written to the real file before aborting
    // is reverted rather than trusted.
    await atomicWriteFile(filePath, before);
    throw new SlopError(
      `editor "${editorCmd}" exited with status ${result.status ?? "unknown"}; ${ticket.id} left unchanged`,
      EXIT_CODES.GENERIC_ERROR,
    );
  }

  const after = await readFile(filePath, "utf8");
  if (after === before) {
    process.stdout.write(`no changes to ${ticket.id}\n`);
    return;
  }

  const validation = validateEditedTicketText(after, ticket);
  if (!validation.ok) {
    // Reject without persisting garbage, and don't lose the user's edit:
    // park it somewhere recoverable, then restore the file to its last
    // -known-good content. `validation.exitCode` carries USAGE_ERROR for a
    // shape problem or CONFLICT for an illegal state transition /
    // incoherent active_session pairing (state.ts's checkStateTransition
    // convention — see edit.ts's module doc) rather than a single fixed
    // code for every rejection reason.
    await rescueAndRollback(
      filePath,
      before,
      after,
      ticket.id,
      ref,
      `edited ${ticket.id} failed validation and was NOT saved:`,
      validation.errors,
      validation.exitCode,
    );
    return; // unreachable — rescueAndRollback always throws; here only for control-flow narrowing below
  }
  const candidate = validation.ticket;

  // B3: cycle/degree-cap/dangling-target validation, and — if `parent`
  // changed (directly, or a hand-edited `root_id`/`path` that no longer
  // agrees with it) — recomputing `root_id`/`path` for this ticket AND
  // every descendant (design.md D6). Both the graph-validity read and
  // every write below happen inside ONE db-lock acquisition (design.md
  // §3: ".lock for multi-file transactions"), so a concurrent writer can
  // never race this edit into a graph state neither of them individually
  // validated against, and `lock.assertHeld()` is called between each
  // entity write (A3's fencing contract, lock.ts) so a transaction that
  // runs long enough to be dispossessed stops rather than silently
  // continuing to write under someone else's exclusivity.
  //
  // `wroteAnything` tracks whether the FIRST write of this transaction
  // (the edited ticket itself) has actually landed. It matters for the
  // catch block below: a failure BEFORE any write (validation rejected
  // the candidate) is safe to roll back exactly like a schema failure —
  // nothing was persisted. A failure AFTER at least one write landed (an
  // `assertHeld()` dispossession, or an I/O error partway through the
  // descendant loop) must NOT roll back `filePath` — doing so would
  // overwrite an already-legitimately-persisted write and could
  // desynchronize it from any descendant that already moved to the new
  // ancestry, which is WORSE than leaving the partial state alone. This
  // is the same accepted trade-off `lock.ts`'s own module doc documents
  // for B4's done-cascade: fencing guarantees no silent double-writing
  // and an immediate stop on dispossession, not crash-atomicity across a
  // multi-file transaction. A hard kill or dispossession here could still
  // leave a partially-reparented subtree, recoverable by re-running the
  // same reparent (this whole computation is idempotent) or a manual fix.
  let wroteAnything = false;
  let descendantCount = 0;
  try {
    await withLock(paths.lockFile, async (lock) => {
      const all = await listTickets(paths);
      const others = all.filter((t) => t.id !== candidate.id);

      validateTicketEdges(candidate, others);
      const { ticket: reparented, descendants, changed } = recomputeAncestry(candidate, others);
      descendantCount = descendants.length;

      // Route the persisted write through updateTicket/writeUpdate's
      // comment-preserving, reparse-and-validate safety net (core/jsonc.ts's
      // S3 spike decision) rather than trusting the editor's raw on-disk
      // bytes as final.
      const patch = fullFieldPatch(reparented);
      await updateTicket(
        paths,
        reparented.id,
        patch,
        reparented,
        { actor, session: null },
        {
          verb: "ticket.updated",
          payload: { method: "edit", reparented: changed, descendants: descendants.length },
        },
      );
      wroteAnything = true;

      for (const descendant of descendants) {
        // Fencing contract (lock.ts): re-check between each entity write
        // once more than one write is happening under this acquisition.
        await lock.assertHeld();
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
            payload: { method: "reparent-cascade", reparent_root: reparented.id },
          },
        );
      }
    });
  } catch (err) {
    if (!wroteAnything && err instanceof SlopError) {
      await rescueAndRollback(
        filePath,
        before,
        after,
        ticket.id,
        ref,
        `edited ${ticket.id} failed graph validation and was NOT saved:`,
        [err.message],
        err.exitCode,
      );
    }
    throw err;
  }

  process.stdout.write(
    `saved ${ticket.id}\n` +
      (descendantCount > 0
        ? `  reparented — root_id/path recomputed for ${descendantCount} descendant(s)\n`
        : ""),
  );
}

/** `slop edit` — design.md §4.2; work item B1. */
export function registerEditCommand(program: Command): void {
  program
    .command("edit")
    .description("Open <ref>'s ticket JSONC file in $EDITOR.")
    .argument("<ref>", "ticket to edit")
    .action(runEdit);
}
