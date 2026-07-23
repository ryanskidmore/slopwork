#!/usr/bin/env bun
/**
 * Child-process worker for tests/acceptance/A3.test.ts's real kill -9
 * test. Not a test file itself (doesn't match `*.test.ts`) — spawned via
 * `Bun.spawn`, same convention as tests/acceptance/a2-arbitraries.ts being
 * a non-test helper module alongside A2.test.ts.
 *
 * Writes `count` tickets to the db at `dbRoot` in a tight loop via the
 * real repo-layer `createTicket`, printing "wrote <i>" after each
 * successful (fully renamed) write so the parent can see how far a run
 * got before being SIGKILLed. `SLOP_TEST_ATOMIC_WRITE_DELAY_MS` (read by
 * atomic-write.ts itself, set by the parent test) widens the crash
 * window between fsyncing a ticket's temp file and renaming it over the
 * target, so a randomised kill delay reliably lands inside a write at
 * least some of the time across many repeated runs.
 */
import { newTicketId, ticketSchema } from "../../src/core/index.js";
import { createTicket, ensureDbDirs, repoPaths } from "../../src/repo/index.js";

async function main(): Promise<void> {
  const dbRoot = process.argv[2];
  const count = Number(process.argv[3] ?? "25");
  if (!dbRoot) {
    throw new Error("usage: a3-kill-worker.ts <dbRoot> <count>");
  }

  const paths = repoPaths(dbRoot);
  await ensureDbDirs(dbRoot);
  process.stdout.write("ready\n");

  for (let i = 0; i < count; i++) {
    const id = newTicketId();
    const now = new Date().toISOString();
    const ticket = ticketSchema.parse({
      id,
      name: `Kill test ticket ${i}`,
      slug: `kill-test-ticket-${i}`,
      spec: { summary: `iteration ${i}` },
      state: "open",
      root_id: id,
      provenance: { method: "adhoc", created_by: { name: "kill-test", kind: "agent" } },
      last_activity_at: now,
      created_at: now,
      updated_at: now,
    });
    await createTicket(paths, ticket);
    process.stdout.write(`wrote ${i}\n`);
  }

  process.stdout.write("done\n");
}

await main();
