import { type SpawnSyncReturns, execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Ticket, newTicketId, ticketSchema } from "../../src/core/index.js";
import type { EventContext, MutationEventSpec, RepoPaths } from "../../src/repo/index.js";
import { createTicket, ensureDbDirs } from "../../src/repo/index.js";

// E1: Polish
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "An agent can branch on exit codes; every read respects budget"
//
// Two clauses, proven separately below, both by spawning the compiled
// `dist/slop` binary (never source, never a function-level shortcut) —
// this project's established convention for anything that must be
// exercised as a genuine process (A1.test.ts, B4.test.ts, C1.test.ts, D3/
// D4.test.ts, ...):
//
//  1. "an agent can branch on exit codes" — an exit-code matrix across
//     several different commands, for a representative success AND for
//     each of usage/not-found/ambiguous/conflict, asserting the EXACT code
//     from src/core/exit-codes.ts's table, not just "nonzero".
//  2. "every read respects budget" — for every read command that accepts
//     `--budget` (`ready`, `show`, `context`, `status`, `search`,
//     `events`), a moderate budget genuinely bounds output length, AND
//     `--json --budget` stays valid, parseable JSON at budget 0, 1, and a
//     small-but-nonzero value — the exact defect (B4 adversarial review,
//     deferred to this work item) this item's report highlights.

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
// Shared fixture/spawn helpers (same shape as B4.test.ts/C1.test.ts/etc.)
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function runSlop(args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(binaryPath, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      OPENCODE: undefined,
      CODEX_SANDBOX: undefined,
      CODEX_SANDBOX_NETWORK_DISABLED: undefined,
    },
  });
}

async function makeCliFixture(project: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "slop-e1-cli-"));
  scratchDirs.push(root);
  const init = runSlop(["init", "--yes", "--project", project, "--user", "e1-tester"], root);
  expect(init.status, init.stderr).toBe(0);
  return root;
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

function newTicketCli(
  root: string,
  name: string,
  extraArgs: string[] = [],
): { id: string; slug: string } {
  const result = runSlop(["new", name, ...extraArgs], root);
  expect(result.status, result.stderr).toBe(0);
  const m = CREATED_LINE.exec(result.stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(
      `could not parse "created <id> (slug: <slug>)" out of stdout:\n${result.stdout}`,
    );
  }
  return { id: m[1], slug: m[2] };
}

