import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Ticket, newTicketId, ticketSchema } from "../../core/index.js";
import type { EventContext, MutationEventSpec } from "../../repo/events.js";
import { createTicket, ensureDbDirs, ticketFilePath } from "../../repo/index.js";
import type { RepoPaths } from "../../repo/index.js";
import { captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { runReindex } from "./reindex.js";

// A4: createTicket requires an EventContext + a MutationEventSpec —
// these fixtures don't exercise event behavior.
const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };

// src/cli/commands/reindex.test.ts -> ../../.. -> repo root -> src/cli/index.ts
const cliEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "Ticket",
    slug: `ticket-${id.slice(-8).toLowerCase()}`,
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

function spawnReindex(cwd: string, args: string[] = []): SpawnSyncReturns<string> {
  return spawnSync("bun", [cliEntry, "reindex", ...args], { cwd, encoding: "utf8" });
}

let scratch: string;
let paths: RepoPaths;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-reindex-cmd-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// `slop reindex` — the recovery path for a corrupt db. Adversarial-review
// Finding 3: a single unreadable ticket file used to make this exact
// command throw, disabling the recovery path in precisely the situation
// it exists for. These tests exercise the real compiled-from-source CLI
// (spawned via `bun`, same convention as tests/acceptance/A1.test.ts's
// compiled-binary tests), not the action function in isolation, so the
// exit code / stdout / stderr contract is verified end to end.
describe("slop reindex — fault tolerance (adversarial-review Finding 3)", () => {
  it("with no corrupt files: rebuilds cleanly, prints a summary, and exits 0", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);

    const { status, stdout, stderr } = spawnReindex(scratch);
    expect(status).toBe(0);
    expect(stdout).toContain("reindexed: 1 ticket(s)");
    expect(stderr).toBe("");
  });

  it("one corrupt ticket among several: rebuilds the good ones, reports the bad one actionably, exits 1", async () => {
    const good1 = makeTicket();
    const good2 = makeTicket();
    await createTicket(paths, good1, ctx, createdEvent);
    await createTicket(paths, good2, ctx, createdEvent);
    const badId = newTicketId();
    const badPath = ticketFilePath(paths, badId);
    await writeFile(badPath, '{ "id": "not even close to valid" }');

    const { status, stdout, stderr } = spawnReindex(scratch);

    expect(status).toBe(1);
    expect(stdout).toContain("2 ticket(s) rebuilt");
    expect(stdout).toContain("1 skipped due to errors");
    expect(stderr).toContain(badPath);
    // Actionable — the underlying error detail survived, not just the path.
    expect(stderr.length).toBeGreaterThan(badPath.length + 20);

    // Best-effort persisted: the good tickets are actually in the
    // rebuilt index.jsonc's `tickets` rows on disk, not just reported in
    // stdout. The bad id legitimately DOES appear elsewhere in the file
    // (the persisted `problems` list, by design — see db-index.ts) so
    // this checks the `tickets` rows specifically, not a raw substring
    // match over the whole file.
    const onDiskIndex = JSON.parse(await readFile(paths.indexFile, "utf8")) as {
      tickets: { id: string }[];
      problems: { id: string }[];
    };
    const rebuiltIds = onDiskIndex.tickets.map((t) => t.id).sort();
    expect(rebuiltIds).toEqual([good1.id, good2.id].sort());
    expect(onDiskIndex.problems.map((p) => p.id)).toEqual([badId]);
  });

  it("several corrupt tickets: every one is reported in the same pass, not just the first", async () => {
    const good = makeTicket();
    await createTicket(paths, good, ctx, createdEvent);
    const bad1 = newTicketId();
    const bad2 = newTicketId();
    await writeFile(ticketFilePath(paths, bad1), "{ not even valid jsonc {{{");
    await writeFile(ticketFilePath(paths, bad2), '{ "id": "still not valid" }');

    const { status, stdout, stderr } = spawnReindex(scratch);

    expect(status).toBe(1);
    expect(stderr).toContain(ticketFilePath(paths, bad1));
    expect(stderr).toContain(ticketFilePath(paths, bad2));
    expect(stdout).toContain("2 skipped due to errors");
  });

  it("--strict fails fast on the first bad file, exits non-zero, and leaves index.jsonc untouched", async () => {
    const good = makeTicket();
    await createTicket(paths, good, ctx, createdEvent);
    const badId = newTicketId();
    await writeFile(ticketFilePath(paths, badId), "{ not even valid jsonc {{{");

    const before = await readFile(paths.indexFile, "utf8").catch(() => null);
    expect(before).toBeNull(); // never built yet

    const { status, stderr } = spawnReindex(scratch, ["--strict"]);

    expect(status).not.toBe(0);
    expect(stderr).toContain(ticketFilePath(paths, badId));

    // Strict mode aborts before ever writing an index.
    const after = await readFile(paths.indexFile, "utf8").catch(() => null);
    expect(after).toBeNull();
  });

  it("--strict succeeds normally (exit 0) when nothing is corrupt", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);

    const { status, stdout } = spawnReindex(scratch, ["--strict"]);
    expect(status).toBe(0);
    expect(stdout).toContain("reindexed: 1 ticket(s)");
  });
});

