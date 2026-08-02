import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// G3: CLI workbench (t-km7mb, t-175oq, t-mmngo, t-9uvbr, t-trqk9)
//
// Acceptance-level coverage against the REAL compiled binary (same
// spawn-a-subprocess convention as G2.test.ts and most other
// tests/acceptance/*.test.ts files) — this is the surface a real agent or
// script actually drives, so it's what gets exercised end to end here
// rather than importing the command modules in-process.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
  // Same "build if missing" convention as A1.test.ts / G2.test.ts / etc.
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

function runSlop(args: string[], cwd: string, input?: string) {
  return spawnSync(binaryPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
    input,
  });
}

async function makeScratchRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  const init = runSlop(["init", "--yes", "--project", "g3-fixture", "--user", "g3-tester"], dir);
  if (init.status !== 0) {
    throw new Error(`slop init failed in fixture setup: ${init.stderr}`);
  }
  return dir;
}

interface NewTicketJson {
  id: string;
  slug: string;
  handle: string;
  name: string;
  state: string;
  priority: number;
  parent: string | null;
}

function newTicket(dir: string, name: string, ...extraArgs: string[]): NewTicketJson {
  const result = runSlop(["new", name, "--json", ...extraArgs], dir);
  if (result.status !== 0) {
    throw new Error(`slop new "${name}" failed in fixture setup: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as NewTicketJson;
}

interface ShowJson {
  ticket: {
    id: string;
    slug: string;
    state: string;
    priority: number;
    owner: { name: string; kind: string } | null;
    parent?: string;
    root_id: string;
    path: string[];
    discovered_from: string[];
  };
}

function show(dir: string, ref: string): ShowJson {
  const result = runSlop(["show", ref, "--json"], dir);
  if (result.status !== 0) {
    throw new Error(`slop show "${ref}" failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as ShowJson;
}

describe("G3: CLI workbench", () => {
  // -------------------------------------------------------------------------
  // t-km7mb: slop list
  // -------------------------------------------------------------------------

  describe("slop list", () => {
    it("filters by state/label/owner/priority/free-text and sorts deterministically (state, then priority, then age)", async () => {
      const dir = await makeScratchRepo("slop-g3-list-");
      const alpha = newTicket(dir, "Alpha", "--label", "area:auth", "--priority", "1");
      const beta = newTicket(
        dir,
        "Beta",
        "--label",
        "area:web",
        "--priority",
        "0",
        "--owner",
        "agent:codex-3",
      );
      const gamma = newTicket(dir, "Gamma", "--label", "area:auth", "--priority", "2");
      const dropped = runSlop(["drop", gamma.id, "--reason", "wontdo"], dir);
      expect(dropped.status, dropped.stderr).toBe(0);

      const all = JSON.parse(runSlop(["list", "--json"], dir).stdout) as {
        tickets: { id: string }[];
        total: number;
      };
      // open tickets (beta p0, alpha p1) sort before the dropped one
      // (gamma) regardless of priority — state beats priority.
      expect(all.tickets.map((t) => t.id)).toEqual([beta.id, alpha.id, gamma.id]);
      expect(all.total).toBe(3);

      const byLabel = JSON.parse(
        runSlop(["list", "--label", "area:auth", "--json"], dir).stdout,
      ) as { tickets: { id: string }[] };
      expect(byLabel.tickets.map((t) => t.id).sort()).toEqual([alpha.id, gamma.id].sort());

      const byOwner = JSON.parse(runSlop(["list", "--owner", "codex-3", "--json"], dir).stdout) as {
        tickets: { id: string }[];
      };
      expect(byOwner.tickets.map((t) => t.id)).toEqual([beta.id]);

      const byState = JSON.parse(runSlop(["list", "--state", "dropped", "--json"], dir).stdout) as {
        tickets: { id: string }[];
      };
      expect(byState.tickets.map((t) => t.id)).toEqual([gamma.id]);

      const byText = JSON.parse(runSlop(["list", "beta", "--json"], dir).stdout) as {
        tickets: { id: string }[];
      };
      expect(byText.tickets.map((t) => t.id)).toEqual([beta.id]);

      const byPriority = JSON.parse(runSlop(["list", "--priority", "0", "--json"], dir).stdout) as {
        tickets: { id: string }[];
      };
      expect(byPriority.tickets.map((t) => t.id)).toEqual([beta.id]);
    });

    it("--parent filters to DIRECT children only; --subtree filters the whole descendant tree, inclusive", async () => {
      const dir = await makeScratchRepo("slop-g3-list-tree-");
      const root = newTicket(dir, "Root");
      const child = newTicket(dir, "Child", "--parent", root.id);
      const grandchild = newTicket(dir, "Grandchild", "--parent", child.id);
      const unrelated = newTicket(dir, "Unrelated");

      const direct = JSON.parse(runSlop(["list", "--parent", root.id, "--json"], dir).stdout) as {
        tickets: { id: string }[];
      };
      expect(direct.tickets.map((t) => t.id)).toEqual([child.id]);

      const subtree = JSON.parse(runSlop(["list", "--subtree", root.id, "--json"], dir).stdout) as {
        tickets: { id: string }[];
      };
      expect(subtree.tickets.map((t) => t.id).sort()).toEqual(
        [root.id, child.id, grandchild.id].sort(),
      );
      expect(subtree.tickets.map((t) => t.id)).not.toContain(unrelated.id);
    });

    it("--limit/--offset paginate; total reflects the full filtered count before paging", async () => {
      const dir = await makeScratchRepo("slop-g3-list-page-");
      for (let i = 0; i < 5; i++) newTicket(dir, `Ticket ${i}`, "--priority", String(i % 4));

      const page1 = JSON.parse(
        runSlop(["list", "--limit", "2", "--offset", "0", "--json"], dir).stdout,
      ) as { tickets: unknown[]; total: number; returned: number };
      expect(page1.tickets).toHaveLength(2);
      expect(page1.total).toBe(5);
      expect(page1.returned).toBe(2);

      const page2 = JSON.parse(
        runSlop(["list", "--limit", "2", "--offset", "2", "--json"], dir).stdout,
      ) as { tickets: unknown[]; total: number };
      expect(page2.tickets).toHaveLength(2);
      expect(page2.total).toBe(5);
    });

    it("--budget degrades to smaller, still-valid JSON — never truncated/corrupt", async () => {
      const dir = await makeScratchRepo("slop-g3-list-budget-");
      for (let i = 0; i < 8; i++) newTicket(dir, `Budget ticket number ${i} with a longish name`);

      const result = runSlop(["list", "--json", "--budget", "1"], dir);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as { tickets: unknown[]; elided: string[] };
      expect(Array.isArray(body.tickets)).toBe(true);
      expect(body.elided.length).toBeGreaterThan(0);
    });

    it("rejects an unknown --state as a usage error", async () => {
      const dir = await makeScratchRepo("slop-g3-list-badstate-");
      const result = runSlop(["list", "--state", "not-a-state"], dir);
      expect(result.status).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // t-175oq: ready --label (repeatable) / --owner / --priority
  // -------------------------------------------------------------------------

  describe("ready: repeatable --label (AND), --owner, --priority", () => {
    it("every given filter must match (AND across --label/--owner/--priority)", async () => {
      const dir = await makeScratchRepo("slop-g3-ready-");
      const matches = newTicket(
        dir,
        "Matches everything",
        "--label",
        "x",
        "--label",
        "y",
        "--priority",
        "1",
        "--owner",
        "priya",
      );
      newTicket(dir, "Missing label y", "--label", "x", "--priority", "1", "--owner", "priya");
      newTicket(
        dir,
        "Wrong priority",
        "--label",
        "x",
        "--label",
        "y",
        "--priority",
        "2",
        "--owner",
        "priya",
      );
      newTicket(dir, "Wrong owner", "--label", "x", "--label", "y", "--priority", "1");

      const result = runSlop(
        ["ready", "--label", "x", "--label", "y", "--owner", "priya", "--priority", "1", "--json"],
        dir,
      );
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as { ready: { id: string }[] };
      expect(body.ready.map((r) => r.id)).toEqual([matches.id]);
    });
  });

  // -------------------------------------------------------------------------
  // t-mmngo: bulk multi-ref on done/drop/update
  // -------------------------------------------------------------------------

  describe("bulk multi-ref: done/drop/update", () => {
    it("done applies per-ref (mixed success/failure), --json results[], exit = most severe code", async () => {
      const dir = await makeScratchRepo("slop-g3-bulk-done-");
      const a = newTicket(dir, "A");
      const b = newTicket(dir, "B");
      expect(runSlop(["start", a.id], dir).status).toBe(0);
      expect(runSlop(["start", b.id], dir).status).toBe(0);

      const result = runSlop(
        ["done", a.id, b.id, "no-such-ticket-at-all", "--note", "batch closed", "--json"],
        dir,
      );
      // a/b succeed (exit 0 each); the bad ref is NOT_FOUND (4) — the most
      // (only) severe failing code among the three.
      expect(result.status).toBe(4);
      const body = JSON.parse(result.stdout) as {
        results: { ref: string; ok: boolean; exit_code: number }[];
        ok: boolean;
        succeeded: number;
        failed: number;
      };
      expect(body.ok).toBe(false);
      expect(body.succeeded).toBe(2);
      expect(body.failed).toBe(1);
      const okRefs = body.results.filter((r) => r.ok).map((r) => r.ref);
      expect(okRefs.sort()).toEqual([a.id, b.id].sort());
      const badRow = body.results.find((r) => r.ref === "no-such-ticket-at-all");
      expect(badRow?.ok).toBe(false);
      expect(badRow?.exit_code).toBe(4);
    });

    it("refs readable from stdin via '-', one per line", async () => {
      const dir = await makeScratchRepo("slop-g3-bulk-stdin-");
      const a = newTicket(dir, "A");
      const b = newTicket(dir, "B");

      const result = runSlop(
        ["update", "-", "--label", "+triaged", "--json"],
        dir,
        `${a.id}\n${b.id}\n`,
      );
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as { succeeded: number; failed: number };
      expect(body.succeeded).toBe(2);
      expect(body.failed).toBe(0);

      expect(show(dir, a.id).ticket).toBeDefined();
      const shownA = runSlop(["show", a.id, "--json"], dir);
      expect(JSON.parse(shownA.stdout).ticket.labels).toContain("triaged");
    });

    it("single-ref output is byte-compatible with the pre-bulk shape (flat --json, no results[] wrapper)", async () => {
      const dir = await makeScratchRepo("slop-g3-bulk-single-");
      const a = newTicket(dir, "A");
      const result = runSlop(["update", a.id, "--priority", "0", "--json"], dir);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(body.results).toBeUndefined();
      expect(body.id).toBe(a.id);
      expect(body.priority).toBe(0);
    });

    it("drop: bulk text output is one line per ref; a failing ref's line goes to stderr, not stdout", async () => {
      const dir = await makeScratchRepo("slop-g3-bulk-drop-text-");
      const a = newTicket(dir, "A");
      const b = newTicket(dir, "B");

      const result = runSlop(["drop", a.id, b.id, "no-such-ref", "--reason", "wontdo"], dir);
      expect(result.status).toBe(4); // NOT_FOUND from the bad ref
      expect(result.stdout).toMatch(new RegExp(`${a.id} -> dropped`));
      expect(result.stdout).toMatch(new RegExp(`${b.id} -> dropped`));
      expect(result.stdout).not.toMatch(/no-such-ref/);
      expect(result.stderr).toMatch(/no-such-ref/);
    });

    it("all refs succeeding exits 0 even in bulk mode", async () => {
      const dir = await makeScratchRepo("slop-g3-bulk-allgood-");
      const a = newTicket(dir, "A");
      const b = newTicket(dir, "B");
      const result = runSlop(["update", a.id, b.id, "--label", "+ok", "--json"], dir);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as { ok: boolean; failed: number };
      expect(body.ok).toBe(true);
      expect(body.failed).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // t-9uvbr: update --clear-owner/--clear-parent/--discovered-from, agent owners
  // -------------------------------------------------------------------------

  describe("update: clear-owner/clear-parent/discovered-from, agent-kind owners", () => {
    it("--clear-owner clears an owner set at creation, on a non-TTY", async () => {
      const dir = await makeScratchRepo("slop-g3-clear-owner-");
      const a = newTicket(dir, "A", "--owner", "priya");
      expect(show(dir, a.id).ticket.owner).toEqual({ name: "priya", kind: "human" });

      const result = runSlop(["update", a.id, "--clear-owner", "--json"], dir);
      expect(result.status, result.stderr).toBe(0);
      expect(show(dir, a.id).ticket.owner).toBeNull();
    });

    it("--owner and --clear-owner are mutually exclusive (usage error)", async () => {
      const dir = await makeScratchRepo("slop-g3-clear-owner-mutex-");
      const a = newTicket(dir, "A");
      const result = runSlop(["update", a.id, "--owner", "priya", "--clear-owner"], dir);
      expect(result.status).toBe(2);
    });

    it("--clear-parent recomputes root_id/path for the ticket AND every existing descendant", async () => {
      const dir = await makeScratchRepo("slop-g3-clear-parent-");
      const root = newTicket(dir, "Root");
      const child = newTicket(dir, "Child", "--parent", root.id);
      const grandchild = newTicket(dir, "Grandchild", "--parent", child.id);

      const result = runSlop(["update", child.id, "--clear-parent", "--json"], dir);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as { reparented_descendants: number };
      expect(body.reparented_descendants).toBe(1);

      const shownChild = show(dir, child.id);
      expect(shownChild.ticket.parent).toBeUndefined();
      expect(shownChild.ticket.root_id).toBe(child.id);
      expect(shownChild.ticket.path).toEqual([]);

      const shownGrandchild = show(dir, grandchild.id);
      expect(shownGrandchild.ticket.root_id).toBe(child.id);
      expect(shownGrandchild.ticket.path).toEqual([child.id]);
    });

    it("--parent and --clear-parent are mutually exclusive (usage error)", async () => {
      const dir = await makeScratchRepo("slop-g3-clear-parent-mutex-");
      const root = newTicket(dir, "Root");
      const child = newTicket(dir, "Child", "--parent", root.id);
      const result = runSlop(["update", child.id, "--parent", root.id, "--clear-parent"], dir);
      expect(result.status).toBe(2);
    });

    it("--discovered-from +ref/-ref adds and removes an edge after creation (previously edit-only)", async () => {
      const dir = await makeScratchRepo("slop-g3-discovered-from-");
      const a = newTicket(dir, "A");
      const b = newTicket(dir, "B");

      const add = runSlop(["update", b.id, "--discovered-from", `+${a.id}`, "--json"], dir);
      expect(add.status, add.stderr).toBe(0);
      expect(show(dir, b.id).ticket.discovered_from).toEqual([a.id]);

      const remove = runSlop(["update", b.id, "--discovered-from", `-${a.id}`, "--json"], dir);
      expect(remove.status, remove.stderr).toBe(0);
      expect(show(dir, b.id).ticket.discovered_from).toEqual([]);
    });

    it("agent-kind owners round-trip through new/update/show, and a bare name still stays human (back-compat)", async () => {
      const dir = await makeScratchRepo("slop-g3-agent-owner-");
      const a = newTicket(dir, "A", "--owner", "agent:codex-3");
      expect(show(dir, a.id).ticket.owner).toEqual({ name: "codex-3", kind: "agent" });

      const toHuman = runSlop(["update", a.id, "--owner", "human:priya", "--json"], dir);
      expect(toHuman.status, toHuman.stderr).toBe(0);
      expect(show(dir, a.id).ticket.owner).toEqual({ name: "priya", kind: "human" });

      const bare = newTicket(dir, "B", "--owner", "priya");
      expect(show(dir, bare.id).ticket.owner).toEqual({ name: "priya", kind: "human" });

      const backToBare = runSlop(["update", a.id, "--owner", "ryan", "--json"], dir);
      expect(backToBare.status, backToBare.stderr).toBe(0);
      expect(show(dir, a.id).ticket.owner).toEqual({ name: "ryan", kind: "human" });
    });
  });

  // -------------------------------------------------------------------------
  // t-trqk9: slug shadowing — detect, resolve as ambiguous, heal
  // -------------------------------------------------------------------------

  describe("slug shadowing: detect duplicates, resolve as ambiguous, heal by re-suffix", () => {
    it("a cross-clone merge producing two tickets with the same slug is detected, resolves AMBIGUOUS_REF, and --heal re-suffixes the newer one deterministically", async () => {
      const dir = await makeScratchRepo("slop-g3-slug-shadow-");
      const ticketsDir = join(dir, ".slop", "db", "tickets");
      mkdirSync(ticketsDir, { recursive: true });

      // Simulate a cross-clone merge: two ticket files, hand-placed
      // directly (bypassing `slop new`'s own collision-avoidance
      // entirely, since a real merge never runs it either), sharing one
      // slug. IDs are chosen to be UNAMBIGUOUSLY oldest/newest by
      // construction (all-"0"s sorts before any real ULID; all-"Z"s
      // after) rather than relying on timing.
      const olderId = `ticket_${"0".repeat(26)}`;
      const newerId = `ticket_${"Z".repeat(26)}`;
      const now = "2026-07-23T10:00:00.000Z";

      function writeRawTicket(id: string, name: string): void {
        const ticket = {
          id,
          name,
          slug: "shared-slug",
          spec: { summary: name, details_md: "", acceptance: [], context: [], meta: {}, v: 1 },
          state: "open",
          priority: 2,
          labels: [],
          adhoc: false,
          blocks: [],
          relates_to: [],
          discovered_from: [],
          root_id: id,
          path: [],
          active_session: null,
          last_activity_at: now,
          latest_note: null,
          owner: null,
          provenance: { method: "new", created_by: { name: "g3-tester", kind: "human" } },
          created_at: now,
          updated_at: now,
        };
        writeFileSync(join(ticketsDir, `${id}.jsonc`), `${JSON.stringify(ticket, null, 2)}\n`);
      }

      writeRawTicket(olderId, "Original ticket");
      writeRawTicket(newerId, "Cross-clone duplicate ticket");

      // Detection: loud on stderr, exit 0 (a warning, not a failure) —
      // `reindex` still rebuilds/persists everything it CAN read.
      const reindexed = runSlop(["reindex"], dir);
      expect(reindexed.status, reindexed.stderr).toBe(0);
      expect(reindexed.stderr).toMatch(/duplicate/i);
      expect(reindexed.stderr).toContain("shared-slug");
      expect(reindexed.stderr).toContain(olderId);
      expect(reindexed.stderr).toContain(newerId);
      expect(reindexed.stdout).toMatch(/duplicate slug\(s\) found/i);

      // Resolution: never a silent pick — AMBIGUOUS_REF (exit 5), listing
      // every candidate.
      const ambiguous = runSlop(["show", "shared-slug"], dir);
      expect(ambiguous.status).toBe(5);
      expect(ambiguous.stderr).toContain(olderId);
      expect(ambiguous.stderr).toContain(newerId);

      // Heal: deterministic — the OLDER ticket (by id) keeps the slug,
      // the newer duplicate is re-suffixed git-style.
      const healed = runSlop(["reindex", "--heal"], dir);
      expect(healed.status, healed.stderr).toBe(0);
      expect(healed.stdout).toMatch(/healed 1 duplicate slug/i);

      const olderShown = runSlop(["show", "shared-slug", "--json"], dir);
      expect(olderShown.status, olderShown.stderr).toBe(0);
      expect((JSON.parse(olderShown.stdout) as ShowJson).ticket.id).toBe(olderId);

      const newerShown = runSlop(["show", "shared-slug-2", "--json"], dir);
      expect(newerShown.status, newerShown.stderr).toBe(0);
      expect((JSON.parse(newerShown.stdout) as ShowJson).ticket.id).toBe(newerId);

      // Post-heal: no ambiguity remains, and a plain `reindex` reports it clean.
      const clean = runSlop(["reindex"], dir);
      expect(clean.status, clean.stderr).toBe(0);
      expect(clean.stderr).toBe("");
      expect(clean.stdout).not.toMatch(/duplicate slug/i);
    });
  });
});
