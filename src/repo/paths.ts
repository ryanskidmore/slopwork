/**
 * Locating `.slop/` and the flatfile db layout it contains (design.md §3):
 *
 * ```
 * <root>/.slop/db/tickets/ticket_<ulid>.jsonc
 * <root>/.slop/db/sessions/session_<ulid>.jsonc
 * <root>/.slop/db/events/event_<ulid>.jsonc
 * <root>/.slop/db/index.jsonc   (derived, gitignored — see db-index.ts)
 * <root>/.slop/db/.lock          (multi-file transactions — see lock.ts)
 * ```
 *
 * `slop init` itself (config.yaml, AGENTS.md, gitignore entries) is D1's
 * job. This module only supplies what A3 needs and what D1 will call:
 * finding an existing repo root (`findRepoRoot`/`requireRepoRoot`, walking
 * up from cwd like git does) and creating the bare db directory skeleton
 * (`ensureDbDirs`).
 */
import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EXIT_CODES } from "../core/exit-codes.js";
import { SlopError } from "../cli/errors.js";

export interface RepoPaths {
  /** The directory containing `.slop/` — not `.slop/` itself. */
  root: string;
  slopDir: string;
  dbDir: string;
  ticketsDir: string;
  sessionsDir: string;
  eventsDir: string;
  /** Derived, gitignored (D14) — see db-index.ts. */
  indexFile: string;
  /** Multi-file transaction lock (design.md §3) — see lock.ts. */
  lockFile: string;
}

export function repoPaths(root: string): RepoPaths {
  const absoluteRoot = resolve(root);
  const slopDir = join(absoluteRoot, ".slop");
  const dbDir = join(slopDir, "db");
  return {
    root: absoluteRoot,
    slopDir,
    dbDir,
    ticketsDir: join(dbDir, "tickets"),
    sessionsDir: join(dbDir, "sessions"),
    eventsDir: join(dbDir, "events"),
    indexFile: join(dbDir, "index.jsonc"),
    lockFile: join(dbDir, ".lock"),
  };
}

function hasSlopDir(dir: string): boolean {
  try {
    return statSync(join(dir, ".slop")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk up from `startDir` looking for a `.slop/` directory, the same way
 * `git` walks up looking for `.git/`. Returns the repo root (the directory
 * *containing* `.slop/`), or `null` if none is found before the
 * filesystem root.
 */
export function findRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (hasSlopDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/**
 * {@link findRepoRoot}, but throws the scope-item-6 "not a slopworks
 * repo" error (exit 4, NOT_FOUND) instead of returning `null`.
 */
export function requireRepoRoot(startDir: string): string {
  const root = findRepoRoot(startDir);
  if (root === null) {
    throw new SlopError(
      "not a slopworks repo (no .slop/ found in this or any parent directory) — run `slop init`",
      EXIT_CODES.NOT_FOUND,
    );
  }
  return root;
}

/**
 * The directory-creation primitive D1's `init` command calls. Creates the
 * bare `tickets/`, `sessions/`, `events/` skeleton under `<root>/.slop/db`
 * (idempotent — safe to call against an already-initialized repo).
 * Does *not* write `config.yaml`, `AGENTS.md`, or gitignore entries — that
 * ceremony belongs to D1, not A3.
 */
export async function ensureDbDirs(root: string): Promise<RepoPaths> {
  const paths = repoPaths(root);
  await mkdir(paths.ticketsDir, { recursive: true });
  await mkdir(paths.sessionsDir, { recursive: true });
  await mkdir(paths.eventsDir, { recursive: true });
  return paths;
}
