import { type SpawnSyncReturns, execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Ticket, parseJsonc, ticketSchema } from "../../src/core/index.js";
import { ensureDbDirs } from "../../src/repo/index.js";
import type { RepoPaths } from "../../src/repo/index.js";

// B2: split + draft/undraft sugar + provenance stamps
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "Split children carry parent + `discovered-from` correctly"
//
// This file drives the compiled `dist/slop` binary as a real CLI —
// spawned subprocesses, asserting stdout/stderr/exit codes, the actual
// ticket files landed on disk, and the event log — the same pattern
// tests/acceptance/B1.test.ts and B3.test.ts already establish (see
// DECISIONS.md's D5 entry: vitest's test workers are real Node processes,
// not Bun, so the compiled binary must be spawned, not imported).
//
// Fixtures are built the same way B1/B3 build theirs: `ensureDbDirs` (the
// repo layer) plus a hand-written `config.yaml`, then `slop new`/`slop
// show`/`slop update`/`slop start` via CLI for everything else — NOT
// `slop init` (D1). `slop init` has landed by the time this file was
// written, but switching every fixture in this suite to it would add an
// autodetection/prompting surface (git remote, Jira prompt, Claude Code
// detection) this file has no need to depend on; B1/B3's existing
// convention is followed for consistency across the acceptance suite.

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
}, 60_000);

// ---------------------------------------------------------------------------
// Fixture + spawn helpers (same shape as B1.test.ts / B3.test.ts)
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

interface Fixture {
  root: string;
  paths: RepoPaths;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "slop-b2-"));
  scratchDirs.push(root);
  const paths = await ensureDbDirs(root);
  const lines = [
    "project: b2-fixture",
    "user: ryan",
    "remotes:",
    "defaults:",
    "  stale_after: 60m",
    "  review_stale_after: 24h",
    "transcripts: local",
  ];
  await writeFile(join(paths.slopDir, "config.yaml"), `${lines.join("\n")}\n`, "utf8");
  return { root, paths };
}

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Same env-stripping rationale as B1.test.ts's `runSlop`: this suite must
 * give sound actor-kind/harness assertions even when it happens to run
 * inside a real agent harness. */
function runSlop(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDECODE: undefined,
    OPENCODE: undefined,
    CODEX_SANDBOX: undefined,
    CODEX_SANDBOX_NETWORK_DISABLED: undefined,
  };
  for (const [k, v] of Object.entries(envOverrides)) env[k] = v;
  return spawnSync(binaryPath, args, { cwd, encoding: "utf8", env });
}

async function readTicketFile(paths: RepoPaths, id: string): Promise<Ticket> {
  const raw = await readFile(join(paths.ticketsDir, `${id}.jsonc`), "utf8");
  const { value, errors } = parseJsonc<unknown>(raw);
  expect(errors, `ticket file ${id} should be valid JSONC`).toEqual([]);
  return ticketSchema.parse(value);
}

/** Matches every `created <id>  (slug: <slug>)` line in stdout — `new`
 * emits exactly one, `split` emits one per child, both flush-left. */
const CREATED_LINE_RE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/gm;

function parseCreatedLines(stdout: string): { id: string; slug: string }[] {
  return [...stdout.matchAll(CREATED_LINE_RE)].map((m) => {
    const id = m[1];
    const slug = m[2];
    if (!id || !slug) throw new Error(`could not parse a "created" line out of:\n${stdout}`);
    return { id, slug };
  });
}

async function createTicketViaCli(
  fixture: Fixture,
  name: string,
  extraArgs: string[] = [],
): Promise<{ id: string; slug: string }> {
  const result = runSlop(["new", name, ...extraArgs], fixture.root);
  expect(result.status, result.stderr).toBe(0);
  const [created] = parseCreatedLines(result.stdout);
  if (!created) throw new Error(`"new" produced no parseable "created" line:\n${result.stdout}`);
  return created;
}