function expectValidJson(text: string): unknown {
  expect(() => JSON.parse(text)).not.toThrow();
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Clause 1: "an agent can branch on exit codes"
// ---------------------------------------------------------------------------

describe("E1: Polish", () => {
  describe('"an agent can branch on exit codes"', () => {
    it("SUCCESS (0): a representative read/mutate command from each group exits 0", async () => {
      const root = await makeCliFixture("e1-success");
      const ticket = newTicketCli(root, "success matrix ticket");

      expect(runSlop(["ready"], root).status).toBe(0);
      expect(runSlop(["status"], root).status).toBe(0);
      expect(runSlop(["show", ticket.slug], root).status).toBe(0);
      expect(runSlop(["events"], root).status).toBe(0);
      expect(runSlop(["search", "success"], root).status).toBe(0);
      expect(runSlop(["context", ticket.slug], root).status).toBe(0);
      expect(runSlop(["update", ticket.slug, "--progress", "note"], root).status).toBe(0);
    });

    it("USAGE_ERROR (2): malformed flags and missing required arguments, across several commands", async () => {
      const root = await makeCliFixture("e1-usage");
      const ticket = newTicketCli(root, "usage matrix ticket");

      // E1's own exit-code audit fix: a malformed integer/enum flag value
      // used to exit 1 (GENERIC_ERROR) via a bare `throw new Error(...)`
      // inside the Commander option parser — see shared.ts's
      // parseIntegerOption doc for the full writeup. Verified here as a
      // regression guard, not just fixed silently.
      expect(runSlop(["new", "x", "--priority", "notanumber"], root).status).toBe(2);
      expect(runSlop(["ready", "--budget", "notanumber"], root).status).toBe(2);
      expect(runSlop(["start", ticket.slug, "--harness", "bogus"], root).status).toBe(2);

      // Commander's own required-arg/required-option enforcement must also
      // land on 2, not whatever Commander's internal exit code happens to
      // be (src/cli/index.ts maps every non-help/version CommanderError to
      // USAGE_ERROR).
      expect(runSlop(["new"], root).status).toBe(2); // missing <name>
      expect(runSlop(["drop", ticket.slug], root).status).toBe(2); // missing required --reason
      expect(runSlop(["plan", ticket.slug], root).status).toBe(2); // neither steps nor --check/--uncheck
      expect(runSlop(["search", "   "], root).status).toBe(2); // no non-whitespace search text
    });

    it("NOT_FOUND (4): an unresolvable <ref>, across several commands, and a missing .slop directory", async () => {
      const root = await makeCliFixture("e1-not-found");
      newTicketCli(root, "not-found matrix ticket");

      expect(runSlop(["show", "no-such-ticket-anywhere"], root).status).toBe(4);
      expect(runSlop(["start", "no-such-ticket-anywhere"], root).status).toBe(4);
      expect(runSlop(["update", "no-such-ticket-anywhere", "--progress", "x"], root).status).toBe(
        4,
      );
      expect(runSlop(["events", "--since", "event_01ARZ3NDEKTSV4RRFFQ69G5FAV"], root).status).toBe(
        4,
      ); // well-formed cursor shape, but no such event exists

      // A different NOT_FOUND path entirely: no .slop/ at all (repo-root
      // resolution, not ref resolution) — same code, different mechanism,
      // both documented in README's exit-code table as "a <ref> did not
      // resolve" / "not a slopworks repo".
      const noRepo = await mkdtemp(join(tmpdir(), "slop-e1-norepo-"));
      scratchDirs.push(noRepo);
      expect(runSlop(["status"], noRepo).status).toBe(4);
    });

    it("AMBIGUOUS_REF (5): a short prefix matching more than one ticket, across several commands", async () => {
      const root = await mkdtemp(join(tmpdir(), "slop-e1-ambiguous-"));
      scratchDirs.push(root);
      const paths: RepoPaths = await ensureDbDirs(root);
      const lines = [
        "project: e1-ambiguous",
        "user: e1-tester",
        "remotes:",
        "defaults:",
        "  stale_after: 60m",
        "  review_stale_after: 24h",
        "transcripts: local",
        "",
      ].join("\n");
      await writeFile(join(paths.slopDir, "config.yaml"), lines, "utf8");

      // Two tickets sharing a ULID prefix — same construction A3.test.ts's
      // own "ambiguous prefix" acceptance case uses.
      const shared = "01ARZ3NDEKTSV4RRFFQ69G5FA"; // 25 chars
      const ctx: EventContext = { actor: { name: "e1-tester", kind: "human" }, session: null };
      const createdEvent: MutationEventSpec = { verb: "ticket.created" };
      function makeTicket(overrides: Partial<Ticket>): Ticket {
        const id = overrides.id ?? newTicketId();
        return ticketSchema.parse({
          id,
          name: "Ticket",
          slug: `ticket-${id.slice(-8).toLowerCase()}`,
          spec: { summary: "s" },
          state: "open",
          root_id: id,
          provenance: { method: "new", created_by: { name: "e1-tester", kind: "human" } },
          last_activity_at: "2026-07-23T10:00:00.000Z",
          created_at: "2026-07-23T10:00:00.000Z",
          updated_at: "2026-07-23T10:00:00.000Z",
          ...overrides,
        });
      }
      const idA = `ticket_${shared}1` as Ticket["id"];
      const idB = `ticket_${shared}2` as Ticket["id"];
      const a = makeTicket({ id: idA, root_id: idA, name: "Alpha ticket", slug: "alpha-ticket" });
      const b = makeTicket({ id: idB, root_id: idB, name: "Beta ticket", slug: "beta-ticket" });
      await createTicket(paths, a, ctx, createdEvent);
      await createTicket(paths, b, ctx, createdEvent);

      const prefix = shared.slice(0, 10);
      const showResult = runSlop(["show", prefix], root);
      expect(showResult.status).toBe(5);
      expect(showResult.stderr).toMatch(/ambiguous/i);

      const startResult = runSlop(["start", prefix], root);
      expect(startResult.status).toBe(5);
      expect(startResult.stderr).toMatch(/ambiguous/i);
    });

    it("CONFLICT (6): illegal state transitions, across several commands", async () => {
      const root = await makeCliFixture("e1-conflict");
      const ticket = newTicketCli(root, "conflict matrix ticket");

      // done requires review first (C3: no in_progress -> done shortcut).
      expect(runSlop(["start", ticket.slug], root).status).toBe(0);
      expect(runSlop(["done", ticket.slug], root).status).toBe(6);

      // draft/undraft only apply to their one specific edge — an
      // in_progress ticket is illegal for both.
      expect(runSlop(["draft", ticket.slug], root).status).toBe(6);
      expect(runSlop(["undraft", ticket.slug], root).status).toBe(6);

      // A second `start` without --takeover, while one is already active,
      // is a conflict too (a different mechanism: session takeover, not a
      // ticket-state guard).
      const other = newTicketCli(root, "conflict matrix ticket 2");
      expect(runSlop(["start", other.slug], root).status).toBe(0);
      expect(runSlop(["start", other.slug], root).status).toBe(6);

      // review -> stop is not a legal edge either (C3: `slop done`/`slop
      // start` are the only ways out of review).
      expect(
        runSlop(["review", ticket.slug, "--mr", "https://example.com/mr/1"], root).status,
      ).toBe(0);
      expect(runSlop(["stop", ticket.slug], root).status).toBe(6);
    });
  });

  // ---------------------------------------------------------------------------
  // Clause 2: "every read respects budget"
  // ---------------------------------------------------------------------------

  describe('"every read respects budget"', () => {
    const LONG_DETAILS = "Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(30);

    /** A populated fixture exercising every read command's output surface:
     * several tickets (one with long prose, for context/show), a couple of
     * sessions (one stopped mid-way, one currently in progress), a
     * ticket in review with an MR, and the resulting events. */
    async function makeBudgetFixture(
      project: string,
    ): Promise<{ root: string; ticket: { id: string; slug: string } }> {
      const root = await makeCliFixture(project);
      const ticket = newTicketCli(root, "budget matrix primary ticket", [
        "--spec",
        JSON.stringify({ summary: "primary ticket summary", details_md: LONG_DETAILS }),
      ]);
      for (let i = 0; i < 4; i++) newTicketCli(root, `budget matrix candidate ${i}`);

      expect(runSlop(["start", ticket.slug], root).status).toBe(0);
      expect(
        runSlop(["update", ticket.slug, "--progress", "made some progress"], root).status,
      ).toBe(0);
      expect(
        runSlop(["review", ticket.slug, "--mr", "https://example.com/mr/9"], root).status,
      ).toBe(0);

      const second = newTicketCli(root, "budget matrix secondary ticket");
      expect(runSlop(["start", second.slug], root).status).toBe(0);

      return { root, ticket };
    }

    /** Common assertions for a `--json --budget <tiny>` call: exits 0 and
     * the body is always valid, parseable JSON — the E1 defect fix
     * (`core/budget.ts`'s "never corrupt JSON on a success exit"),
     * verified for every read command, not just `ready`. */
    function assertJsonBudgetNeverCorrupts(args: string[], root: string): void {
      for (const budget of [0, 1, 5]) {
        const result = runSlop([...args, "--json", "--budget", String(budget)], root);
        expect(result.status, `${args.join(" ")} --json --budget ${budget}: ${result.stderr}`).toBe(
          0,
        );
        expectValidJson(result.stdout);
      }
    }

    it("ready: a moderate --budget bounds text output, and --json --budget stays valid at 0/1/tiny", async () => {
      const { root } = await makeBudgetFixture("e1-budget-ready");
      const full = runSlop(["ready", "--resumable"], root).stdout;
      const budget = Math.max(1, Math.floor(full.length / 2));
      const bounded = runSlop(["ready", "--resumable", "--budget", String(budget)], root);
      expect(bounded.status, bounded.stderr).toBe(0);
      expect(bounded.stdout.length).toBeLessThanOrEqual(budget);

      assertJsonBudgetNeverCorrupts(["ready", "--resumable"], root);
    });

    it("search: a moderate --budget bounds text output, and --json --budget stays valid at 0/1/tiny", async () => {
      const { root } = await makeBudgetFixture("e1-budget-search");
      const full = runSlop(["search", "budget"], root).stdout;
      const budget = Math.max(1, Math.floor(full.length / 2));
      const bounded = runSlop(["search", "budget", "--budget", String(budget)], root);
      expect(bounded.status, bounded.stderr).toBe(0);
      expect(bounded.stdout.length).toBeLessThanOrEqual(budget);

      assertJsonBudgetNeverCorrupts(["search", "budget"], root);
    });

    it("events: a moderate --budget bounds text output, and --json --budget stays valid at 0/1/tiny", async () => {
      const { root } = await makeBudgetFixture("e1-budget-events");
      const full = runSlop(["events"], root).stdout;
      const budget = Math.max(1, Math.floor(full.length / 2));
      const bounded = runSlop(["events", "--budget", String(budget)], root);
      expect(bounded.status, bounded.stderr).toBe(0);
      expect(bounded.stdout.length).toBeLessThanOrEqual(budget);

      assertJsonBudgetNeverCorrupts(["events"], root);

      // Budget-driven elision must keep next_cursor/has_more coherent with
      // what was ACTUALLY returned (this file's events.ts doc) — a tiny
      // budget should report has_more: true once it starts dropping events.
      const tiny = runSlop(["events", "--json", "--budget", "5"], root);
      const parsed = expectValidJson(tiny.stdout) as { events: unknown[]; has_more: boolean };
      if (parsed.events.length === 0) {
        expect(parsed.has_more).toBe(true);
      }
    });

    it("status: a moderate --budget bounds text output, and --json --budget stays valid at 0/1/tiny", async () => {
      const { root } = await makeBudgetFixture("e1-budget-status");
      const full = runSlop(["status"], root).stdout;
      const budget = Math.max(1, Math.floor(full.length / 2));
      const bounded = runSlop(["status", "--budget", String(budget)], root);
      expect(bounded.status, bounded.stderr).toBe(0);
      expect(bounded.stdout.length).toBeLessThanOrEqual(budget);

      assertJsonBudgetNeverCorrupts(["status"], root);
    });

    it("context: a moderate --budget bounds text output (characters), and --json --budget stays valid at 0/1/tiny", async () => {
      const { root, ticket } = await makeBudgetFixture("e1-budget-context");
      const full = runSlop(["context", ticket.slug], root).stdout;
      expect(full.length).toBeGreaterThan(500);
      const budget = Math.floor(full.length / 2);
      const bounded = runSlop(["context", ticket.slug, "--budget", String(budget)], root);
      expect(bounded.status, bounded.stderr).toBe(0);
      expect(bounded.stdout.length).toBeLessThanOrEqual(budget + 1);

      assertJsonBudgetNeverCorrupts(["context", ticket.slug], root);
    });

    it("show --context: a moderate --budget bounds text output (now reconciled to characters, same unit as `context`), and --json --budget stays valid at 0/1/tiny", async () => {
      const { root, ticket } = await makeBudgetFixture("e1-budget-show");
      const full = runSlop(["show", ticket.slug, "--context"], root).stdout;
      expect(full.length).toBeGreaterThan(500);
      const budget = Math.floor(full.length / 2);
      const bounded = runSlop(["show", ticket.slug, "--context", "--budget", String(budget)], root);
      expect(bounded.status, bounded.stderr).toBe(0);
      expect(bounded.stdout.length).toBeLessThanOrEqual(budget + 1);

      assertJsonBudgetNeverCorrupts(["show", ticket.slug, "--context"], root);

      // Documented floor behavior: a bare `show --json` (no --context) is
      // ONE ticket's data, not a list — --budget has no effect on it, and
      // that's fine (this command's own --help documents the floor). Still
      // must exit 0 and stay valid JSON, never corrupt.
      const floor = runSlop(["show", ticket.slug, "--json", "--budget", "1"], root);
      expect(floor.status, floor.stderr).toBe(0);
      expectValidJson(floor.stdout);
    });
  });
});
