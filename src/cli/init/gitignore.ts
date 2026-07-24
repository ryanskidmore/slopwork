/**
 * Idempotent `.gitignore` section management for `slop init` (D14:
 * "index.jsonc gitignored"; D16: "Transcripts: stored locally, gitignored
 * by default ... committed only if `transcripts: commit`").
 *
 * `slop init` never owns the whole `.gitignore` file — only one clearly
 * marked, managed section within it. Re-running `init` (e.g. after
 * `transcripts` was hand-edited from `local` to `commit`) replaces just
 * that section in place, so the gitignore entries always reflect the
 * current config without ever duplicating lines or touching anything the
 * repo owner put in the file themselves.
 */
import type { TranscriptsMode } from "../../core/index.js";

const SECTION_START = "# --- slopwork (managed by `slop init`) ---";
const SECTION_END = "# --- end slopwork ---";

/**
 * D14 (always) + D16 ("gitignored by default ... unless `transcripts:
 * commit`") — the exact lines `slop init` is responsible for.
 *
 * Also always (independent of `transcripts`) ignores the lock file and
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
 */
export function computeGitignoreLines(transcriptsMode: TranscriptsMode): string[] {
  const lines = [".slop/db/index.jsonc", ".slop/db/.lock", ".slop/db/.tmp-*", ".slop/db/*/.tmp-*"];
  if (transcriptsMode !== "commit") {
    lines.push(".slop/transcripts/");
  }
  return lines;
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
  // Tolerant split (mirrors config-yaml.ts's own `/\r?\n/`): a CRLF
  // `.gitignore` (Windows, or `core.autocrlf=true` on any platform) split
  // on a bare `"\n"` would leave a trailing `"\r"` on every line, so
  // neither marker line would ever match `SECTION_START`/`SECTION_END`
  // below — re-running `init` against such a file would never find its
  // own prior managed section and would duplicate it instead. Splitting
  // on `/\r?\n/` strips the `\r` either way, so LF and CRLF input both
  // produce identical, marker-matchable line arrays. Output is always
  // rejoined with plain `"\n"` (unchanged) — a CRLF file's line endings
  // are normalized to LF on rewrite, exactly like config-yaml.ts already
  // does for config.yaml.
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
