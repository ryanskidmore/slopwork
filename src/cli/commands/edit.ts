import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { EXIT_CODES } from "../../core/exit-codes.js";
import {
  atomicWriteFile,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
  ticketFilePath,
  updateTicket,
} from "../../repo/index.js";
import { validateEditedTicketText } from "../../tickets/edit.js";
import { fullFieldPatch } from "../../tickets/patch.js";
import { loadConfig, resolveActor } from "../actor.js";
import { SlopError } from "../errors.js";

/** `$VISUAL` first, then `$EDITOR`, then a sensible POSIX fallback (`vi`
 * is present on essentially every real Unix system this binary targets —
 * see README's Bun/CI requirements). A launch failure even for that
 * fallback (e.g. a minimal container with no editor at all) is where the
 * "clear error if none" half of B1's brief actually fires — see
 * `runEdit`'s `result.error` handling below. */
function pickEditorCommand(): string {
  return process.env.VISUAL || process.env.EDITOR || "vi";
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

  const validation = validateEditedTicketText(after, ticket.id);
  if (!validation.ok) {
    // Reject without persisting garbage, and don't lose the user's edit:
    // park it somewhere recoverable, then restore the file to its last
    // -known-good content.
    const rescuePath = join(tmpdir(), `slop-edit-${ticket.id}-${Date.now()}.jsonc`);
    await writeFile(rescuePath, after, "utf8");
    await atomicWriteFile(filePath, before);
    throw new SlopError(
      [
        `edited ${ticket.id} failed validation and was NOT saved:`,
        ...validation.errors,
        `your edit is preserved at ${rescuePath} — fix it and re-run \`slop edit ${ref}\`, or ` +
          "copy the corrected content back in by hand.",
      ].join("\n"),
      EXIT_CODES.USAGE_ERROR,
    );
  }

  // Route the persisted write through updateTicket/writeUpdate's
  // comment-preserving, reparse-and-validate safety net (core/jsonc.ts's
  // S3 spike decision) rather than trusting the editor's raw on-disk
  // bytes as final. The file already reads exactly as `validation.ticket`
  // (that's what was just parsed), so in the common case this call
  // normalizes formatting and emits the required event over content that
  // was already correct — never a second chance for garbage to slip in.
  const patch = fullFieldPatch(validation.ticket);
  await updateTicket(
    paths,
    ticket.id,
    patch,
    validation.ticket,
    { actor, session: null },
    { verb: "ticket.updated", payload: { method: "edit" } },
  );

  process.stdout.write(`saved ${ticket.id}\n`);
}

/** `slop edit` — design.md §4.2; work item B1. */
export function registerEditCommand(program: Command): void {
  program
    .command("edit")
    .description("Open <ref>'s ticket JSONC file in $EDITOR.")
    .argument("<ref>", "ticket to edit")
    .action(runEdit);
}
