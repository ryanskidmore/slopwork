/**
 * Idempotent `.gitignore` section management for `slop init` (D14:
 * "index.jsonc gitignored").
 *
 * `slop init` never owns the whole `.gitignore` file — only one clearly
 * marked, managed section within it. Re-running `init` replaces just
 * that section in place, so the gitignore entries always stay current
 * without ever duplicating lines or touching anything the repo owner put
 * in the file themselves.
 */
const SECTION_START = "# --- slopwork (managed by `slop init`) ---";
const SECTION_END = "# --- end slopwork ---";

/**
 * D14 — the exact lines `slop init` is responsible for.
 *
 * Also always ignores the lock file and
 * atomic-write temp files: a `kill -9` mid-transaction can leave the lock
 * file and/or a temp file (see atomic-write.ts's TEMP_FILE_PREFIX) on
 * disk. Left untracked, a `git add -A` would commit these ephemeral
 * files — the lock then round-trips through merge (a conflict on a file
 * with no meaningful content to merge) and, worse, on a fresh clone its
 * foreign pid can read as "alive" and stall every write for the full
 * stale-lock timeout. One glob covers a temp file written directly in
 * db/ (e.g. index.jsonc's own atomic write); the other covers one
 * written in a subdirectory (tickets/, sessions/, events/) next to its
 * target, per atomic-write.ts's same-directory-as-target rule.
 *
 * housekeeping-gitignore-lock-stale: also ignores the `.lock.stale-<token>`
 * sentinel `lock.ts`'s `tryBreakStaleLock` renames a dead/expired lock to
 * mid-break (see that function): the happy path `rm`s it again a moment
 * later, but a crash between the `rename` and that `rm` can leave it on
 * disk — same "ephemeral, never meant to be committed" hazard as the bare
 * `.lock`/`.tmp-*` entries above, just one glob widened to catch the
 * `.stale-*` suffix too.
 */
export function computeGitignoreLines(): string[] {
  return [
    ".slop/db/index.jsonc",
    ".slop/db/.lock",
    ".slop/db/.lock.stale-*",
    ".slop/db/.tmp-*",
    ".slop/db/*/.tmp-*",
  ];
}

/**
 * Replace (or insert) the managed slopwork section of a `.gitignore`'s
 * text with `lines`. Any content outside the markers — including a
 * missing/empty file — is left exactly as found; an existing managed
 * section (from a prior `init`) is removed and rewritten in place rather
 * than appended again, so repeated runs never duplicate entries.
 */
export function upsertGitignoreSection(
  existingText: string,
  lines: string[],
): { text: string; changed: boolean } {
  const before = existingText;
  // A CRLF `.gitignore` (Windows, or `core.autocrlf=true` on any platform) split
  // on a bare `"\n"` would leave a trailing `"\r"` on every line, so
  // neither marker line would ever match `SECTION_START`/`SECTION_END`
  // below — re-running `init` against such a file would never find its
  // own prior managed section and would duplicate it instead. Splitting
  // on `/\r?\n/` strips the `\r` either way, so LF and CRLF input both
  // produce identical, marker-matchable line arrays. Output is always
  // rejoined with plain `"\n"` (unchanged), normalizing CRLF input to LF.
  const sourceLines = existingText.length > 0 ? existingText.split(/\r?\n/) : [];

  const startIdx = sourceLines.indexOf(SECTION_START);
  const endIdx = sourceLines.indexOf(SECTION_END);

  let kept: string[];
  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    kept = [...sourceLines.slice(0, startIdx), ...sourceLines.slice(endIdx + 1)];
  } else {
    kept = sourceLines;
  }

  // Trim trailing blank lines from what's kept, so re-running init never
  // accumulates blank-line padding between unrelated content and the
  // managed block.
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") {
    kept.pop();
  }

  const block = [SECTION_START, ...lines, SECTION_END];
  const rebuilt = kept.length > 0 ? [...kept, "", ...block] : block;

  const text = `${rebuilt.join("\n")}\n`;
  return { text, changed: text !== before };
}
