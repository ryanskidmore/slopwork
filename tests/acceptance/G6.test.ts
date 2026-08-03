/**
 * G6: auto-compact events into a per-ticket archive on terminal
 * transitions (t-7eq5s).
 *
 * Exercises the compiled `dist/slop` binary end to end (same convention as
 * G2.test.ts/E2.test.ts): closing a ticket compacts its events into
 * `events/archive/<ticket_id>.jsonc`; the audit spine (`slop show`/`slop
 * events`) renders identically before and after; a merge-safe poll cursor
 * taken before a close resumes correctly after; the cross-clone merge
 * story (a close racing an unrelated append merges cleanly and unions on
 * read; a genuine cross-clone double-close conflicts like any other
 * same-ticket edit, and a natural "keep both" resolution dedupes cleanly);
 * and `slop reindex --compact`'s retroactive, idempotent, never-implicit
 * sweep.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
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

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runSlop(args: readonly string[], cwd: string, actor = "ryan"): RunResult {
  const env = { ...process.env, SLOP_ACTOR: actor };
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_HOME",
  ]) {
    delete (env as Record<string, string | undefined>)[key];
  }
  const r = spawnSync(binaryPath, args, { cwd, encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function must(r: RunResult, label: string): RunResult {
  if (r.status !== 0) {
    throw new Error(
      `${label} failed (exit ${r.status}):\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
    );
  }
  return r;
}

function runGit(args: readonly string[], cwd: string): RunResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function initGitRepo(dir: string, name: string, email: string): Promise<void> {
  must(runGit(["init", "-q", "-b", "main"], dir), "git init");
  must(runGit(["config", "user.name", name], dir), "git config user.name");
  must(runGit(["config", "user.email", email], dir), "git config user.email");
  must(runGit(["config", "merge.conflictStyle", "merge"], dir), "git config merge.conflictStyle");
}

async function makeRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  must(runSlop(["init", "--yes", "--project", "g6-fixture", "--user", "ryan"], dir), "slop init");
  return dir;
}

interface TicketRef {
  id: string;
  slug: string;
}

function newTicket(dir: string, name: string, extraArgs: string[] = [], actor = "ryan"): TicketRef {
  const r = must(runSlop(["new", name, "--json", ...extraArgs], dir, actor), `slop new "${name}"`);
  return JSON.parse(r.stdout) as TicketRef;
}

function archivePath(dir: string, ticketId: string): string {
  return join(dir, ".slop", "db", "events", "archive", `${ticketId}.jsonc`);
}

interface EventsJsonBody {
  events: Array<{ id: string; verb: string; at: string; entity: { kind: string; id: string } }>;
  poll_cursor: string | null;
  has_more: boolean;
}

function eventsJson(dir: string, args: string[]): EventsJsonBody {
  const r = must(runSlop(["events", "--json", ...args], dir), `slop events ${args.join(" ")}`);
  return JSON.parse(r.stdout) as EventsJsonBody;
}

async function looseEventCount(dir: string): Promise<number> {
  const eventsDir = join(dir, ".slop", "db", "events");
  let count = 0;
  const entries = await readdir(eventsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonc")) count++;
    if (entry.isDirectory() && entry.name !== "archive") {
      const shardEntries = await readdir(join(eventsDir, entry.name)).catch(() => []);
      count += shardEntries.filter((n) => n.endsWith(".jsonc")).length;
    }
  }
  return count;
}

describe("G6: event compaction on terminal transitions", () => {
  describe("closing a ticket compacts its events", () => {
    it("done: creates an archive, folds every event in, and removes the loose originals", async () => {
      const dir = await makeRepo("slop-g6-done-");
      const ticket = newTicket(dir, "Compact on done");
      must(runSlop(["start", ticket.slug], dir), "start");
      must(
        runSlop(["update", ticket.slug, "--progress", "working on it"], dir),
        "update --progress",
      );
      must(runSlop(["review", ticket.slug, "--mr", "https://example.com/pr/1"], dir), "review");

      const before = eventsJson(dir, ["--ticket", ticket.id]);
      expect(before.events.length).toBeGreaterThan(0);
      expect(existsSync(archivePath(dir, ticket.id))).toBe(false);

      must(runSlop(["done", ticket.slug, "--note", "shipped"], dir), "done");

      expect(existsSync(archivePath(dir, ticket.id))).toBe(true);
      const archived = JSON.parse(await readFile(archivePath(dir, ticket.id), "utf8")) as {
        version: number;
        ticket: string;
        events: unknown[];
      };
      expect(archived.ticket).toBe(ticket.id);
      // Every pre-close event PLUS the ticket.done/session.ended pair.
      expect(archived.events.length).toBe(before.events.length + 2);

      // Nothing left loose for this ticket's events anywhere.
      const after = eventsJson(dir, ["--ticket", ticket.id]);
      const looseTotal = await looseEventCount(dir);
      expect(looseTotal).toBe(0);
      expect(after.events.length).toBe(archived.events.length);
    });

    it("drop: creates an archive and removes the loose originals too", async () => {
      const dir = await makeRepo("slop-g6-drop-");
      const ticket = newTicket(dir, "Compact on drop");
      must(runSlop(["start", ticket.slug], dir), "start");

      must(runSlop(["drop", ticket.slug, "--reason", "no longer needed"], dir), "drop");

      expect(existsSync(archivePath(dir, ticket.id))).toBe(true);
      expect(await looseEventCount(dir)).toBe(0);

      const shown = must(runSlop(["show", ticket.id, "--json"], dir), "show");
      const body = JSON.parse(shown.stdout) as { ticket: { state: string } };
      expect(body.ticket.state).toBe("dropped");
    });
  });

  describe("audit spine identical before/after compaction", () => {
    it("slop events --ticket --json's pre-close events survive byte-for-byte as a prefix after done compacts them", async () => {
      const dir = await makeRepo("slop-g6-spine-");
      const ticket = newTicket(dir, "Audit spine parity");
      must(runSlop(["start", ticket.slug], dir), "start");
      must(runSlop(["update", ticket.slug, "--progress", "note one"], dir), "update 1");
      must(runSlop(["update", ticket.slug, "--progress", "note two"], dir), "update 2");
      must(runSlop(["ask", ticket.slug, "any blockers?"], dir), "ask");

      const preClose = eventsJson(dir, ["--ticket", ticket.id]);
      expect(preClose.events.length).toBeGreaterThanOrEqual(4);

      must(runSlop(["done", ticket.slug, "--note", "done"], dir), "done");

      const postClose = eventsJson(dir, ["--ticket", ticket.id]);
      // Every pre-close event is present, unchanged, in the same relative
      // order — compaction only ever relocates storage, never rewrites or
      // reorders content.
      expect(postClose.events.slice(0, preClose.events.length)).toEqual(preClose.events);
      // Exactly the terminal-transition events were appended after.
      const newVerbs = postClose.events.slice(preClose.events.length).map((e) => e.verb);
      expect(newVerbs).toContain("ticket.done");
      expect(newVerbs).toContain("session.ended");
    });

    it("slop show --json's ticket/awaiting_input sections are unaffected by compaction", async () => {
      const dir = await makeRepo("slop-g6-show-parity-");
      const ticket = newTicket(dir, "Show parity");
      must(runSlop(["start", ticket.slug], dir), "start");
      must(runSlop(["ask", ticket.slug, "one open question"], dir), "ask");
      must(runSlop(["update", ticket.slug, "--progress", "still working"], dir), "progress");

      const preClose = must(runSlop(["show", ticket.id, "--json"], dir), "show pre").stdout;
      const preBody = JSON.parse(preClose) as {
        ticket: { latest_note: string | null };
        awaiting_input: { open: boolean; questions: unknown[] };
      };
      expect(preBody.ticket.latest_note).toBe("still working");
      expect(preBody.awaiting_input.open).toBe(true);

      must(runSlop(["done", ticket.slug, "--note", "shipping without answering"], dir), "done");

      const postBody = JSON.parse(
        must(runSlop(["show", ticket.id, "--json"], dir), "show post").stdout,
      ) as {
        ticket: { latest_note: string | null; state: string };
        awaiting_input: { open: boolean; questions: unknown[] };
      };
      // `done --note` overwrites latest_note (buildDoneTicket's own
      // documented behavior) — but the still-open question from BEFORE
      // the close must still be visible via `show`, proving `show`'s
      // ticket-scoped event read reaches into the now-compacted archive.
      expect(postBody.ticket.state).toBe("done");
      expect(postBody.awaiting_input.open).toBe(true);
      expect(postBody.awaiting_input.questions).toEqual(preBody.awaiting_input.questions);
    });
  });

  describe("poll cursors survive compaction", () => {
    it("a cursor taken before a close resumes correctly after: sees new events, never repeats old ones", async () => {
      const dir = await makeRepo("slop-g6-poll-");
      const ticket = newTicket(dir, "Poll survives compaction");
      must(runSlop(["start", ticket.slug], dir), "start");
      must(runSlop(["update", ticket.slug, "--progress", "note"], dir), "progress");

      // Create the cursor and consume everything currently pending.
      const firstPage = eventsJson(dir, ["--ticket", ticket.id, "--poll"]);
      expect(firstPage.poll_cursor).toBeTruthy();
      const cursor = firstPage.poll_cursor as string;
      expect(firstPage.has_more).toBe(false);
      const seenIds = new Set(firstPage.events.map((e) => e.id));
      expect(seenIds.size).toBeGreaterThan(0);

      must(runSlop(["review", ticket.slug, "--mr", "https://example.com/pr/9"], dir), "review");
      must(runSlop(["done", ticket.slug, "--note", "wrapped up"], dir), "done");

      // Same cursor, same ticket scope, resumed post-compaction.
      const secondPage = eventsJson(dir, ["--ticket", ticket.id, "--poll", cursor]);
      expect(secondPage.poll_cursor).toBe(cursor);
      // No previously-seen id is repeated.
      for (const event of secondPage.events) {
        expect(seenIds.has(event.id)).toBe(false);
      }
      // The new terminal-transition events are exactly what's delivered.
      const newVerbs = secondPage.events.map((e) => e.verb);
      expect(newVerbs).toContain("ticket.done");
      expect(newVerbs).toContain("session.ended");
      expect(newVerbs).toContain("review.requested");

      // A third poll with the SAME cursor now sees nothing further.
      const thirdPage = eventsJson(dir, ["--ticket", ticket.id, "--poll", cursor]);
      expect(thirdPage.events).toEqual([]);
    });
  });

  describe("cross-clone merge story", () => {
    it("a close (clone A) racing a concurrent unrelated append (clone B) merges with ZERO git conflicts; reads union both; reindex --compact idempotently folds the residual in", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "slop-g6-residual-"));
      scratchDirs.push(scratch);
      const originRoot = join(scratch, "origin");
      const cloneARoot = join(scratch, "clone-a");
      const cloneBRoot = join(scratch, "clone-b");

      await mkdir(originRoot, { recursive: true });
      await initGitRepo(originRoot, "Origin", "origin@example.com");
      must(
        runSlop(["init", "--yes", "--project", "g6-residual", "--user", "origin-bot"], originRoot),
        "slop init (origin)",
      );
      const ticket = newTicket(originRoot, "Shared ticket (residual race)", [], "origin-bot");
      must(runSlop(["start", ticket.slug], originRoot, "origin-bot"), "start (origin)");
      must(runGit(["add", "-A"], originRoot), "git add (origin)");
      must(runGit(["commit", "-q", "-m", "origin: baseline"], originRoot), "git commit (origin)");

      must(runGit(["clone", "-q", originRoot, cloneARoot], scratch), "git clone A");
      must(runGit(["clone", "-q", originRoot, cloneBRoot], scratch), "git clone B");
      for (const [dir, name, email] of [
        [cloneARoot, "Agent A", "agent-a@example.com"],
        [cloneBRoot, "Agent B", "agent-b@example.com"],
      ] as const) {
        must(runGit(["config", "user.name", name], dir), "git config user.name");
        must(runGit(["config", "user.email", email], dir), "git config user.email");
      }

      // Clone A: closes (and, per this feature, compacts) the ticket.
      must(
        runSlop(["done", ticket.slug, "--note", "closed on clone A"], cloneARoot, "agent-a"),
        "done (A)",
      );
      must(runGit(["add", "-A"], cloneARoot), "git add (A)");
      must(
        runGit(["commit", "-q", "-m", "clone A: close + compact"], cloneARoot),
        "git commit (A)",
      );

      // Clone B: unaware A closed it yet, appends a lock-free progress
      // note (a genuinely new loose event).
      must(
        runSlop(
          ["update", ticket.slug, "--progress", "clone B still working"],
          cloneBRoot,
          "agent-b",
        ),
        "update --progress (B)",
      );
      must(runGit(["add", "-A"], cloneBRoot), "git add (B)");
      must(
        runGit(["commit", "-q", "-m", "clone B: unrelated append"], cloneBRoot),
        "git commit (B)",
      );

      // Merge B into A.
      must(runGit(["remote", "add", "clone-b", cloneBRoot], cloneARoot), "git remote add");
      must(runGit(["fetch", "-q", "clone-b"], cloneARoot), "git fetch");
      const merge = runGit(["merge", "-q", "clone-b/main", "-m", "merge B into A"], cloneARoot);
      expect(merge.status, `expected a clean merge:\n${merge.stdout}\n${merge.stderr}`).toBe(0);

      const conflicted = runGit(
        ["diff", "--name-only", "--diff-filter=U"],
        cloneARoot,
      ).stdout.trim();
      expect(conflicted).toBe("");

      // Residual shape: the archive (from A) AND a loose event (from B)
      // both exist for the same ticket, post-merge.
      expect(existsSync(archivePath(cloneARoot, ticket.id))).toBe(true);
      expect(await looseEventCount(cloneARoot)).toBeGreaterThan(0);

      // Reads union both transparently.
      const merged = eventsJson(cloneARoot, ["--ticket", ticket.id]);
      const verbs = merged.events.map((e) => e.verb);
      expect(verbs).toContain("ticket.done");
      expect(verbs).toContain("session.ended");
      expect(
        verbs.filter((v) => v === "ticket.updated" || v === "ticket.state_changed").length,
      ).toBeGreaterThan(0);
      // No duplicate ids.
      expect(new Set(merged.events.map((e) => e.id)).size).toBe(merged.events.length);

      // `reindex --compact` idempotently folds the residual in.
      const compact = must(runSlop(["reindex", "--compact"], cloneARoot), "reindex --compact");
      expect(compact.stdout).toMatch(/compacted \d+ event\(s\)/);
      expect(await looseEventCount(cloneARoot)).toBe(0);

      const afterCompact = eventsJson(cloneARoot, ["--ticket", ticket.id]);
      expect(afterCompact.events.map((e) => e.id).sort()).toEqual(
        merged.events.map((e) => e.id).sort(),
      );

      // A second --compact run is a true no-op.
      const again = must(
        runSlop(["reindex", "--compact"], cloneARoot),
        "reindex --compact (again)",
      );
      expect(again.stdout).toMatch(/nothing to compact/);
    });

    it("a genuine cross-clone double-close conflicts on both the ticket file and the archive — same as any other same-ticket edit — and a natural 'keep both' resolution dedupes cleanly on read", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "slop-g6-double-close-"));
      scratchDirs.push(scratch);
      const originRoot = join(scratch, "origin");
      const cloneARoot = join(scratch, "clone-a");
      const cloneBRoot = join(scratch, "clone-b");

      await mkdir(originRoot, { recursive: true });
      await initGitRepo(originRoot, "Origin", "origin@example.com");
      must(
        runSlop(
          ["init", "--yes", "--project", "g6-double-close", "--user", "origin-bot"],
          originRoot,
        ),
        "slop init (origin)",
      );
      const ticket = newTicket(originRoot, "Shared ticket (double close)", [], "origin-bot");
      must(runSlop(["start", ticket.slug], originRoot, "origin-bot"), "start (origin)");
      must(runGit(["add", "-A"], originRoot), "git add (origin)");
      must(runGit(["commit", "-q", "-m", "origin: baseline"], originRoot), "git commit (origin)");

      must(runGit(["clone", "-q", originRoot, cloneARoot], scratch), "git clone A");
      must(runGit(["clone", "-q", originRoot, cloneBRoot], scratch), "git clone B");
      for (const [dir, name, email] of [
        [cloneARoot, "Agent A", "agent-a@example.com"],
        [cloneBRoot, "Agent B", "agent-b@example.com"],
      ] as const) {
        must(runGit(["config", "user.name", name], dir), "git config user.name");
        must(runGit(["config", "user.email", email], dir), "git config user.email");
      }

      // BOTH clones close the SAME ticket independently, each unaware of
      // the other (illegal within one db — tickets/state.ts — but each
      // clone's own local view is still legally in_progress at this
      // point).
      must(
        runSlop(["done", ticket.slug, "--note", "closed on A"], cloneARoot, "agent-a"),
        "done (A)",
      );
      must(
        runSlop(["done", ticket.slug, "--note", "closed on B"], cloneBRoot, "agent-b"),
        "done (B)",
      );

      const eventsA = eventsJson(cloneARoot, ["--ticket", ticket.id]);
      const eventsB = eventsJson(cloneBRoot, ["--ticket", ticket.id]);
      // Each clone's own close minted its OWN distinct ticket.done/
      // session.ended event ids — the two archives genuinely differ.
      const doneIdA = eventsA.events.find((e) => e.verb === "ticket.done")?.id;
      const doneIdB = eventsB.events.find((e) => e.verb === "ticket.done")?.id;
      expect(doneIdA).toBeTruthy();
      expect(doneIdB).toBeTruthy();
      expect(doneIdA).not.toBe(doneIdB);

      must(runGit(["add", "-A"], cloneARoot), "git add (A)");
      must(
        runGit(["commit", "-q", "-m", "clone A: close + compact"], cloneARoot),
        "git commit (A)",
      );
      must(runGit(["add", "-A"], cloneBRoot), "git add (B)");
      must(
        runGit(["commit", "-q", "-m", "clone B: close + compact"], cloneBRoot),
        "git commit (B)",
      );

      must(runGit(["remote", "add", "clone-b", cloneBRoot], cloneARoot), "git remote add");
      must(runGit(["fetch", "-q", "clone-b"], cloneARoot), "git fetch");
      const merge = runGit(["merge", "--no-commit", "clone-b/main"], cloneARoot);
      // A genuine conflict — both the ticket file (state/updated_at) and
      // the archive file (each side's own unique close event) were
      // written differently by both sides. This is NOT a new class of
      // conflict compaction introduces — see event-archive-format.ts's
      // module doc: it's the SAME "two clones raced the same entity"
      // story docs/concurrency-and-merging.md already documents for a
      // ticket file alone, just now spanning one more file.
      expect(merge.status).not.toBe(0);
      const conflicted = runGit(["diff", "--name-only", "--diff-filter=U"], cloneARoot)
        .stdout.trim()
        .split("\n")
        .filter(Boolean);
      expect(conflicted.some((p) => p.endsWith(`archive/${ticket.id}.jsonc`))).toBe(true);

      // Resolve: the natural, minimal-effort human resolution for the
      // archive — union both sides' events (the archive is just a
      // sorted-by-id array of self-contained records; concatenating is
      // safe, and read-time dedup makes even a byte-identical overlap
      // harmless). For the ticket AND session files (real field-level
      // judgment calls, unrelated to this feature — the session file also
      // conflicts, since both clones' own `done` finalized the SAME
      // session with a different `ended_at`/`end_summary`), keep "ours".
      must(
        runGit(["checkout", "--ours", "--", ".slop/db/tickets", ".slop/db/sessions"], cloneARoot),
        "checkout --ours tickets+sessions",
      );
      const archiveRelPath = join(".slop", "db", "events", "archive", `${ticket.id}.jsonc`);
      const oursArchive = runGit(["show", `:2:${archiveRelPath}`], cloneARoot).stdout;
      const theirsArchive = runGit(["show", `:3:${archiveRelPath}`], cloneARoot).stdout;
      const oursEvents = (JSON.parse(oursArchive) as { events: { id: string }[] }).events;
      const theirsEvents = (JSON.parse(theirsArchive) as { events: { id: string }[] }).events;
      const byId = new Map<string, { id: string }>();
      for (const event of [...oursEvents, ...theirsEvents]) byId.set(event.id, event);
      const unioned = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
      await writeFile(
        join(cloneARoot, archiveRelPath),
        `${JSON.stringify({ version: 1, ticket: ticket.id, events: unioned }, null, 2)}\n`,
      );
      must(runGit(["add", "-A"], cloneARoot), "git add (resolved)");
      must(
        runGit(["commit", "-q", "-m", "merge: resolve double-close"], cloneARoot),
        "git commit (merge)",
      );

      // Both sides' unique close events survive the union, with no
      // duplicate ids in what the CLI actually reads back out.
      const mergedEvents = eventsJson(cloneARoot, ["--ticket", ticket.id]);
      const mergedIds = mergedEvents.events.map((e) => e.id);
      expect(new Set(mergedIds).size).toBe(mergedIds.length);
      expect(mergedIds).toContain(doneIdA);
      expect(mergedIds).toContain(doneIdB);

      // The db is left in a fully usable state — reindex completes cleanly.
      const reindex = must(runSlop(["reindex"], cloneARoot), "reindex (post-merge)");
      expect(reindex.status).toBe(0);
    });
  });

  describe("slop reindex --compact (retroactive)", () => {
    it("compacts an already-closed ticket whose events were left loose (a pre-existing repo), idempotently, and never runs implicitly", async () => {
      const dir = await makeRepo("slop-g6-retro-");
      const ticket = newTicket(dir, "Retroactive compaction");
      must(runSlop(["start", ticket.slug], dir), "start");
      must(runSlop(["done", ticket.slug, "--note", "done"], dir), "done");

      // Simulate a repo that predates this feature: the ticket is closed,
      // but restore its events to loose files by copying the archive's
      // content back out and deleting the archive — exactly the shape a
      // pre-existing closed ticket (or a done/drop whose own compaction
      // step failed and warned) would be in.
      const archiveText = await readFile(archivePath(dir, ticket.id), "utf8");
      const archive = JSON.parse(archiveText) as { events: { id: string; at: string }[] };
      await rm(archivePath(dir, ticket.id));
      const eventsDir = join(dir, ".slop", "db", "events");
      for (const event of archive.events) {
        // The event's OWN id embeds its month (events.ts's eventShardMonth
        // — decoding the ULID directly here would need the `ulid` package;
        // deriving it from `at` instead is equivalent for every event this
        // test plants, since each was minted at creation time with `at`
        // set from the same clock reading as its id).
        const month = event.at.slice(0, 7);
        const shardDir = join(eventsDir, month);
        await mkdir(shardDir, { recursive: true });
        await writeFile(join(shardDir, `${event.id}.jsonc`), `${JSON.stringify(event, null, 2)}\n`);
      }
      expect(existsSync(archivePath(dir, ticket.id))).toBe(false);
      expect(await looseEventCount(dir)).toBe(archive.events.length);

      // A plain reindex (and --heal) never compacts implicitly.
      for (const args of [["reindex"], ["reindex", "--heal"]]) {
        must(runSlop(args, dir), args.join(" "));
      }
      expect(existsSync(archivePath(dir, ticket.id))).toBe(false);
      expect(await looseEventCount(dir)).toBe(archive.events.length);

      // `--compact` retroactively does the job.
      const compact = must(runSlop(["reindex", "--compact"], dir), "reindex --compact");
      expect(compact.stdout).toMatch(new RegExp(`compacted ${archive.events.length} event`));
      expect(existsSync(archivePath(dir, ticket.id))).toBe(true);
      expect(await looseEventCount(dir)).toBe(0);

      const rearchived = JSON.parse(await readFile(archivePath(dir, ticket.id), "utf8")) as {
        events: { id: string }[];
      };
      expect(rearchived.events.map((e) => e.id).sort()).toEqual(
        archive.events.map((e) => e.id).sort(),
      );

      // Idempotent.
      const again = must(runSlop(["reindex", "--compact"], dir), "reindex --compact (again)");
      expect(again.stdout).toMatch(/nothing to compact/);
    });

    it("never touches a still-open ticket's events", async () => {
      const dir = await makeRepo("slop-g6-retro-live-");
      const ticket = newTicket(dir, "Stays live");
      must(runSlop(["start", ticket.slug], dir), "start");
      must(runSlop(["update", ticket.slug, "--progress", "still going"], dir), "progress");

      const before = await looseEventCount(dir);
      expect(before).toBeGreaterThan(0);

      must(runSlop(["reindex", "--compact"], dir), "reindex --compact");

      expect(existsSync(archivePath(dir, ticket.id))).toBe(false);
      expect(await looseEventCount(dir)).toBe(before);
    });
  });
});
