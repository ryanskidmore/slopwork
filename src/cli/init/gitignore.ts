/**
 * Idempotent `.gitignore` section management for `slop init` (D14:
 * "index.jsonc gitignored").
 *
 * `slop init` never owns the whole `.gitignore` file — only one clearly
 * marked, managed section within it. Re-running `init` replaces just
 * that section in place, so the gitignore entries always stay current
 * without ever duplicating lines or touching anything the repo owner put
 * in the file themselves.
 *
 * The actual upsert mechanics (CRLF-tolerant marker matching, trailing-
 * blank-line trimming) live in managed-section.ts, shared with
 * gitattributes.ts's identical `.gitattributes` handling.
 */
import { upsertManagedSection } from "./managed-section.js";

const SECTION_START = "# --- slopwork (managed by `slop init`) ---";
const SECTION_END = "# --- end slopwork ---";

/**
 * D14 — the exact lines `slop init` is responsible for.
 *
 * Also always ignores polling checkpoint state, lock files, and
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
 *
 * t-cloj2 follow-up ("make acquisition and release token-safe"): `releaseLock`
 * uses the SAME rename-then-verify shape, via its own
 * `.lock.released-<token>` retirement path — a crash between that rename
 * and the matching `rm` is the identical "ephemeral artifact, never meant
 * to be committed" hazard as `.lock.stale-*` above, just for the release
 * side of the same protocol.
 */
export function computeGitignoreLines(): string[] {
  return [
    ".slop/db/index.jsonc",
    ".slop/db/mutation-journal/",
    ".slop/db/event-cursors/",
    ".slop/db/.event-cursors.lock",
    ".slop/db/.event-cursors.lock.stale-*",
    ".slop/db/.lock",
    ".slop/db/.lock.stale-*",
    ".slop/db/.lock.released-*",
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
  return upsertManagedSection(existingText, lines, {
    start: SECTION_START,
    end: SECTION_END,
  });
}
