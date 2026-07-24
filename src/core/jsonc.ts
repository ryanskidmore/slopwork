/**
 * JSONC read/write, per the S3 spike (docs/spikes/jsonc.md). Read the spike
 * before touching this file — it is not advisory, it is the spec for this
 * module, including a documented data-corruption bug in
 * `jsonc-parser@3.3.1` that `writeUpdate`'s safety net exists to catch.
 *
 * Strategy (spike "Decision"):
 *   - Tickets and sessions (human-facing, git-committed, hand-edited via
 *     `slop edit`): {@link writeUpdate} — surgical `modify()` +
 *     `applyEdits()` to preserve human comments, behind a mandatory
 *     reparse-and-validate safety net that falls back to canonical.
 *   - Events and `index.jsonc` (machine-only, write-once or fully
 *     derived): always {@link writeCanonical}. Nothing to preserve.
 */
import * as jsonc from "jsonc-parser";
import type { JSONPath } from "jsonc-parser";

/**
 * The one shared `FormattingOptions` object every writer in this codebase
 * must use. Idempotency across repeated `modify()` cycles was only
 * verified (docs/spikes/jsonc.md, "Formatting stability") when every writer
 * uses these exact options consistently — importing this constant instead
 * of constructing a fresh options object anywhere is load-bearing, not
 * style.
 */
export const FORMATTING_OPTIONS: jsonc.FormattingOptions = {
  tabSize: 2,
  insertSpaces: true,
  eol: "\n",
  insertFinalNewline: true,
};

const PARSE_OPTIONS: jsonc.ParseOptions = {
  allowTrailingComma: true,
  allowEmptyContent: false,
};

export interface ParseJsoncResult<T> {
  value: T;
  errors: jsonc.ParseError[];
}

/**
 * Tolerant parse. Never throws — `jsonc.parse` always returns a
 * best-effort value; the only signal of trouble is `errors`. Callers MUST
 * check `errors` themselves; an empty-but-wrong-shaped `value` is
 * possible (e.g. duplicate keys silently keep the last occurrence — see
 * docs/spikes/jsonc.md "Known limitations" item 3).
 */
export function parseJsonc<T = unknown>(text: string): ParseJsoncResult<T> {
  const errors: jsonc.ParseError[] = [];
  const value = jsonc.parse(text, errors, PARSE_OPTIONS) as T;
  return { value, errors };
}

/** 1-based line and column for a byte offset into `text`. */
function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewlineOffset = -1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") {
      line++;
      lastNewlineOffset = i;
    }
  }
  return { line, column: offset - lastNewlineOffset };
}

/**
 * Human-readable `path:line:col: Message` lines for A3's "clear errors on
 * hand-corrupted files" requirement.
 */
export function formatParseErrors(
  file: string,
  text: string,
  errors: jsonc.ParseError[],
): string[] {
  return errors.map((error) => {
    const { line, column } = lineAndColumn(text, error.offset);
    return `${file}:${line}:${column}: ${jsonc.printParseErrorCode(error.error)}`;
  });
}

/**
 * New file, or any machine-only file (events/, index.jsonc). There is no
 * existing document to preserve comments in, so this is a plain canonical
 * rewrite.
 */
export function writeCanonical<T>(value: T): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface JsoncPatchEntry {
  /** Path to the value to change, per jsonc-parser's `JSONPath` (property names / array indices). */
  path: JSONPath;
  /** The new value, or `undefined` to delete the property/item at `path`. */
  value: unknown;
}

/** Structural deep-equality over plain JSON-shaped values (objects/arrays/primitives only). */
function deepEqualJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false; // a === b already handled the both-null case
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqualJsonValue(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord).sort();
    const bKeys = Object.keys(bRecord).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
    }
    return aKeys.every((key) => deepEqualJsonValue(aRecord[key], bRecord[key]));
  }
  return false;
}