interface EventJson {
  id: string;
  verb: string;
  entity: { kind: string; id: string };
  payload: Record<string, unknown>;
}

function eventsFor(root: string, ticketRef: string): EventJson[] {
  const result = runSlop(["events", "--ticket", ticketRef, "--json"], root);
  expect(result.status, result.stderr).toBe(0);
  const parsed = JSON.parse(result.stdout) as { events: EventJson[] };
  return parsed.events;
}

// ---------------------------------------------------------------------------
// Clause: "Split children carry parent + `discovered-from` correctly"
// ---------------------------------------------------------------------------

describe("B2: split + draft/undraft", () => {
  describe('"Split children carry parent + `discovered-from` correctly"', () => {
    it("splitting a ticket into several: each child carries parent=source, a discovered-from edge to source, correct root_id/path, and provenance.method='split' with split_from set", async () => {
      const fixture = await makeFixture();
      const source = await createTicketViaCli(fixture, "Big feature");

      const result = runSlop(
        ["split", source.slug, "Piece A", "Piece B", "Piece C"],
        fixture.root,
      );
      expect(result.status, result.stderr).toBe(0);
      const created = parseCreatedLines(result.stdout);
      expect(created).toHaveLength(3);

      for (const { id } of created) {
        const child = await readTicketFile(fixture.paths, id);
        expect(child.parent).toBe(source.id);
        expect(child.discovered_from).toEqual([source.id]);
        expect(child.root_id).toBe(source.id);
        expect(child.path).toEqual([source.id]);
        expect(child.provenance.method).toBe("split");
        expect(child.provenance.split_from).toBe(source.id);
      }

      // Every child got its own distinct id and a name-derived slug.
      expect(new Set(created.map((c) => c.id)).size).toBe(3);
      expect(created.map((c) => c.slug).sort()).toEqual(["piece-a", "piece-b", "piece-c"]);
    });

    it("splitting a child of an already-parented ticket: ancestry is correct two levels deep", async () => {
      const fixture = await makeFixture();
      const root = await createTicketViaCli(fixture, "Root ticket");
      const mid = await createTicketViaCli(fixture, "Mid ticket", ["--parent", root.slug]);

      const result = runSlop(["split", mid.slug, "Leaf"], fixture.root);
      expect(result.status, result.stderr).toBe(0);
      const [leafCreated] = parseCreatedLines(result.stdout);
      if (!leafCreated) throw new Error("split produced no child");

      const leaf = await readTicketFile(fixture.paths, leafCreated.id);
      expect(leaf.parent).toBe(mid.id);
      expect(leaf.root_id).toBe(root.id);
      expect(leaf.path).toEqual([root.id, mid.id]);
      expect(leaf.discovered_from).toEqual([mid.id]);
      expect(leaf.provenance).toEqual({
        method: "split",
        created_by: { name: "ryan", kind: "human" },
        split_from: mid.id,
      });
    });

    it("splitting a ticket whose OWN parent is external (jira:) parents the child to the local split target (D1)", async () => {
      const fixture = await makeFixture();
      const jiraParented = await createTicketViaCli(fixture, "Jira-parented ticket", [
        "--parent",
        "jira:PROJ-1",
      ]);
      // Sanity check on the fixture itself: D1's "external parents
      // terminate the local tree" — this ticket is already its own local root.
      const beforeSplit = await readTicketFile(fixture.paths, jiraParented.id);
      expect(beforeSplit.root_id).toBe(jiraParented.id);
      expect(beforeSplit.path).toEqual([]);

      const result = runSlop(
        ["split", jiraParented.slug, "Child of jira-parented ticket"],
        fixture.root,
      );
      expect(result.status, result.stderr).toBe(0);
      const [childCreated] = parseCreatedLines(result.stdout);
      if (!childCreated) throw new Error("split produced no child");

      const child = await readTicketFile(fixture.paths, childCreated.id);
      expect(child.parent).toBe(jiraParented.id);
      expect(child.root_id).toBe(jiraParented.id);
      expect(child.path).toEqual([jiraParented.id]);
      expect(child.discovered_from).toEqual([jiraParented.id]);
    });
  });

  // -------------------------------------------------------------------------
  // Inheritance (B2's decision — see src/tickets/split.ts's module doc)
  // -------------------------------------------------------------------------

  describe("inheritance from the split target", () => {
    it("inherits labels and priority; does NOT inherit owner, adhoc, or state", async () => {
      const fixture = await makeFixture();
      const source = await createTicketViaCli(fixture, "Inherit source", [
        "--label",
        "team:core",
        "--priority",
        "0",
        "--owner",
        "ryan",
        "--adhoc",
      ]);
      const startResult = runSlop(["start", source.slug], fixture.root);
      expect(startResult.status, startResult.stderr).toBe(0);

      const result = runSlop(["split", source.slug, "Inherited child"], fixture.root);
      expect(result.status, result.stderr).toBe(0);
      const [created] = parseCreatedLines(result.stdout);
      if (!created) throw new Error("split produced no child");
      const child = await readTicketFile(fixture.paths, created.id);

      expect(child.labels).toEqual(["team:core"]);
      expect(child.priority).toBe(0);
      expect(child.owner).toBeNull();
      expect(child.adhoc).toBe(false);
      expect(child.state).toBe("open");
    });

    it("each child gets its own fresh, name-derived spec — not a copy of the parent's", async () => {
      const fixture = await makeFixture();
      const source = await createTicketViaCli(fixture, "Spec source", [
        "--spec",
        JSON.stringify({ summary: "Parent summary", details_md: "parent details" }),
      ]);
      const result = runSlop(["split", source.slug, "Fresh spec child"], fixture.root);
      expect(result.status, result.stderr).toBe(0);
      const [created] = parseCreatedLines(result.stdout);
      if (!created) throw new Error("split produced no child");
      const child = await readTicketFile(fixture.paths, created.id);
      expect(child.spec.summary).toBe("Fresh spec child");
      expect(child.spec.details_md).toBe("");
    });
  });

  // -------------------------------------------------------------------------
  // Slugs / batch mechanics
  // -------------------------------------------------------------------------

  describe("split slug + batch mechanics", () => {
    it("duplicate names within one split get collision-suffixed slugs against the live taken-set", async () => {
      const fixture = await makeFixture();
      const source = await createTicketViaCli(fixture, "Dup source");
      const result = runSlop(["split", source.slug, "Same name", "Same name"], fixture.root);
      expect(result.status, result.stderr).toBe(0);
      const created = parseCreatedLines(result.stdout);
      expect(created.map((c) => c.slug).sort()).toEqual(["same-name", "same-name-2"]);
    });

    it("a blank sub-ticket name is rejected up front (exit 2) — nothing is created", async () => {
      const fixture = await makeFixture();
      const source = await createTicketViaCli(fixture, "Guard source");
      const before = (await readdir(fixture.paths.ticketsDir)).length;

      const result = runSlop(["split", source.slug, "Valid name", "   "], fixture.root);
      expect(result.status).toBe(2); // USAGE_ERROR

      const after = (await readdir(fixture.paths.ticketsDir)).length;
      expect(after).toBe(before);
    });

    it("splitting an unresolvable ref fails NOT_FOUND (exit 4)", async () => {
      const fixture = await makeFixture();
      const result = runSlop(["split", "no-such-ticket", "Sub"], fixture.root);
      expect(result.status).toBe(4);
    });

    it("bumps the split target's own last_activity_at/updated_at (genuine activity happened to it)", async () => {
      const fixture = await makeFixture();
      const source = await createTicketViaCli(fixture, "Activity bump source");
      const before = await readTicketFile(fixture.paths, source.id);
      await new Promise((r) => setTimeout(r, 5));

      const result = runSlop(["split", source.slug, "Child"], fixture.root);
      expect(result.status, result.stderr).toBe(0);

      const after = await readTicketFile(fixture.paths, source.id);
      expect(Date.parse(after.last_activity_at)).toBeGreaterThan(
        Date.parse(before.last_activity_at),
      );
      expect(Date.parse(after.updated_at)).toBeGreaterThan(Date.parse(before.updated_at));
      // Splitting never touches the target's own state/fields beyond activity stamps.
      expect(after.state).toBe(before.state);
      expect(after.name).toBe(before.name);
    });
  });

  // -------------------------------------------------------------------------
  // Events (design.md event.ts's own documented split scheme: "one event
  // on the parent; each child gets its own separate ticket.created")
  // -------------------------------------------------------------------------

  describe("split events", () => {
    it("emits exactly one ticket.split on the source, and a ticket.created for each child", async () => {
      const fixture = await makeFixture();
      const source = await createTicketViaCli(fixture, "Event source");

      const result = runSlop(["split", source.slug, "Child A", "Child B"], fixture.root);
      expect(result.status, result.stderr).toBe(0);
      const created = parseCreatedLines(result.stdout);

      const sourceEvents = eventsFor(fixture.root, source.id);
      const splitEvents = sourceEvents.filter((e) => e.verb === "ticket.split");
      expect(splitEvents).toHaveLength(1);
      const splitEvent = splitEvents[0];
      if (!splitEvent) throw new Error("unreachable");
      expect(splitEvent.entity).toEqual({ kind: "ticket", id: source.id });
      const payloadChildren = splitEvent.payload.children as { id: string; slug: string }[];
      expect(payloadChildren.map((c) => c.id).sort()).toEqual(created.map((c) => c.id).sort());

      for (const child of created) {
        const childEvents = eventsFor(fixture.root, child.id);
        const createdEvents = childEvents.filter((e) => e.verb === "ticket.created");
        expect(createdEvents).toHaveLength(1);
        expect(createdEvents[0]?.payload.method).toBe("split");
        expect(createdEvents[0]?.payload.split_from).toBe(source.id);
      }
    });
  });

  // -------------------------------------------------------------------------
  // draft / undraft
  // -------------------------------------------------------------------------

  describe("draft / undraft", () => {
    it("round-trips open -> draft -> open", async () => {
      const fixture = await makeFixture();
      const ticket = await createTicketViaCli(fixture, "Round trip ticket");
      expect((await readTicketFile(fixture.paths, ticket.id)).state).toBe("open");

      const draftResult = runSlop(["draft", ticket.slug], fixture.root);
      expect(draftResult.status, draftResult.stderr).toBe(0);
      expect((await readTicketFile(fixture.paths, ticket.id)).state).toBe("draft");

      const undraftResult = runSlop(["undraft", ticket.slug], fixture.root);
      expect(undraftResult.status, undraftResult.stderr).toBe(0);
      expect((await readTicketFile(fixture.paths, ticket.id)).state).toBe("open");
    });

    it("a drafted ticket does not appear in `slop ready` (D13: drafts never ready)", async () => {
      const fixture = await makeFixture();
      const ticket = await createTicketViaCli(fixture, "Should not be ready when drafted");

      const readyBefore = runSlop(["ready", "--json"], fixture.root);
      expect(readyBefore.status, readyBefore.stderr).toBe(0);
      const beforeIds = (JSON.parse(readyBefore.stdout) as { ready: { id: string }[] }).ready.map(
        (r) => r.id,
      );
      expect(beforeIds).toContain(ticket.id);

      const draftResult = runSlop(["draft", ticket.slug], fixture.root);
      expect(draftResult.status, draftResult.stderr).toBe(0);

      const readyAfter = runSlop(["ready", "--json"], fixture.root);
      expect(readyAfter.status, readyAfter.stderr).toBe(0);
      const afterIds = (JSON.parse(readyAfter.stdout) as { ready: { id: string }[] }).ready.map(
        (r) => r.id,
      );
      expect(afterIds).not.toContain(ticket.id);

      // ...and undrafting brings it back.
      const undraftResult = runSlop(["undraft", ticket.slug], fixture.root);
      expect(undraftResult.status, undraftResult.stderr).toBe(0);
      const readyRestored = runSlop(["ready", "--json"], fixture.root);
      const restoredIds = (
        JSON.parse(readyRestored.stdout) as { ready: { id: string }[] }
      ).ready.map((r) => r.id);
      expect(restoredIds).toContain(ticket.id);
    });

    it("illegal draft: an in_progress ticket cannot be drafted (exit 6)", async () => {
      const fixture = await makeFixture();
      const ticket = await createTicketViaCli(fixture, "In progress, cannot draft");
      const startResult = runSlop(["start", ticket.slug], fixture.root);
      expect(startResult.status, startResult.stderr).toBe(0);

      const draftResult = runSlop(["draft", ticket.slug], fixture.root);
      expect(draftResult.status).toBe(6); // CONFLICT
      expect(draftResult.stderr).toMatch(/cannot draft/);
      expect((await readTicketFile(fixture.paths, ticket.id)).state).toBe("in_progress");
    });

    it("illegal undraft: an in_progress ticket cannot be undrafted (exit 6 — that's `stop`'s edge, not `undraft`'s)", async () => {
      const fixture = await makeFixture();
      const ticket = await createTicketViaCli(fixture, "In progress, cannot undraft");
      const startResult = runSlop(["start", ticket.slug], fixture.root);
      expect(startResult.status, startResult.stderr).toBe(0);

      const undraftResult = runSlop(["undraft", ticket.slug], fixture.root);
      expect(undraftResult.status).toBe(6); // CONFLICT
      expect(undraftResult.stderr).toMatch(/cannot undraft/);
      expect((await readTicketFile(fixture.paths, ticket.id)).state).toBe("in_progress");
    });

    it("illegal draft/undraft against a terminal (dropped) ticket: both exit 6", async () => {
      const fixture = await makeFixture();
      const ticket = await createTicketViaCli(fixture, "Dropped ticket");
      const dropResult = runSlop(["update", ticket.slug, "--state", "dropped"], fixture.root);
      expect(dropResult.status, dropResult.stderr).toBe(0);

      const draftResult = runSlop(["draft", ticket.slug], fixture.root);
      expect(draftResult.status).toBe(6);

      const undraftResult = runSlop(["undraft", ticket.slug], fixture.root);
      expect(undraftResult.status).toBe(6);
    });

    it("draft/undraft on an unresolvable ref fails NOT_FOUND (exit 4)", async () => {
      const fixture = await makeFixture();
      expect(runSlop(["draft", "no-such-ticket"], fixture.root).status).toBe(4);
      expect(runSlop(["undraft", "no-such-ticket"], fixture.root).status).toBe(4);
    });

    it("emits ticket.state_changed with the correct from/to for both draft and undraft", async () => {
      const fixture = await makeFixture();
      const ticket = await createTicketViaCli(fixture, "Event draft ticket");

      expect(runSlop(["draft", ticket.slug], fixture.root).status).toBe(0);
      expect(runSlop(["undraft", ticket.slug], fixture.root).status).toBe(0);

      const events = eventsFor(fixture.root, ticket.id);
      const stateChanges = events.filter((e) => e.verb === "ticket.state_changed");
      expect(stateChanges).toHaveLength(2);
      expect(stateChanges[0]?.payload).toMatchObject({ from: "open", to: "draft" });
      expect(stateChanges[1]?.payload).toMatchObject({ from: "draft", to: "open" });
    });
  });
});
