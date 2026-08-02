/**
 * Idempotent `.gitattributes` section management for `slop init` (t-mgx82:
 * "slop init manages .gitattributes: generated markers for GitHub +
 * GitLab").
 *
 * Same contract as gitignore.ts's `.gitignore` handling (D14/D16): `slop
 * init` never owns the whole `.gitattributes` file — only one clearly
 * marked, managed section within it. Re-running `init` replaces just that
 * section in place, so the attributes always stay current without ever
 * duplicating lines or touching anything the repo owner put in the file
 * themselves. The actual upsert mechanics (CRLF-tolerant marker matching,
 * trailing-blank-line trimming) live in managed-section.ts, shared with
 * gitignore.ts.
 *
 * Note for THIS repo specifically: slopwork's own root `.gitattributes`
 * already had a hand-written version of the generated-markers rule, added
 * before this feature existed (see the `.slop/db/*.jsonc text eol=lf` /
 * `.slop/db/** linguist-generated gitlab-generated` lines above the
 * managed section this file now also appends). That's fine — git tolerates
 * a repeated attribute pattern — and `upsertGitattributesSection` never
 * rewrites or dedupes hand-written lines; it only ever touches its own
 * marked section. The hand-written lines can be deleted now that `init`
 * manages an equivalent section, but nothing requires it.
 */
import { upsertManagedSection } from "./managed-section.js";

const SECTION_START = "# --- slopwork (managed by `slop init`) ---";
const SECTION_END = "# --- end slopwork ---";

/**
 * t-mgx82 — the exact lines `slop init` is responsible for.
 *
 * - `.slop/db/** linguist-generated gitlab-generated` marks the tracker
 *   database as generated so GitHub (`linguist-generated`) and GitLab
 *   (`gitlab-generated`) both collapse it in PR/MR diffs by default — it's
 *   machine-written by `slop`, never hand-edited.
 * - `.slop/db/**` + `/*.jsonc text eol=lf` scopes LF enforcement to just the db:
 *   every `.jsonc` file under it is written with LF line endings by
 *   src/core/jsonc.ts's shared `FORMATTING_OPTIONS` (`eol: "\n"`), and the
 *   flatfile db's diff-minimal-write/git-merge story (docs/spikes/jsonc.md,
 *   "Recommended FormattingOptions") depends on checkout not reintroducing
 *   CRLF on a non-Linux clone. Scoped (rather than a repo-wide `*.jsonc`
 *   rule) so a fresh `init` is safe by default without assuming anything
 *   about how a repo wants to handle `.jsonc` files elsewhere in its tree.
 */
export function computeGitattributesLines(): string[] {
  return [".slop/db/** linguist-generated gitlab-generated", ".slop/db/**/*.jsonc text eol=lf"];
}

/**
 * Replace (or insert) the managed slopwork section of a `.gitattributes`'s
 * text with `lines`. Any content outside the markers — including a
 * missing/empty file, and including this repo's own hand-written
 * generated-markers lines predating this feature — is left exactly as
 * found.
 */
export function upsertGitattributesSection(
  existingText: string,
  lines: string[],
): { text: string; changed: boolean } {
  return upsertManagedSection(existingText, lines, {
    start: SECTION_START,
    end: SECTION_END,
  });
}