// ---------------------------------------------------------------------------
// In-process coverage of `runReindex` itself (real v8 coverage, no
// subprocess) — same scenarios as the spawned suite above, driven directly
// against a temp repo via withCwd/captureOutput (tests/support/cli-harness.ts).
// ---------------------------------------------------------------------------
describe("runReindex (in-process)", () => {
  it("rebuilds cleanly and prints a summary when nothing is corrupt", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);

    const out = captureOutput();
    try {
      await withCwd(scratch, () => runReindex({}));
      expect(out.stdout()).toContain("reindexed: 1 ticket(s)");
      expect(out.stderr()).toBe("");
    } finally {
      out.restore();
    }
  });

  it("throws a SlopError (GENERIC_ERROR) and still rebuilds the good tickets when one is corrupt", async () => {
    const good = makeTicket();
    await createTicket(paths, good, ctx, createdEvent);
    const badId = newTicketId();
    const badPath = ticketFilePath(paths, badId);
    await writeFile(badPath, '{ "id": "not even close to valid" }');

    const out = captureOutput();
    try {
      await expect(withCwd(scratch, () => runReindex({}))).rejects.toThrow(/unreadable ticket/i);
      expect(out.stdout()).toContain("1 ticket(s) rebuilt");
      expect(out.stdout()).toContain("1 skipped due to errors");
      expect(out.stderr()).toContain(badPath);
    } finally {
      out.restore();
    }

    const onDiskIndex = JSON.parse(await readFile(paths.indexFile, "utf8")) as {
      tickets: { id: string }[];
    };
    expect(onDiskIndex.tickets.map((t) => t.id)).toEqual([good.id]);
  });

  it("--strict (options.strict) fails fast and never writes index.jsonc", async () => {
    const badId = newTicketId();
    await writeFile(ticketFilePath(paths, badId), "{ not even valid jsonc {{{");

    const out = captureOutput();
    try {
      await expect(withCwd(scratch, () => runReindex({ strict: true }))).rejects.toThrow();
    } finally {
      out.restore();
    }

    const after = await readFile(paths.indexFile, "utf8").catch(() => null);
    expect(after).toBeNull();
  });

  it("reports swept stale temp files in the summary line", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    // A leftover temp file matching atomic-write.ts's naming convention
    // (`.tmp-<random>-<target-basename>`), backdated well past
    // DEFAULT_SWEEP_MIN_AGE_MS (60s) so sweepStaleTempFiles treats it as
    // stale rather than "another process might still be writing this".
    const staleTemp = join(paths.ticketsDir, `.tmp-deadbeef-${t.id}.jsonc`);
    await writeFile(staleTemp, "leftover");
    const old = new Date(Date.now() - 120_000);
    await utimes(staleTemp, old, old);

    const out = captureOutput();
    try {
      await withCwd(scratch, () => runReindex({}));
      expect(out.stdout()).toMatch(/swept 1 stale temp file/);
    } finally {
      out.restore();
    }
  });
});
