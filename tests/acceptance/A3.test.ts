import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type Ticket,
  isTicketId,
  newTicketId,
  parseJsonc,
  ticketSchema,
  writeCanonical,
} from "../../src/core/index.js";
import {
  INDEX_SCHEMA_VERSION,
  createTicket,
  ensureDbDirs,
  isTempFileName,
  loadIndex,
  resolveTicketRef,
  sweepStaleTempFiles,
  ticketFilePath,
} from "../../src/repo/index.js";
import type { EventContext, MutationEventSpec } from "../../src/repo/index.js";

// A4 changed createTicket/updateTicket/createSession/updateSession to
// require an EventContext + a MutationEventSpec on every call (repo/
// events.ts) — these fixtures don't exercise event behavior, so a single
// fixed pair is reused across every createTicket call in this file. A3's
// own acceptance criteria (kill -9 safety, ambiguous-ref resolution,
// index self-heal) are otherwise untouched.
const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };

// A3: Flatfile repo layer
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "Kill -9 mid-write leaves no corrupt files; ambiguous prefix errors
//   git-style; deleted index self-heals"
//
// This file tests all three clauses for real: (1) a genuine child process
// (the `bun` binary, running tests/acceptance/a3-kill-worker.ts — spawned
// with node:child_process's `spawn`, not `Bun.spawn`: vitest's own test
// files run under a plain Node worker in this project's setup, verified
// empirically to have neither a `Bun` global nor a resolvable `"bun"`
// module, so `Bun.spawn` isn't callable from *this* process; `spawn`ing
// the real `bun` binary as a genuine OS child process and SIGKILLing it
// satisfies the same substantive requirement) writing entities in a tight
// loop and SIGKILLed at a randomised point across 20+ repeated runs, with
// an explicit assertion that at least some runs genuinely landed inside a
// write rather than vacuously killing an idle process; (2) ref
// resolution's ambiguous-prefix error, not-found path, and
// slug-wins-over-prefix precedence; (3) index auto-heal against a
// missing, corrupt/truncated, stale-schema-version, AND stale-content
// (entity files changed on disk with no `slop` command involved at all —
// a `git merge`/`git pull`/`$EDITOR` hand-edit — since index.jsonc is
// gitignored (D14) and therefore never merged, this is the routine case,
// not an edge case; see db-index.ts's "Content staleness" for the
// coordinator ruling behind this) index.jsonc.

const workerPath = join(dirname(fileURLToPath(import.meta.url)), "a3-kill-worker.ts");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

