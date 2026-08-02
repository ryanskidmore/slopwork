import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Event, newEventId, newTicketId, ticketSchema } from "../../src/core/index.js";
import {
  createEntityFileCanonical,
  createTicket,
  ensureDbDirs,
  type EventContext,
  eventFilePath,
  type MutationEventSpec,
  type RepoPaths,
} from "../../src/repo/index.js";

// G2: pluggable storage backend (t-y2j03, t-an2d7, t-6tqw9, t-cloj2, t-k3krj)
//
// Every command already routes through `src/storage/`'s `StorageBackend`
// interface rather than `src/repo/*` directly (enforced by the
// import-boundary scan below) — the whole existing test suite passing is
// itself the bulk of "commands work against a flatfile repo through the
// interface"'s coverage. This file adds targeted, G2-specific coverage the
// rest of the suite doesn't: the remote-backend stub's error, sharded +
// flat event reads, the explicit `reindex --shard-events` migration, and
// config-driven lock timeout.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
  // Same "build if missing" convention as A1.test.ts / D1.test.ts / D3.test.ts / D5.test.ts.
  if (!existsSync(binaryPath)) {
    execFileSync("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  }
  if (!existsSync(binaryPath)) {
    throw new Error(
      `${binaryPath} is still missing after attempting "bun run build". ` +
        'Run "bun run build" manually and re-run the tests.',
    );
  }
}, 120_000);

const scratchDirs: string[] = [];

afterAll(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function runSlop(args: string[], cwd: string) {
  return spawnSync(binaryPath, args, { cwd, encoding: "utf8", env: { ...process.env } });
}

/** Bare `.slop/db/` (via `ensureDbDirs`, no `slop init`) plus a hand-written
 * `config.yaml` — `extraConfigLines` is appended verbatim after `defaults:`'s
 * block so a test can add `backend:`/a custom `lock_timeout` without
 * `stringifyConfigYaml`'s narrower, `slop init`-only shape (it doesn't know
 * about either field — see core/config-yaml.ts's own doc). */
async function makeScratchRepo(
  prefix: string,
  opts: { lockTimeout?: string; backendLines?: string[] } = {},
): Promise<RepoPaths> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  const paths = await ensureDbDirs(dir);
  const lines = [
    "project: g2-fixture",
    "user: g2-tester",
    "remotes:",
    "defaults:",
    "  stale_after: 60m",
    "  review_stale_after: 24h",
    ...(opts.lockTimeout !== undefined ? [`  lock_timeout: ${opts.lockTimeout}`] : []),
    ...(opts.backendLines ?? []),
    "",
  ];
  writeFileSync(join(paths.slopDir, "config.yaml"), lines.join("\n"), "utf8");
  return paths;
}

