/**
 * Session entity CRUD over `<root>/.slop/db/sessions/session_<ulid>.jsonc`
 * (design.md §3).
 *
 * A4: `createSession`/`updateSession` are the repo layer's sanctioned
 * session-mutation entry points, and both REQUIRE an `EventContext` and a
 * `MutationEventSpec` (events.ts) — see tickets.ts's doc for the full
 * rationale, identical here. `deleteSession` is excluded from this for
 * the same reason `deleteTicket` is: no `session.deleted` verb exists,
 * and nothing in the v0 command surface deletes a session.
 */
import { join } from "node:path";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import {
  type Event,
  type Session,
  type SessionId,
  isSessionId,
  sessionSchema,
} from "../core/index.js";
import type { JsoncPatchEntry } from "../core/jsonc.js";
import {
  createEntityFileCanonical,
  deleteEntityFile,
  listEntityIds,
  readEntityFile,
  updateEntityFile,
} from "./entity-file.js";
import type { EventContext, MutationEventSpec } from "./events.js";
import { withMutationEvent } from "./events.js";
import type { RepoPaths } from "./paths.js";

export function sessionFilePath(paths: RepoPaths, id: SessionId): string {
  return join(paths.sessionsDir, `${id}.jsonc`);
}

export async function readSession(paths: RepoPaths, id: SessionId): Promise<Session> {
  return readEntityFile(sessionFilePath(paths, id), sessionSchema);
}

/**
 * Create a new session file, always canonical, AND emit exactly one event
 * describing it (A4, via `withMutationEvent`). `ctx`/`event` are
 * required — see events.ts's `EventContext`/`MutationEventSpec` docs.
 *
 * A caller mints the session's id (core/ids.ts's `newSessionId`) before
 * building the `Session` object and calling this — so `ctx.session` can
 * legitimately self-reference that same id: the event genuinely happens
 * "under" the session it's creating (e.g. `session.started`). See
 * sessions.test.ts / tests/acceptance/A4.test.ts for this pattern.
 */
export async function createSession(
  paths: RepoPaths,
  session: Session,
  ctx: EventContext,
  event: MutationEventSpec,
  clock: Clock = systemClock,
): Promise<Event> {
  return withMutationEvent(
    paths,
    ctx,
    { kind: "session", id: session.id },
    event,
    () => createEntityFileCanonical(sessionFilePath(paths, session.id), session),
    clock,
  );
}

/**
 * Update an existing session file (e.g. a plan revision, an end
 * summary), preserving human comments where possible, AND emit exactly
 * one event describing it (A4). `expectedAfter` is the full session the
 * patch is supposed to produce. `ctx`/`event` are required, same
 * rationale as `createSession`. If the underlying write fails, no event
 * is emitted; see events.ts's `withMutationEvent`.
 */
export async function updateSession(
  paths: RepoPaths,
  id: SessionId,
  patch: JsoncPatchEntry[],
  expectedAfter: Session,
  ctx: EventContext,
  event: MutationEventSpec,
  clock: Clock = systemClock,
): Promise<Event> {
  return withMutationEvent(
    paths,
    ctx,
    { kind: "session", id },
    event,
    () => updateEntityFile(sessionFilePath(paths, id), patch, expectedAfter),
    clock,
  );
}

/**
 * Delete a session file. NOT part of A4's emit-on-mutation guarantee —
 * see this module's doc for why.
 */
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

/** One session file `listSessionsTolerant` could not read — path, id, and
 * the exact high-quality error `readSession` would have thrown, captured
 * instead of propagated. Mirrors db-index.ts's `TicketReadProblem`. */
export interface SessionReadProblem {
  id: SessionId;
  path: string;
  message: string;
}

export interface ListSessionsTolerantResult {
  sessions: Session[];
  problems: SessionReadProblem[];
}

/**
 * Like {@link listSessions}, but never throws on a bad file — mirrors
 * tickets.ts's `listTicketsTolerant` (see that function's doc for the full
 * fault-tolerance rationale). Used by `sessions/repair.ts`'s orphaned
 * -active-session scan (ticket_01KYAPKRJ9RJRJRAV42WCTJET4, `slop reindex
 * --heal`'s repair path): one corrupt session file must not block
 * detecting/healing every other orphan.
 */
export async function listSessionsTolerant(paths: RepoPaths): Promise<ListSessionsTolerantResult> {
  const ids = await listSessionIds(paths);
  const settled = await Promise.allSettled(ids.map((id) => readSession(paths, id)));

  const sessions: Session[] = [];
  const problems: SessionReadProblem[] = [];
  for (let i = 0; i < settled.length; i++) {
    const id = ids[i];
    const outcome = settled[i];
    if (id === undefined || outcome === undefined) continue; // unreachable: settled/ids are the same length
    if (outcome.status === "fulfilled") {
      sessions.push(outcome.value);
    } else {
      const message =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      problems.push({ id, path: sessionFilePath(paths, id), message });
    }
  }
  return { sessions, problems };
}