describe("A3: Flatfile repo layer", () => {
  describe('"Kill -9 mid-write leaves no corrupt files"', () => {
    const COUNT_PER_RUN = 20;
    const ITERATIONS = 24;
    const INJECTED_DELAY_MS = 15;

    function spawnWorker(dbRoot: string): ChildProcess {
      return spawn("bun", [workerPath, dbRoot, String(COUNT_PER_RUN)], {
        env: { ...process.env, SLOP_TEST_ATOMIC_WRITE_DELAY_MS: String(INJECTED_DELAY_MS) },
        stdio: "ignore",
      });
    }

    function waitForExit(child: ChildProcess): Promise<void> {
      return new Promise((resolve, reject) => {
        child.once("exit", () => resolve());
        child.once("error", reject);
      });
    }

    /** Run the worker to completion (uninterrupted) a few times and time
     * it, so kill delays in the real test are calibrated against THIS
     * environment's actual loop duration rather than a guessed constant
     * that could be too short (never lands inside a write) or too long
     * (always kills an already-finished process) on a faster/slower
     * machine. Takes the MAX of several samples, not the average or a
     * single sample — a single run is an unreliable estimate (process
     * -spawn/scheduling jitter can make one sample run unusually fast),
     * and underestimating is what causes flakiness (a kill-delay upper
     * bound below the *real* typical completion time means "let it
     * finish naturally" almost never happens, so the "at least one run
     * completed" sanity check below would fail intermittently). */
    async function calibrateRuntimeMs(): Promise<number> {
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const dir = await mkdtemp(join(tmpdir(), "slop-a3-kill-calib-"));
        try {
          const start = Date.now();
          const proc = spawnWorker(dir);
          await waitForExit(proc);
          samples.push(Date.now() - start);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      return Math.max(...samples);
    }

    async function runAndKillMidway(dbRoot: string, killDelayMs: number): Promise<void> {
      const proc = spawnWorker(dbRoot);
      const timer = setTimeout(() => proc.kill("SIGKILL"), killDelayMs);
      await waitForExit(proc);
      clearTimeout(timer);
    }

    it("repeatedly SIGKILLs a real child process mid-write; every surviving entity file still parses and validates, temp debris is sweepable, and the index rebuilds cleanly afterward", async () => {
      const calibratedMs = await calibrateRuntimeMs();
      expect(calibratedMs).toBeGreaterThan(0);
      // Headroom past the calibrated (max-of-3) uninterrupted runtime,
      // so the odd real run really can finish naturally within the
      // kill-delay range despite normal scheduling variance — without
      // this, "at least one run completed" would flake whenever a real
      // run happens to be slower than every calibration sample.
      const boundMs = calibratedMs * 1.6 + 100;

      let sawTempFileAfterKill = false;
      let sawPartialRun = false;
      let totalCorruptFiles = 0;
      let totalTicketFilesSeenAcrossRuns = 0;
      let totalCompleteRuns = 0;

      for (let i = 0; i < ITERATIONS; i++) {
        const scratch = await mkdtemp(join(tmpdir(), `slop-a3-kill-${i}-`));
        try {
          // Pre-create the db skeleton, matching realistic usage: a repo
          // is always `slop init`'d (which lays down .slop/db/{tickets,
          // sessions,events}/) before anything ever writes to it. The
          // worker also calls ensureDbDirs itself (idempotent), but
          // doing it here too means even a kill landing before the
          // worker gets that far still leaves a well-formed (if empty)
          // db skeleton to inspect, rather than exercising the
          // unrelated "no .slop/db at all" case this test isn't about.
          const paths = await ensureDbDirs(scratch);
          // Stratified, not purely uniform-random: split [0, boundMs]
          // into ITERATIONS equal buckets and pick a random point
          // within iteration i's own bucket. This guarantees the kill
          // delays genuinely span the *whole* timeline every single
          // run of this test — including near-zero (kills before the
          // loop starts) and past typical completion (lets it finish
          // naturally) — rather than depending on enough independent
          // random draws happening to cover both ends, which is what
          // made the purely-random version flaky in practice.
          const bucketWidth = boundMs / ITERATIONS;
          const killDelayMs = (i + Math.random()) * bucketWidth;
          await runAndKillMidway(scratch, killDelayMs);

          const names = await readdir(paths.ticketsDir).catch(() => [] as string[]);
          const tempNames = names.filter(isTempFileName);
          const entityNames = names.filter(
            (n) => n.endsWith(".jsonc") && isTicketId(n.slice(0, -".jsonc".length)),
          );
          totalTicketFilesSeenAcrossRuns += entityNames.length;
          if (entityNames.length >= COUNT_PER_RUN) totalCompleteRuns++;

          // (1) Every file a reader would treat as an entity parses and
          // validates — no partial content ever reached a name that
          // isTicketId/listTicketIds would pick up.
          for (const name of entityNames) {
            const raw = await readFile(join(paths.ticketsDir, name), "utf8");
            const { value, errors } = parseJsonc(raw);
            const valid = errors.length === 0 && ticketSchema.safeParse(value).success;
            if (!valid) totalCorruptFiles++;
          }

          if (tempNames.length > 0) sawTempFileAfterKill = true;
          if (entityNames.length < COUNT_PER_RUN) sawPartialRun = true;

          // (2) Leftover temp files are ignored by readers (implicit
          // above: they were excluded from `entityNames`) and swept
          // cleanly.
          const expectedSweptPaths = tempNames.map((n) => join(paths.ticketsDir, n)).sort();
          const swept = (await sweepStaleTempFiles([paths.ticketsDir], { minAgeMs: 0 })).sort();
          expect(swept).toEqual(expectedSweptPaths);
          const namesAfterSweep = await readdir(paths.ticketsDir).catch(() => [] as string[]);
          expect(namesAfterSweep.filter(isTempFileName)).toHaveLength(0);

          // (3) The index rebuilds without error over whatever survived.
          const { index } = await loadIndex(paths);
          expect(index.tickets.length).toBe(entityNames.length);
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      }

      // The headline safety property: never a single corrupt file,
      // across every run.
      expect(totalCorruptFiles).toBe(0);

      // Sanity: the run actually did real work (didn't e.g. fail to
      // spawn every time).
      expect(totalTicketFilesSeenAcrossRuns).toBeGreaterThan(0);

      // The test can't silently degenerate into killing an idle
      // process and passing vacuously: across ITERATIONS runs, at
      // least one must show direct evidence of landing inside a write
      // (a leftover temp file) or an incomplete loop. We also require
      // at least one run to have completed fully and at least one to
      // be incomplete, proving the kill delays genuinely spanned the
      // loop's duration rather than clustering at one extreme.
      expect(sawTempFileAfterKill || sawPartialRun).toBe(true);
      expect(totalCompleteRuns).toBeGreaterThan(0);
      expect(totalCompleteRuns).toBeLessThan(ITERATIONS);
    }, 120_000);
  });

  // G2 (simplify-db-lock): the fencing/assertHeld protocol — and the
  // spawned-worker test that proved a dispossessed holder fails loudly —
  // were removed along with the feature. The lock is now a plain O_EXCL
  // acquire/release with stale-breaking (dead pid instantly; any holder
  // past staleTimeoutMs; unparseable lock files by mtime) — see
  // src/repo/lock.ts's module doc for the retained TOCTOU-safe break and
  // the accepted long-transaction trade-off, and src/repo/lock.test.ts
  // for the unit coverage of what remains.

  describe('"ambiguous prefix errors git-style"', () => {
    it("lists every candidate with id/name/slug and exits 5; not-found exits 4; exact slug beats an ambiguous prefix", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "slop-a3-refs-"));
      try {
        const paths = await ensureDbDirs(scratch);

        // Two tickets sharing a ULID prefix.
        const shared = "01ARZ3NDEKTSV4RRFFQ69G5FA"; // 25 chars
        const idA = `ticket_${shared}1` as Ticket["id"];
        const idB = `ticket_${shared}2` as Ticket["id"];
        const a = makeTicket({ id: idA, root_id: idA, name: "Alpha ticket", slug: "alpha-ticket" });
        const b = makeTicket({ id: idB, root_id: idB, name: "Beta ticket", slug: "beta-ticket" });
        // A third ticket whose SLUG exactly equals the shared prefix — for
        // the "exact slug wins" case below. Created up front, alongside a
        // and b, so the index (built once, on the first read below) is
        // complete from the start: A3's auto-heal only rebuilds on
        // missing/corrupt/stale-schema-version (see db-index.ts's
        // `rebuildIndex` doc) — it is not a live-freshness cache
        // invalidated by every write, so a ticket created *after* the
        // index already exists would not otherwise be visible without an
        // explicit reindex.
        const slugTicket = makeTicket({ slug: shared.toLowerCase() });
        await createTicket(paths, a, ctx, createdEvent);
        await createTicket(paths, b, ctx, createdEvent);
        await createTicket(paths, slugTicket, ctx, createdEvent);

        // --- ambiguous prefix: exit 5, git-style, names every candidate ---
        let ambiguousErr: unknown;
        try {
          await resolveTicketRef(paths, shared.slice(0, 10));
        } catch (err) {
          ambiguousErr = err;
        }
        expect(ambiguousErr).toMatchObject({ exitCode: 5 });
        const message = (ambiguousErr as Error).message;
        expect(message).toMatch(/^short ref ".+" is ambiguous/);
        expect(message).toMatch(/candidates are:/i);
        for (const t of [a, b]) {
          expect(message).toContain(t.id);
          expect(message).toContain(t.name);
          expect(message).toContain(t.slug);
        }

        // --- not found: exit 4 ---
        await expect(resolveTicketRef(paths, "no-such-ticket-anywhere")).rejects.toMatchObject({
          exitCode: 4,
        });

        // --- exact slug wins over an ambiguous prefix interpretation ---
        const resolved = await resolveTicketRef(paths, shared.toLowerCase());
        expect(resolved.id).toBe(slugTicket.id);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  });

  describe('"deleted index self-heals"', () => {
    it("a missing index.jsonc self-heals on an ordinary read, with correct content", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "slop-a3-index-missing-"));
      try {
        const paths = await ensureDbDirs(scratch);
        const t = makeTicket();
        await createTicket(paths, t, ctx, createdEvent);

        // index.jsonc was never written — same state as `rm .slop/db/index.jsonc`
        // or a fresh clone (it's gitignored, D14). This is the FIRST ever
        // index access, so it must be the one that observes rebuilt=true.
        const { index, rebuilt, reason } = await loadIndex(paths);
        expect(rebuilt).toBe(true);
        expect(reason).toBe("missing");
        expect(index.tickets.map((r) => r.id)).toEqual([t.id]);
        expect(index.slugs[t.slug]).toBe(t.id);

        // And the heal was persisted to disk, not just returned in memory.
        const onDisk = await readFile(paths.indexFile, "utf8");
        expect(onDisk).toContain(t.id);

        // A normal read operation (ref resolution) succeeds against the
        // now-healed index.
        const resolved = await resolveTicketRef(paths, t.slug);
        expect(resolved.id).toBe(t.id);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });

    it("a corrupt/truncated index.jsonc self-heals", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "slop-a3-index-corrupt-"));
      try {
        const paths = await ensureDbDirs(scratch);
        const t = makeTicket();
        await createTicket(paths, t, ctx, createdEvent);
        await writeFile(paths.indexFile, '{ "schema_version": 1, "tickets": [ { truncated');

        const { index, rebuilt, reason } = await loadIndex(paths);
        expect(rebuilt).toBe(true);
        expect(reason).toBe("parse_error");
        expect(index.tickets.map((r) => r.id)).toEqual([t.id]);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });

    it("a stale schema_version self-heals", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "slop-a3-index-stale-version-"));
      try {
        const paths = await ensureDbDirs(scratch);
        const t = makeTicket();
        await createTicket(paths, t, ctx, createdEvent);
        await writeFile(
          paths.indexFile,
          `${JSON.stringify(
            {
              schema_version: INDEX_SCHEMA_VERSION + 999,
              built_at: t.created_at,
              tickets: [],
              slugs: {},
            },
            null,
            2,
          )}\n`,
        );

        const { index, rebuilt, reason } = await loadIndex(paths);
        expect(rebuilt).toBe(true);
        expect(reason).toBe("stale_schema_version");
        expect(index.schema_version).toBe(INDEX_SCHEMA_VERSION);
        expect(index.tickets.map((r) => r.id)).toEqual([t.id]);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });

    // The four tests below are the "healing from staleness is the same
    // requirement [as deleted index self-heals]" cases: a *valid,
    // schema-current* index.jsonc that no longer matches what's actually
    // on disk, because something changed the entity files with no `slop`
    // command involved at all — exactly what `git merge`/`git pull`/
    // `$EDITOR` do. See db-index.ts's "Content staleness" doc.

    it("a ticket file EDITED directly on disk (bypassing the repo layer entirely — e.g. git merge/pull or $EDITOR) is reflected on the next read", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "slop-a3-index-stale-content-edit-"));
      try {
        const paths = await ensureDbDirs(scratch);
        const t = makeTicket({ name: "Before the hand-edit" });
        await createTicket(paths, t, ctx, createdEvent);

        const first = await loadIndex(paths);
        expect(first.rebuilt).toBe(true); // first-ever read: missing -> builds
        expect(first.index.tickets[0]?.name).toBe("Before the hand-edit");

        // A real margin past mtime resolution, so this edit unambiguously
        // advances max_mtime_ms — see db-index.ts's documented
        // millisecond-granularity limitation; this test deliberately
        // avoids that edge rather than risking it.
        await sleep(20);

        // Hand-edit the ticket file directly on disk — no createTicket,
        // no updateTicket, nothing from the repo layer at all. The
        // ticket's own count is unchanged; only its content (and mtime)
        // differs, so this specifically exercises the mtime half of the
        // fingerprint, not the count half.
        const path = ticketFilePath(paths, t.id);
        const raw = await readFile(path, "utf8");
        await writeFile(path, raw.replace("Before the hand-edit", "After the hand-edit"));

        const second = await loadIndex(paths);
        expect(second.rebuilt).toBe(true);
        expect(second.reason).toBe("stale_content");
        expect(second.index.tickets[0]?.name).toBe("After the hand-edit");
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });

    it("a ticket file ADDED directly on disk (bypassing the repo layer — e.g. a merge bringing in a ticket created on another branch) is reflected on the next read", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "slop-a3-index-stale-content-add-"));
      try {
        const paths = await ensureDbDirs(scratch);
        const t1 = makeTicket();
        await createTicket(paths, t1, ctx, createdEvent);

        const first = await loadIndex(paths);
        expect(first.index.tickets.map((r) => r.id)).toEqual([t1.id]);

        await sleep(20);

        // Write a second ticket file directly — no createTicket call.
        const t2 = makeTicket();
        await writeFile(ticketFilePath(paths, t2.id), writeCanonical(t2));

        const second = await loadIndex(paths);
        expect(second.rebuilt).toBe(true);
        expect(second.reason).toBe("stale_content");
        expect(second.index.tickets.map((r) => r.id).sort()).toEqual([t1.id, t2.id].sort());
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });

    it("a ticket file DELETED directly on disk (bypassing the repo layer) is reflected on the next read", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "slop-a3-index-stale-content-delete-"));
      try {
        const paths = await ensureDbDirs(scratch);
        const t1 = makeTicket();
        const t2 = makeTicket();
        await createTicket(paths, t1, ctx, createdEvent);
        await createTicket(paths, t2, ctx, createdEvent);

        const first = await loadIndex(paths);
        expect(first.index.tickets.map((r) => r.id).sort()).toEqual([t1.id, t2.id].sort());

        await sleep(20);

        // Delete a ticket file directly — no deleteTicket call.
        await rm(ticketFilePath(paths, t2.id));

        const second = await loadIndex(paths);
        expect(second.rebuilt).toBe(true);
        expect(second.reason).toBe("stale_content");
        expect(second.index.tickets.map((r) => r.id)).toEqual([t1.id]);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });

    it("a second read with NO changes at all does not rebuild — the fingerprint match short-circuits, this is not a full rebuild on every read", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "slop-a3-index-fresh-shortcircuit-"));
      try {
        const paths = await ensureDbDirs(scratch);
        const t = makeTicket();
        await createTicket(paths, t, ctx, createdEvent);

        const first = await loadIndex(paths);
        expect(first.rebuilt).toBe(true); // first-ever read: missing -> builds

        const second = await loadIndex(paths);
        expect(second.rebuilt).toBe(false);
        expect(second.reason).toBe("fresh");
        expect(second.index).toEqual(first.index);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });

    // Adversarial-review Finding 2: the old fingerprint tracked only file
    // count + max mtime, so an edit to a ticket whose mtime is NOT the
    // directory's max — pushed backwards via `utimes`, exactly what `cp
    // -p`/`rsync -t`/a backup restore/clock skew between two machines all
    // do — was bit-identical to "nothing changed" and `loadIndex()` would
    // report `reason: "fresh"` forever. Reproduced here exactly as the
    // reviewer found it, at the acceptance level (not just the unit-level
    // fingerprint test in db-index.test.ts).
    it("an OLDER ticket edited on disk with its mtime forced BACKWARDS (via utimes) — below another ticket's already-recorded mtime — is still detected as stale content on the next read (Finding 2)", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "slop-a3-index-mtime-backwards-"));
      try {
        const paths = await ensureDbDirs(scratch);

        const older = makeTicket({ name: "Older ticket" });
        await createTicket(paths, older, ctx, createdEvent);
        const olderPath = ticketFilePath(paths, older.id);
        const baseTime = new Date("2026-07-23T10:00:00.000Z");
        await utimes(olderPath, baseTime, baseTime);

        const newer = makeTicket({ name: "Newer ticket" });
        await createTicket(paths, newer, ctx, createdEvent);
        const newerTime = new Date(baseTime.getTime() + 60_000);
        await utimes(ticketFilePath(paths, newer.id), newerTime, newerTime);

        // First read: builds and persists the fingerprint against BOTH
        // tickets' current (backdated) mtimes.
        const first = await loadIndex(paths);
        expect(first.rebuilt).toBe(true);
        expect(first.index.tickets.find((r) => r.id === older.id)?.name).toBe("Older ticket");

        // Edit the OLDER ticket's content, then force its mtime backwards
        // — to a value still well below `newer`'s mtime. A max-mtime-only
        // fingerprint would see the directory's recorded max as
        // unchanged (still newer's mtime) and the count as unchanged,
        // and would therefore wrongly report "fresh".
        const raw = await readFile(olderPath, "utf8");
        await writeFile(olderPath, raw.replace("Older ticket", "Older ticket EDITED"));
        const editedTime = new Date(baseTime.getTime() + 5_000); // still << newerTime
        await utimes(olderPath, editedTime, editedTime);

        const second = await loadIndex(paths);
        expect(second.rebuilt).toBe(true);
        expect(second.reason).toBe("stale_content");
        expect(second.index.tickets.find((r) => r.id === older.id)?.name).toBe(
          "Older ticket EDITED",
        );
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });

    // The "nastiest downstream symptom" named by the reviewer: under the
    // old fingerprint, a slug rename that happened to land with the
    // backwards-mtime pattern above would go undetected forever, turning
    // a ref that SHOULD resolve into a permanent false NOT_FOUND (exit 4).
    it("a slug RENAMED via a backwards-mtime hand-edit still resolves through resolveTicketRef afterward (Finding 2 downstream symptom)", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "slop-a3-index-mtime-backwards-slug-rename-"));
      try {
        const paths = await ensureDbDirs(scratch);

        const anchor = makeTicket({ name: "Anchor ticket" });
        await createTicket(paths, anchor, ctx, createdEvent);
        const baseTime = new Date("2026-07-23T10:00:00.000Z");
        const anchorTime = new Date(baseTime.getTime() + 60_000);
        await utimes(ticketFilePath(paths, anchor.id), anchorTime, anchorTime);

        const renamed = makeTicket({ name: "Renamed ticket", slug: "old-slug" });
        await createTicket(paths, renamed, ctx, createdEvent);
        await utimes(ticketFilePath(paths, renamed.id), baseTime, baseTime);

        const first = await loadIndex(paths);
        expect(first.index.slugs["old-slug"]).toBe(renamed.id);

        // Rename the slug directly on disk, then force the file's mtime
        // backwards below `anchor`'s already-recorded mtime.
        const renamedPath = ticketFilePath(paths, renamed.id);
        const raw = await readFile(renamedPath, "utf8");
        await writeFile(renamedPath, raw.replace('"old-slug"', '"new-slug"'));
        const editedTime = new Date(baseTime.getTime() + 5_000); // still << anchorTime
        await utimes(renamedPath, editedTime, editedTime);

        // The ref that should now resolve (the new slug) must actually
        // resolve — this is the concrete failure mode the reviewer named:
        // under the old fingerprint this would incorrectly stay NOT_FOUND
        // (exit 4) forever, because loadIndex would never notice the
        // rename and rebuild.
        const resolved = await resolveTicketRef(paths, "new-slug");
        expect(resolved.id).toBe(renamed.id);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });

    // Adversarial-review Finding 3: a single corrupt ticket file used to
    // make the WHOLE index build throw, so loadIndex — the auto-heal
    // function this "deleted index self-heals" criterion is about — was
    // itself unusable when exactly one ticket file was corrupt. The index
    // must still self-heal for every OTHER ticket even when one is
    // unreadable.
    it("self-heals around a single corrupt ticket file: every other ticket is still indexed, and the bad one is reported rather than aborting the whole read (Finding 3)", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "slop-a3-index-corrupt-ticket-"));
      try {
        const paths = await ensureDbDirs(scratch);
        const good1 = makeTicket();
        const good2 = makeTicket();
        await createTicket(paths, good1, ctx, createdEvent);
        await createTicket(paths, good2, ctx, createdEvent);

        const badId = newTicketId();
        const badPath = join(paths.ticketsDir, `${badId}.jsonc`);
        await writeFile(badPath, '{ "id": "not even close to a valid ticket" }');

        const { index, rebuilt } = await loadIndex(paths);
        expect(rebuilt).toBe(true);
        expect(index.tickets.map((r) => r.id).sort()).toEqual([good1.id, good2.id].sort());
        expect(index.problems).toHaveLength(1);
        expect(index.problems[0]?.path).toBe(badPath);

        // And ordinary ref resolution against the good tickets keeps
        // working — the corrupt file didn't take the whole read path down.
        const resolved = await resolveTicketRef(paths, good1.slug);
        expect(resolved.id).toBe(good1.id);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  });
});