const ctx: EventContext = { actor: { name: "g2-tester", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };

function makeTicket(name: string) {
  const id = newTicketId();
  return ticketSchema.parse({
    id,
    name,
    slug: `ticket-${id.slice(-10).toLowerCase()}`,
    spec: { summary: name },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "g2-tester", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
  });
}

/** Hand-write an event directly at its FLAT location (bypassing
 * `appendEvent`/`createEvent`, which always shard now) — simulates an
 * event that predates G2's sharding, or was deliberately never migrated.
 * `at` defaults to deliberately OLD (proves month-shard placement is by
 * the event's own id, not by `at` or read order) — pass a recent one
 * explicitly for a test that needs this event to win
 * `deriveEffectiveOverlay`'s `event.at >= ticket.last_activity_at` gate
 * (`src/tickets/overlay.ts`). */
async function writeFlatEvent(
  paths: RepoPaths,
  ticketId: string,
  note: string,
  at = "2020-01-01T00:00:00.000Z",
): Promise<Event> {
  const event: Event = {
    id: newEventId(),
    actor: ctx.actor,
    session: null,
    verb: "ticket.updated",
    entity: { kind: "ticket", id: ticketId as never },
    payload: { progress: note },
    at,
  };
  await createEntityFileCanonical(eventFilePath(paths, event.id), event);
  return event;
}

// ---------------------------------------------------------------------------
// Import-boundary scan: commands + the web data source go through
// StorageBackend only (backend.ts's own doc: "nothing outside src/storage/
// and the driver's own internals may import flatfile modules directly").
// ---------------------------------------------------------------------------

describe("G2: pluggable storage backend", () => {
  describe("import boundary: commands + web data source never call flatfile data-access functions directly", () => {
    // The exact data-access primitives StorageBackend methods now wrap —
    // if any of these are imported by name from a `repo/*` module in the
    // scanned files, something bypassed the interface.
    const FORBIDDEN_NAMES = [
      "readTicket",
      "listTickets",
      "listTicketsTolerant",
      "createTicket",
      "updateTicket",
      "readSession",
      "listSessions",
      "listSessionsTolerant",
      "createSession",
      "updateSession",
      "readEvent",
      "appendEvent",
      "queryEvents",
      "listEvents",
      "listEventsTolerant",
      "createEvent",
      "resolveTicketRef",
      "resolveTicketRefs",
      "loadIndex",
      "rebuildIndex",
      "withLock",
      "sweepStaleTempFiles",
      "ticketFilePath",
      "sessionFilePath",
    ];
    // A handful of pure/bootstrap exports legitimately still come from the
    // repo barrel — path/root discovery (`repoPaths`/`requireRepoRoot`/
    // `findRepoRoot`/`ensureDbDirs`, which has to run BEFORE a backend can
    // even be constructed), the low-level `atomicWriteFile` primitive
    // (`edit.ts`'s own documented exception, for $EDITOR rescue/rollback of
    // raw file bytes), and pure derived-value helpers with no I/O of their
    // own (`deriveEffectiveOverlay`, the `RepoPaths` type). None of these
    // names appear in FORBIDDEN_NAMES above.

    async function scanFile(path: string): Promise<string[]> {
      const text = await readFile(path, "utf8");
      const violations: string[] = [];
      // Matches `import {A, B} from "...repo/xyz.js"` / `import type {A} from "..."`
      // across both single- and multi-line brace lists.
      const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']*\/repo\/[^"']*)["']/g;
      for (const match of text.matchAll(importRe)) {
        const names = (match[1] ?? "").split(",").map((n) =>
          n
            .trim()
            .split(/\s+as\s+/)[0]
            ?.trim(),
        );
        for (const name of names) {
          if (name && FORBIDDEN_NAMES.includes(name)) {
            violations.push(`${path} imports "${name}" from "${match[2]}"`);
          }
        }
      }
      return violations;
    }

    async function scanDir(dir: string, exempt: Set<string>): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const violations: string[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        if (entry.name.endsWith(".test.ts")) continue; // tests legitimately reach into repo/ for scaffolding
        if (exempt.has(entry.name)) continue;
        violations.push(...(await scanFile(join(dir, entry.name))));
      }
      return violations;
    }

    it("no src/cli/commands/*.ts imports a flatfile data-access function directly", async () => {
      const violations = await scanDir(join(repoRoot, "src", "cli", "commands"), new Set());
      expect(violations).toEqual([]);
    });

    it("no src/web/*.ts imports a flatfile data-access function directly (except the deliberate fixture exception)", async () => {
      // fixture-data-source.ts is the one documented exception (its own
      // module doc): a fixture-only WebDataSource that reads plain fs
      // directly for tests, never wired into the real `slop web` path
      // (storage-data-source.ts is). It doesn't import repo/ at all today,
      // but it's exempted by name here so this test's contract is about
      // the REAL path (storage-data-source.ts, server.ts, api/*, views),
      // not an accidental side effect of what fixture-data-source.ts
      // happens not to import right now.
      const violations = await scanDir(
        join(repoRoot, "src", "web"),
        new Set(["fixture-data-source.ts"]),
      );
      expect(violations).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Commands work against a flatfile repo through the interface (smoke —
  // the rest of the suite, all now routed through StorageBackend per the
  // scan above, is the exhaustive coverage).
  // -------------------------------------------------------------------------

  describe("flatfile backend (default): full create -> read -> mutate -> close loop", () => {
    it("new -> show -> update -> start -> done all succeed with no backend: key set", async () => {
      const paths = await makeScratchRepo("slop-g2-flatfile-");

      const created = runSlop(["new", "G2 flatfile smoke", "--json"], paths.root);
      expect(created.status, created.stderr).toBe(0);
      const ticket = JSON.parse(created.stdout) as { id: string; slug: string };

      const shown = runSlop(["show", ticket.id, "--json"], paths.root);
      expect(shown.status, shown.stderr).toBe(0);

      const updated = runSlop(["update", ticket.id, "--priority", "0", "--json"], paths.root);
      expect(updated.status, updated.stderr).toBe(0);

      const started = runSlop(["start", ticket.id, "--json"], paths.root);
      expect(started.status, started.stderr).toBe(0);

      const done = runSlop(["done", ticket.id, "--json"], paths.root);
      expect(done.status, done.stderr).toBe(0);
      const doneBody = JSON.parse(done.stdout) as { ticket: { state: string } };
      expect(doneBody.ticket.state).toBe("done");
    });

    it("backend: flatfile (explicit) behaves identically to the key being absent", async () => {
      const paths = await makeScratchRepo("slop-g2-flatfile-explicit-", {
        backendLines: ["backend: flatfile"],
      });
      const result = runSlop(["new", "Explicit flatfile", "--json"], paths.root);
      expect(result.status, result.stderr).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // backend: {kind: remote, ...} produces the clear stub error
  // -------------------------------------------------------------------------

  describe("remote backend stub", () => {
    it("a read-only command fails with a clear, non-crashing error naming docs/storage-backends.md", async () => {
      const paths = await makeScratchRepo("slop-g2-remote-", {
        backendLines: ["backend:", "  kind: remote", "  url: https://slop.example.test"],
      });
      const result = runSlop(["show", "anything"], paths.root);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/remote backend not implemented/i);
      expect(result.stderr).toMatch(/docs\/storage-backends\.md/i);
      expect(result.stderr).toMatch(/slop\.example\.test/);
    });

    it("a mutating command fails the same way, before any write lands", async () => {
      const paths = await makeScratchRepo("slop-g2-remote-mutate-", {
        backendLines: ["backend: remote"],
      });
      const result = runSlop(["new", "Should never be created"], paths.root);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/remote backend not implemented/i);
      // Bare `backend: remote` (no url) — the error still names the
      // absence clearly rather than printing "undefined".
      expect(result.stderr).toMatch(/no url configured/i);

      // Nothing was ever created — no tickets dir entries at all.
      const ticketFiles = await readdir(paths.ticketsDir).catch(() => []);
      expect(ticketFiles).toEqual([]);
    });

    it("reindex also fails cleanly against a remote backend, never a crash", async () => {
      const paths = await makeScratchRepo("slop-g2-remote-reindex-", {
        backendLines: ["backend: remote"],
      });
      const result = runSlop(["reindex"], paths.root);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/remote backend not implemented/i);
    });

    it("slop edit refuses cleanly against a remote backend (no local file to edit)", async () => {
      const paths = await makeScratchRepo("slop-g2-remote-edit-", {
        backendLines: ["backend: remote"],
      });
      const result = runSlop(["edit", "anything"], paths.root);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/local file access/i);
      expect(result.stderr).toMatch(/slop update/i);
    });
  });

  // -------------------------------------------------------------------------
  // Sharded + flat event layouts both read transparently
  // -------------------------------------------------------------------------

  describe("event storage: flat and sharded layouts both read", () => {
    it("slop events sees a hand-placed FLAT event alongside a normally-sharded one", async () => {
      const paths = await makeScratchRepo("slop-g2-mixed-events-");
      const ticket = makeTicket("Mixed event layout");
      // createTicket's own accompanying `ticket.created` event always
      // shards now (src/repo/events.ts's createEvent).
      await createTicket(paths, ticket, ctx, createdEvent);
      const flatEvent = await writeFlatEvent(paths, ticket.id, "a note living in the flat layout");

      // Confirm the fixture actually IS mixed before asserting on the read
      // path: one shard dir (from createTicket's event) and the flat file
      // sitting directly in events/.
      const shardDirs = (await readdir(paths.eventsDir, { withFileTypes: true })).filter((e) =>
        e.isDirectory(),
      );
      expect(shardDirs.length).toBeGreaterThanOrEqual(1);
      expect(existsSync(eventFilePath(paths, flatEvent.id))).toBe(true);

      const result = runSlop(["events", "--json", "--limit", "50"], paths.root);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as { events: Array<{ id: string }> };
      const ids = body.events.map((e) => e.id);
      expect(ids).toContain(flatEvent.id);
      expect(ids.length).toBeGreaterThanOrEqual(2);
      // Cursor order is ascending id (ULID = chronological by mint time,
      // not by the `at` field a caller could set to anything) — the flat
      // event's `at` is backdated to 2020 but its ID was minted AFTER the
      // ticket's, so it must still sort after it.
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    });

    it("slop show --json folds a flat event's progress note into the effective ticket, same as a sharded one", async () => {
      const paths = await makeScratchRepo("slop-g2-flat-progress-");
      const ticket = makeTicket("Flat progress note");
      await createTicket(paths, ticket, ctx, createdEvent);
      await writeFlatEvent(
        paths,
        ticket.id,
        "flat-layout progress note",
        new Date(Date.now() + 60_000).toISOString(), // after the ticket's own last_activity_at
      );

      const shown = runSlop(["show", ticket.id, "--json"], paths.root);
      expect(shown.status, shown.stderr).toBe(0);
      const body = JSON.parse(shown.stdout) as { ticket: { latest_note: string | null } };
      expect(body.ticket.latest_note).toBe("flat-layout progress note");
    });
  });

  // -------------------------------------------------------------------------
  // Explicit reindex migration shards a flat layout
  // -------------------------------------------------------------------------

  describe("slop reindex --shard-events", () => {
    it("migrates a fully-flat event layout into month shards, idempotently", async () => {
      const paths = await makeScratchRepo("slop-g2-shard-migrate-");
      const ticket = makeTicket("Migration target");
      // Build every event flat by hand — never through createTicket (which
      // would shard the accompanying event immediately).
      await createEntityFileCanonical(join(paths.ticketsDir, `${ticket.id}.jsonc`), ticket).catch(
        () => undefined,
      );
      const e1 = await writeFlatEvent(paths, ticket.id, "note one");
      const e2 = await writeFlatEvent(paths, ticket.id, "note two");

      // Nothing shards on an ordinary reindex without the flag.
      const plain = runSlop(["reindex"], paths.root);
      expect(plain.status, plain.stderr).toBe(0);
      expect(existsSync(eventFilePath(paths, e1.id))).toBe(true);
      expect(existsSync(eventFilePath(paths, e2.id))).toBe(true);

      const migrated = runSlop(["reindex", "--shard-events"], paths.root);
      expect(migrated.status, migrated.stderr).toBe(0);
      expect(migrated.stdout).toMatch(/migrated 2 event\(s\) into \d+ shard\(s\)/);

      // Flat files are gone; the events now live under a YYYY-MM shard.
      expect(existsSync(eventFilePath(paths, e1.id))).toBe(false);
      expect(existsSync(eventFilePath(paths, e2.id))).toBe(false);
      const shardDirs = (await readdir(paths.eventsDir, { withFileTypes: true })).filter((e) =>
        e.isDirectory(),
      );
      expect(shardDirs.length).toBeGreaterThanOrEqual(1);

      // Reading still works identically post-migration.
      const events = runSlop(["events", "--json"], paths.root);
      expect(events.status, events.stderr).toBe(0);
      const body = JSON.parse(events.stdout) as { events: Array<{ id: string }> };
      expect(body.events.map((e) => e.id).sort()).toEqual([e1.id, e2.id].sort());

      // Idempotent: running again moves nothing.
      const again = runSlop(["reindex", "--shard-events"], paths.root);
      expect(again.status, again.stderr).toBe(0);
      expect(again.stdout).toMatch(/no flat-layout events to shard/i);
    });

    it("never runs implicitly — a plain reindex leaves a flat layout flat", async () => {
      const paths = await makeScratchRepo("slop-g2-no-implicit-shard-");
      const ticket = makeTicket("Stays flat");
      await createEntityFileCanonical(join(paths.ticketsDir, `${ticket.id}.jsonc`), ticket);
      const flat = await writeFlatEvent(paths, ticket.id, "stays flat");

      for (const args of [["reindex"], ["reindex", "--heal"], ["reindex", "--strict"]]) {
        const result = runSlop(args, paths.root);
        expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      }
      expect(existsSync(eventFilePath(paths, flat.id))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Lock timeout honored from config.yaml's defaults.lock_timeout
  // -------------------------------------------------------------------------

  describe("defaults.lock_timeout", () => {
    it("a short configured timeout is honored — a mutating command gives up in well under the 5s default", async () => {
      const paths = await makeScratchRepo("slop-g2-lock-timeout-", { lockTimeout: "300ms" });
      const created = runSlop(["new", "Lock timeout target", "--json"], paths.root);
      expect(created.status, created.stderr).toBe(0);
      const ticket = JSON.parse(created.stdout) as { id: string };

      // Hold the lock with THIS test process's own (genuinely live) pid,
      // freshly timestamped — a live, non-stale holder that will never be
      // broken as stale, so the contender below can only ever time out.
      mkdirSync(paths.dbDir, { recursive: true });
      writeFileSync(
        paths.lockFile,
        `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );

      const startedAt = Date.now();
      const result = runSlop(["update", ticket.id, "--priority", "0"], paths.root);
      const elapsedMs = Date.now() - startedAt;

      expect(result.status).toBe(6); // CONFLICT
      expect(result.stderr).toMatch(/timed out waiting for the db lock/i);
      // Comfortably under the 5s DEFAULT — proves the 300ms CONFIGURED
      // value was actually the one honored, not the hardcoded default.
      expect(elapsedMs).toBeLessThan(3_000);
    });
  });
});
