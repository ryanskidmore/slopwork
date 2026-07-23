import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configSchema,
  newSessionId,
  newTicketId,
  sessionSchema,
  ticketSchema,
} from "../core/index.js";
import type { Session, Ticket } from "../core/index.js";
import type { EventContext, MutationEventSpec, RepoPaths } from "../repo/index.js";
import { createSession, createTicket, ensureDbDirs } from "../repo/index.js";
import { buildContextPackData } from "./context-pack.js";

let scratch: string;
let paths: RepoPaths;

const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };
const startedEvent: MutationEventSpec = { verb: "session.started" };
const config = configSchema.parse({ project: "p" });

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: overrides.slug ?? `ticket-${id.slice(-10).toLowerCase()}`,
    spec: { summary: "s" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

function makeSession(ticket: Ticket, startedAt: string): Session {
  return sessionSchema.parse({
    id: newSessionId(),
    ticket: ticket.id,
    actor: { name: "an-agent", kind: "agent" },
    harness: { kind: "claude-code", session_id: null },
    git: { branch: "main", commit_at_start: "abc" },
    started_at: startedAt,
  });
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-context-pack-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("buildContextPackData", () => {
  it("gathers ancestors, blockers (live only), and sessions (most-recent-first) for a ticket", async () => {
    const parent = makeTicket({ name: "Parent" });
    await createTicket(paths, parent, ctx, createdEvent);

    const child = makeTicket({
      name: "Child",
      parent: parent.id,
      root_id: parent.id,
      path: [parent.id],
    });
    await createTicket(paths, child, ctx, createdEvent);

    const liveBlocker = makeTicket({
      name: "Live blocker",
      state: "in_progress",
      blocks: [child.id],
    });
    await createTicket(paths, liveBlocker, ctx, createdEvent);
    const doneBlocker = makeTicket({ name: "Done blocker", state: "done", blocks: [child.id] });
    await createTicket(paths, doneBlocker, ctx, createdEvent);

    const older = makeSession(child, "2026-07-23T09:00:00.000Z");
    const newer = makeSession(child, "2026-07-23T10:00:00.000Z");
    await createSession(paths, older, ctx, startedEvent);
    await createSession(paths, newer, ctx, startedEvent);

    const data = await buildContextPackData(paths, child, config);

    expect(data.ancestors.map((a) => a.id)).toEqual([parent.id]);
    expect(data.blockers.map((b) => b.id)).toEqual([liveBlocker.id]);
    expect(data.sessions.map((s) => s.id)).toEqual([newer.id, older.id]);
  });

  it("has no external parent ref when the root has none", async () => {
    const ticket = makeTicket();
    await createTicket(paths, ticket, ctx, createdEvent);
    const data = await buildContextPackData(paths, ticket, config);
    expect(data.externalParentRef).toBeUndefined();
  });

  it("surfaces the external parent ref from the local root", async () => {
    const ticket = makeTicket({ parent: "jira:PROJ-1" });
    await createTicket(paths, ticket, ctx, createdEvent);
    const data = await buildContextPackData(paths, ticket, config);
    expect(data.externalParentRef).toBe("jira:PROJ-1");
  });
});