/**
 * Step 1 of the safety net: does this patch entry delete what is, in the
 * *pre-patch* document, the last element of an array? Evaluated against
 * `root` (parsed once, before any edit in this call is applied) rather
 * than re-parsing after every entry — for the overwhelmingly common
 * single-entry patch this is exact; for a multi-entry patch where an
 * earlier entry changes the very array a later entry targets, this may
 * under-detect, but correctness never depends on it: step 3's
 * reparse-and-deep-equal check is what actually guarantees a correct
 * result, this is purely a defensive skip to avoid handing already
 * mangled intermediate text to a later `modify()` call.
 */
function deletesLastArrayElement(root: jsonc.Node | undefined, entry: JsoncPatchEntry): boolean {
  if (entry.value !== undefined) return false;
  const lastSegment = entry.path[entry.path.length - 1];
  if (typeof lastSegment !== "number") return false;
  if (!root) return false;
  const parentPath = entry.path.slice(0, -1);
  const arrayNode = parentPath.length === 0 ? root : jsonc.findNodeAtLocation(root, parentPath);
  if (arrayNode?.type !== "array" || !arrayNode.children) return false;
  return lastSegment === arrayNode.children.length - 1;
}

/**
 * Update an existing human-facing file (ticket/session), preserving
 * comments where possible. `expectedAfter` is the domain object the patch
 * is supposed to produce — used purely as a validation oracle, never
 * trusted blindly.
 *
 * Safety net (docs/spikes/jsonc.md "Recommended API" — this is the point of
 * the function, not an afterthought):
 *   1. If any single patch entry deletes the LAST element of an array
 *      (checked against the pre-patch document), skip `modify()`
 *      entirely for this call and go straight to canonical — this is the
 *      known `jsonc-parser@3.3.1` data-corruption bug: an inline
 *      (single-line) array with >=2 elements gets malformed when its
 *      last element is removed via `modify()`.
 *   2. Otherwise attempt the surgical patch: apply every entry in order
 *      via `modify()` + `applyEdits()`, all wrapped in one `try/catch`
 *      (`modify()` throws synchronously when asked to delete through a
 *      missing intermediate object/array or an out-of-range index).
 *   3. Reparse the surgical result. If it has any parse errors, or the
 *      reparsed value doesn't deep-equal `expectedAfter`, discard it.
 *   4. Only a surgical result that survived step 3 untouched is ever
 *      returned; anything else — a thrown exception, parse errors, or a
 *      structural mismatch — falls back to `writeCanonical(expectedAfter)`.
 *
 * Because of this, `parseJsonc(writeUpdate(...)).value` deep-equals
 * `expectedAfter` unconditionally, by construction — see docs/spikes/jsonc.md,
 * "What the round-trip property test can honestly assert". Comment
 * survival does not: it is best-effort, and lost outright for whichever
 * single write trips the step-3 fallback (docs/spikes/jsonc.md documents
 * exactly which cases are lossy: deleting a key/element with an attached
 * comment, and any write that fails validation).
 */
export function writeUpdate<T>(
  existingText: string,
  patch: JsoncPatchEntry[],
  expectedAfter: T,
): string {
  const preParseErrors: jsonc.ParseError[] = [];
  const rootBefore = jsonc.parseTree(existingText, preParseErrors, PARSE_OPTIONS);

  const mustSkipSurgical = patch.some((entry) => deletesLastArrayElement(rootBefore, entry));

  if (!mustSkipSurgical) {
    try {
      let text = existingText;
      for (const entry of patch) {
        const edits = jsonc.modify(text, entry.path, entry.value, {
          formattingOptions: FORMATTING_OPTIONS,
        });
        text = jsonc.applyEdits(text, edits);
      }
      const { value: reparsed, errors } = parseJsonc<unknown>(text);
      if (errors.length === 0 && deepEqualJsonValue(reparsed, expectedAfter)) {
        return text;
      }
    } catch {
      // modify() can throw synchronously (e.g. deleting through a missing
      // intermediate path) — fall through to canonical below, same as
      // any other validation failure.
    }
  }

  return writeCanonical(expectedAfter);
}
