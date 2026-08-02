#!/usr/bin/env bun
import { newTicketId, ticketSchema } from "../../src/core/index.js";
import { createTicket, ensureDbDirs, withLock } from "../../src/repo/index.js";

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) throw new Error("usage: mutation-journal-kill-worker.ts <root>");

  const paths = await ensureDbDirs(root);
  const id = newTicketId();
  const now = "2026-08-02T12:00:00.000Z";
  const ticket = ticketSchema.parse({
    id,
    name: "Interrupted atomic mutation",
    slug: `interrupted-${id.slice(-8).toLowerCase()}`,
    spec: { summary: "Crash between the entity and event writes" },
    state: "open",
    root_id: id,
    provenance: {
      method: "new",
      created_by: { name: "kill-test", kind: "agent" },
    },
    last_activity_at: now,
    created_at: now,
    updated_at: now,
  });

  process.stdout.write(`${id}\n`);
  await withLock(paths.lockFile, () =>
    createTicket(
      paths,
      ticket,
      { actor: { name: "kill-test", kind: "agent" }, session: null },
      { verb: "ticket.created", payload: { interrupted: true } },
    ),
  );
}

await main();
