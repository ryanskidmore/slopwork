/**
 * Generic "managed section" upsert for a repo-root config file `slop init`
 * only partially owns — `.gitignore` (D14/D16, see gitignore.ts) and
 * `.gitattributes` (see gitattributes.ts) both follow this exact contract:
 * `init` never owns the whole file, only one clearly marked section within
 * it. Re-running `init` replaces just that section in place, so the
 * managed lines always stay current without ever duplicating themselves or
 * touching anything the repo owner put in the file directly.
 *
 * Pulled out as a shared helper (rather than duplicated per file) so the
 * two subtle correctness properties below can't drift between
 * `.gitignore` and `.gitattributes` handling:
 *
 *  - CRLF tolerance: a CRLF-line-ended file (Windows, or any platform with
 *    `core.autocrlf=true`) split on a bare `"\n"` would leave a trailing
 *    `"\r"` on every line, so neither marker line would ever match — a
 *    re-run would never find its own prior managed section and would
 *    duplicate it instead of replacing it. Splitting on `/\r?\n/` strips
 *    the `\r` either way; output is always rejoined with plain `"\n"`,
 *    normalizing CRLF input to LF.
 *  - Trailing-blank-line trimming: whatever precedes the managed section
 *    (existing unrelated content) has its trailing blank lines trimmed
 *    before the section is (re-)appended, so re-running `init` never
 *    accumulates blank-line padding between unrelated content and the
 *    managed block.
 */
export interface ManagedSectionMarkers {
  readonly start: string;
  readonly end: string;
}

/**
 * Replace (or insert) the section of `existingText` delimited by
 * `markers.start`/`markers.end` with `lines`. Any content outside the
 * markers — including a missing/empty file — is left exactly as found; an
 * existing managed section (from a prior `init`) is removed and rewritten
 * in place rather than appended again, so repeated runs never duplicate
 * entries.
 */
export function upsertManagedSection(
  existingText: string,
  lines: string[],
  markers: ManagedSectionMarkers,
): { text: string; changed: boolean } {
  const before = existingText;
  const sourceLines = existingText.length > 0 ? existingText.split(/\r?\n/) : [];

  const startIdx = sourceLines.indexOf(markers.start);
  const endIdx = sourceLines.indexOf(markers.end);

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

  const block = [markers.start, ...lines, markers.end];
  const rebuilt = kept.length > 0 ? [...kept, "", ...block] : block;

  const text = `${rebuilt.join("\n")}\n`;
  return { text, changed: text !== before };
}
