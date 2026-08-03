/**
 * Small filesystem helpers shared across the repo layer (A3). None of
 * atomic-write.ts / entity-file.ts / paths.ts / lock.ts owns these
 * outright, so they live here instead of being duplicated four times.
 */
import { readdir } from "node:fs/promises";

/**
 * The `code` off a thrown Node/Bun fs error, or `undefined` if `err` isn't
 * shaped like one. Written against `unknown` rather than
 * `NodeJS.ErrnoException` so callers don't need to cast at every call
 * site.
 */
export function errorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export function isEnoent(err: unknown): boolean {
  return errorCode(err) === "ENOENT";
}

export function isEexist(err: unknown): boolean {
  return errorCode(err) === "EEXIST";
}

/** Directory non-empty — used by a best-effort `rmdir` (t-7eq5s's shard
 * -directory cleanup after compaction) to tell "someone else already
 * removed it or landed a new file in it, harmless race" apart from a real
 * failure. */
export function isEnotempty(err: unknown): boolean {
  return errorCode(err) === "ENOTEMPTY";
}

/** `readdir`, but a missing directory reads as empty rather than throwing. */
export async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}
