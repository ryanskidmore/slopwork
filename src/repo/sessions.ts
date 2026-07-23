/**
 * Session entity CRUD over `<root>/.slop/db/sessions/session_<ulid>.jsonc`
 * (design.md §3).
 */
import { join } from "node:path";
import type { JsoncPatchEntry } from "../core/jsonc.js";
import { type Session, type SessionId, isSessionId, sessionSchema } from "../core/index.js";
import {
  createEntityFileCanonical,
  deleteEntityFile,
  listEntityIds,
  readEntityFile,
  updateEntityFile,
} from "./entity-file.js";
import type { RepoPaths } from "./paths.js";

export function sessionFilePath(paths: RepoPaths, id: SessionId): string {
  return join(paths.sessionsDir, `${id}.jsonc`);
}

export async function readSession(paths: RepoPaths, id: SessionId): Promise<Session> {
  return readEntityFile(sessionFilePath(paths, id), sessionSchema);
}

/** New session file. Always canonical — see entity-file.ts's doc. */
export async function createSession(paths: RepoPaths, session: Session): Promise<void> {
  await createEntityFileCanonical(sessionFilePath(paths, session.id), session);
}

/**
 * Update an existing session file (e.g. a plan revision, an end
 * summary), preserving human comments where possible. `expectedAfter` is
 * the full session the patch is supposed to produce.
 */
export async function updateSession(
  paths: RepoPaths,
  id: SessionId,
  patch: JsoncPatchEntry[],
  expectedAfter: Session,
): Promise<void> {
  await updateEntityFile(sessionFilePath(paths, id), patch, expectedAfter);
}

export async function deleteSession(paths: RepoPaths, id: SessionId): Promise<void> {
  await deleteEntityFile(sessionFilePath(paths, id));
}

export async function listSessionIds(paths: RepoPaths): Promise<SessionId[]> {
  return listEntityIds(paths.sessionsDir, isSessionId);
}

/** Every session on disk, read and validated (see tickets.ts's listTickets for the fail-fast rationale). */
export async function listSessions(paths: RepoPaths): Promise<Session[]> {
  const ids = await listSessionIds(paths);
  return Promise.all(ids.map((id) => readSession(paths, id)));
}
