/**
 * Generic single-entity file I/O shared by tickets.ts/sessions.ts/
 * events.ts: read+parse+validate, create (new file, canonical), update
 * (existing file, comment-preserving via `writeUpdate`), delete, and
 * listing ids present in a directory.
 *
 * Every read validates with the caller's zod schema — per docs/spikes/jsonc.md,
 * `parseJsonc` never throws and silently accepts duplicate keys, so a
 * clean parse is not sufficient evidence the file is good data (A3
 * scope item 3). A file that fails either step produces a clear,
 * actionable error naming the file and the location (JSONC syntax errors
 * via `formatParseErrors`; zod issues rendered as `path: message`).
 */
import { readFile, rm } from "node:fs/promises";
import type { z } from "zod";
import { EXIT_CODES } from "../core/exit-codes.js";
import { formatParseErrors, parseJsonc, writeCanonical, writeUpdate } from "../core/jsonc.js";
import type { JsoncPatchEntry } from "../core/jsonc.js";
import { SlopError } from "../core/errors.js";
import { isEnoent, readDirSafe } from "./fs-utils.js";
import { atomicWriteFile } from "./atomic-write.js";

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

/**
 * Shared `readFile` wrapper for both {@link readEntityFile} and {@link
 * updateEntityFile}'s own read: maps ENOENT to a clean NOT_FOUND {@link
 * SlopError} naming `path`, and — the fix here — maps every OTHER read
 * failure (EACCES/EIO/etc.) to a GENERIC_ERROR `SlopError` naming both
 * `path` and the underlying cause, rather than letting Node's raw `Error`
 * (no path, no actionable guidance, and not a `SlopError` at all) escape
 * to the CLI's generic top-level handler uncaught.
 */
export async function readEntityText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      throw new SlopError(`no such file: ${path}`, EXIT_CODES.NOT_FOUND);
    }
    const cause = err instanceof Error ? err.message : String(err);
    throw new SlopError(`${path}: failed to read: ${cause}`, EXIT_CODES.GENERIC_ERROR);
  }
}

/**
 * Read, JSONC-parse, and zod-validate a single entity file. Throws a
 * {@link SlopError} naming `path` and the exact location/issue on any
 * failure: missing file (NOT_FOUND, exit 4), JSONC syntax errors, schema
 * validation failures, or any other read failure (both GENERIC_ERROR,
 * exit 1 — a corrupt db file or an unreadable one is a real problem, not
 * a usage mistake) — see {@link readEntityText}.
 */
export async function readEntityFile<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await readEntityText(path);

  const { value, errors } = parseJsonc<unknown>(raw);
  if (errors.length > 0) {
    throw new SlopError(
      [`${path}: invalid JSONC`, ...formatParseErrors(path, raw, errors)].join("\n  "),
      EXIT_CODES.GENERIC_ERROR,
    );
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    throw new SlopError(
      [`${path}: failed schema validation`, ...formatZodIssues(result.error)].join("\n  "),
      EXIT_CODES.GENERIC_ERROR,
    );
  }
  return result.data;
}

/**
 * Create a brand-new entity file. Always canonical (`writeCanonical`) —
 * per jsonc.ts's own module doc, a new file has no existing document to
 * preserve comments in, so there's nothing for `writeUpdate` to buy here.
 * Relies on ULID filename uniqueness rather than filesystem-level
 * exclusivity (an `O_EXCL` create-only write); callers needing a hard
 * exclusivity guarantee should wrap this in `withLock`.
 */
export async function createEntityFileCanonical<T>(path: string, value: T): Promise<void> {
  await atomicWriteFile(path, writeCanonical(value));
}

/**
 * Update an existing, possibly hand-edited entity file. Reads the
 * current on-disk text itself (never trust a caller's stale in-memory
 * copy) and writes back via `writeUpdate`'s comment-preserving-with-
 * validation-safety-net path — this is the S3/A2 round-trip guarantee
 * this function exists to use, not reimplement.
 */
export async function updateEntityFile<T>(
  path: string,
  patch: JsoncPatchEntry[],
  expectedAfter: T,
): Promise<void> {
  const prepared = await prepareEntityFileUpdate(path, patch, expectedAfter);
  await atomicWriteFile(path, prepared.afterText);
}

export interface PreparedEntityUpdate {
  beforeText: string;
  afterText: string;
}

/**
 * Compute the exact comment-preserving entity rewrite without applying
 * it. Mutation journaling persists both strings before the write.
 */
export async function prepareEntityFileUpdate<T>(
  path: string,
  patch: JsoncPatchEntry[],
  expectedAfter: T,
): Promise<PreparedEntityUpdate> {
  const beforeText = await readEntityText(path);
  return { beforeText, afterText: writeUpdate(beforeText, patch, expectedAfter) };
}

/** Delete an entity file. Throws NOT_FOUND if it doesn't exist. */
export async function deleteEntityFile(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (err) {
    if (isEnoent(err)) {
      throw new SlopError(`no such file: ${path}`, EXIT_CODES.NOT_FOUND);
    }
    throw err;
  }
}

/**
 * List the entity ids present in `dir` — `<kind>_<ULID>.jsonc` files only,
 * filtered through `isId` (one of `isTicketId`/`isSessionId`/`isEventId`
 * from core/ids.ts). This is also what keeps a leftover atomic-write temp
 * file (`.tmp-...`) from ever being treated as an entity: it simply
 * doesn't match `isId`, whether or not `sweepStaleTempFiles` has run yet.
 * Returns ids sorted ascending, which for ULIDs is also chronological.
 */
export async function listEntityIds<Id extends string>(
  dir: string,
  isId: (value: string) => value is Id,
): Promise<Id[]> {
  const names = await readDirSafe(dir);
  const ids: Id[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonc")) continue;
    const base = name.slice(0, -".jsonc".length);
    if (isId(base)) ids.push(base);
  }
  return ids.sort();
}
