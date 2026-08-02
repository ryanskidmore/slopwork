import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// G5: simplification sweep (t-5vj9o, t-ukxun, t-uy8vo, t-drz1d, t-z4ci3) —
// acceptance-level coverage against the REAL compiled binary (same
// spawn-a-subprocess convention as G3.test.ts/G4.test.ts), since this
// group's changes are all about observable CLI behavior: one shared
// --budget strategy, one shared fake-clock env var, adhoc folded into
// provenance (with legacy tolerance), exit code 3 gone, and the argv shim
// covering --blocks/--relates-to.

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

function runSlop(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(binaryPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

async function makeScratchRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  const init = runSlop(["init", "--yes", "--project", "g5-fixture", "--user", "g5-tester"], dir);
  if (init.status !== 0) throw new Error(`slop init failed in fixture setup: ${init.stderr}`);
  return dir;
}

interface NewTicketJson {
  id: string;
  slug: string;
  handle: string;
}

function newTicket(dir: string, name: string, ...extraArgs: string[]): NewTicketJson {
  const result = runSlop(["new", name, "--json", ...extraArgs], dir);
  if (result.status !== 0) throw new Error(`slop new "${name}" failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as NewTicketJson;
}

describe("G5: simplification sweep", () => {
  // -------------------------------------------------------------------------
  // t-5vj9o: one shared cap-and-report --budget strategy
  // -------------------------------------------------------------------------

  describe("Budget: one shared cap-and-report strategy", () => {
    // A rich enough fixture that EVERY budget-taking command below has
    // real, elidable content: some plain-open tickets (ready/list/search),
    // some started in_progress (status), and some open questions
    // (questions/status's awaiting_input) — without every ticket having a
    // question (which would make `ready`'s default awaiting_input
    // exclusion, G4, leave it with nothing at all).
    async function seedRichFixture(dir: string, count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        const t = newTicket(
          dir,
          `Budget fixture ticket number ${i} with a reasonably long name`,
          "--summary",
          `Summary prose for ticket ${i}, long enough that eliding several of these ` +
            "rows actually shrinks the rendered --json output by a meaningful amount.",
          "--label",
          "area:bench",
        );
        if (i % 4 === 0) {
          expect(runSlop(["start", t.slug], dir).status).toBe(0);
        } else if (i % 4 === 1) {
          expect(
            runSlop(["ask", t.slug, `Open question about fixture ticket ${i}?`], dir).status,
          ).toBe(0);
        }
      }
    }

    it.each([
      ["ready", ["ready", "--json", "--budget"]],
      ["list", ["list", "--json", "--budget"]],
      ["search", ["search", "fixture", "--json", "--budget"]],
      ["status", ["status", "--json", "--budget"]],
      ["questions", ["questions", "--json", "--budget"]],
      ["events", ["events", "--json", "--budget"]],
    ] as const)(
      "%s --json --budget <tiny>: still valid, parseable JSON, with an explicit elision indicator",
      async (_name, argsPrefix) => {
        const dir = await makeScratchRepo("slop-g5-budget-");
        await seedRichFixture(dir, 8);

        const full = runSlop(argsPrefix.slice(0, -1), dir); // no --budget: full render
        expect(full.status, full.stderr).toBe(0);

        const budgeted = runSlop([...argsPrefix, "40"], dir);
        expect(budgeted.status, budgeted.stderr).toBe(0);
        expect(() => JSON.parse(budgeted.stdout)).not.toThrow();
        const body = JSON.parse(budgeted.stdout) as Record<string, unknown>;
        // Every budget-taking command's `--json` carries an `elided` array
        // (core/budget.ts's one shared strategy) — non-empty whenever the
        // budget forced real elision, which a 40-character cap against a
        // multi-ticket/multi-event fixture always does.
        expect(Array.isArray(body.elided)).toBe(true);
        expect((body.elided as unknown[]).length).toBeGreaterThan(0);
        // Genuinely smaller than the unbudgeted render — elision actually
        // happened, not just an unused flag.
        expect(budgeted.stdout.length).toBeLessThan(full.stdout.length);
      },
    );

    it("status --json --budget: counts/derived/problems are never elided, even at a tiny budget", async () => {
      const dir = await makeScratchRepo("slop-g5-budget-status-fields-");
      await seedRichFixture(dir, 6);

      const result = runSlop(["status", "--json", "--budget", "10"], dir);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        counts: { total: number };
        derived: unknown;
        problems: unknown[];
      };
      expect(body.counts.total).toBe(6);
      expect(body.derived).toBeDefined();
      expect(Array.isArray(body.problems)).toBe(true);
    });

    it("context --json --budget and show --context --json --budget: valid JSON, elided marker, even at a pathologically tiny budget", async () => {
      const dir = await makeScratchRepo("slop-g5-budget-context-");
      const t = newTicket(
        dir,
        "Context budget fixture",
        "--details",
        "# Long details\n\n" + "Lorem ipsum dolor sit amet. ".repeat(80),
      );
      // Two sessions worth of history to elide from.
      expect(runSlop(["start", t.slug], dir).status).toBe(0);
      expect(runSlop(["stop", t.slug, "--note", "handoff 1"], dir).status).toBe(0);
      expect(runSlop(["start", t.slug, "--takeover"], dir).status).toBe(0);
      expect(runSlop(["stop", t.slug, "--note", "handoff 2"], dir).status).toBe(0);

      const context = runSlop(["context", t.slug, "--json", "--budget", "5"], dir);
      expect(context.status, context.stderr).toBe(0);
      expect(() => JSON.parse(context.stdout)).not.toThrow();
      const contextBody = JSON.parse(context.stdout) as { elided: string[] };
      expect(contextBody.elided.length).toBeGreaterThan(0);

      const show = runSlop(["show", t.slug, "--context", "--json", "--budget", "5"], dir);
      expect(show.status, show.stderr).toBe(0);
      expect(() => JSON.parse(show.stdout)).not.toThrow();
      const showBody = JSON.parse(show.stdout) as { context: { elided: string[] } };
      expect(showBody.context.elided.length).toBeGreaterThan(0);
    });

    it("events --budget: next_cursor/has_more still let a caller resume without losing events, however much a tiny budget elided from any one page", async () => {
      const dir = await makeScratchRepo("slop-g5-budget-events-cursor-");
      const t = newTicket(dir, "Events cursor fixture");
      for (let i = 0; i < 12; i++) {
        expect(runSlop(["update", t.slug, "--progress", `progress note ${i}`], dir).status).toBe(0);
      }

      const fullResult = runSlop(["events", "--json"], dir);
      expect(fullResult.status, fullResult.stderr).toBe(0);
      const full = JSON.parse(fullResult.stdout) as { events: { id: string }[] };
      const fullIds = full.events.map((e) => e.id);
      expect(fullIds.length).toBeGreaterThanOrEqual(12);

      // A budget just big enough to keep exactly one event per 3-event
      // page (plus headroom for the elision note's own length) — computed
      // from a real single-event page rather than a hardcoded magic
      // number, so this doesn't depend on exact actor-name/id lengths.
      const onePage = runSlop(["events", "--json", "--limit", "1"], dir);
      expect(onePage.status, onePage.stderr).toBe(0);
      const perPageBudget = onePage.stdout.length + 150;

      // Page through with that budget, forcing elision on every page
      // (since a 3-event page never fits), using next_cursor each time,
      // until has_more is false.
      const seen: string[] = [];
      let since: string | undefined;
      let hasMore = true;
      let guard = 0;
      while (hasMore && guard < 100) {
        guard++;
        const args = ["events", "--json", "--limit", "3", "--budget", String(perPageBudget)];
        if (since !== undefined) args.push("--since", since);
        const page = runSlop(args, dir);
        expect(page.status, page.stderr).toBe(0);
        const body = JSON.parse(page.stdout) as {
          events: { id: string }[];
          next_cursor: string | null;
          has_more: boolean;
        };
        expect(body.events.length).toBeGreaterThan(0); // real progress every page
        for (const e of body.events) seen.push(e.id);
        const prevSince = since;
        hasMore = body.has_more;
        if (body.next_cursor !== null) since = body.next_cursor;
        // Never stuck: has_more true always means next_cursor moved past `since`.
        if (hasMore) expect(body.next_cursor).not.toBe(prevSince ?? null);
      }
      expect(guard).toBeLessThan(100);
      // Every event the unbudgeted view saw was eventually seen while
      // paging under a budget tight enough to elide within each page —
      // nothing was permanently lost to elision.
      expect(new Set(seen)).toEqual(new Set(fullIds));
    });
  });

  // -------------------------------------------------------------------------
  // t-uy8vo: SLOP_FAKE_NOW (consolidated from *_FAKE_NOW)
  // -------------------------------------------------------------------------

  describe("SLOP_FAKE_NOW: one shared fake-clock env var", () => {
    it("status honors SLOP_FAKE_NOW: an in_progress ticket reads as stale once the fake clock is past its deadline", async () => {
      const dir = await makeScratchRepo("slop-g5-fakenow-status-");
      writeFileSync(
        join(dir, ".slop", "config.yaml"),
        "project: g5-fixture\nuser: g5-tester\ndefaults:\n  stale_after: 30m\n",
        "utf8",
      );
      const t = newTicket(dir, "Fake-now status fixture");
      expect(runSlop(["start", t.slug], dir).status).toBe(0);

      const fresh = runSlop(["status", "--json"], dir, {
        SLOP_FAKE_NOW: new Date().toISOString(),
      });
      expect(fresh.status, fresh.stderr).toBe(0);
      expect((JSON.parse(fresh.stdout) as { derived: { stale: number } }).derived.stale).toBe(0);

      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h, past the 30m deadline
      const stale = runSlop(["status", "--json"], dir, { SLOP_FAKE_NOW: future });
      expect(stale.status, stale.stderr).toBe(0);
      expect((JSON.parse(stale.stdout) as { derived: { stale: number } }).derived.stale).toBe(1);
    });

    it("ready --resumable honors SLOP_FAKE_NOW: a stale in_progress ticket becomes resumable once the fake clock passes its deadline", async () => {
      const dir = await makeScratchRepo("slop-g5-fakenow-ready-");
      writeFileSync(
        join(dir, ".slop", "config.yaml"),
        "project: g5-fixture\nuser: g5-tester\ndefaults:\n  stale_after: 30m\n",
        "utf8",
      );
      const t = newTicket(dir, "Fake-now ready fixture");
      expect(runSlop(["start", t.slug], dir).status).toBe(0);

      const fresh = runSlop(["ready", "--resumable", "--json"], dir, {
        SLOP_FAKE_NOW: new Date().toISOString(),
      });
      expect(fresh.status, fresh.stderr).toBe(0);
      expect((JSON.parse(fresh.stdout) as { resumable: unknown[] }).resumable).toEqual([]);

      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const stale = runSlop(["ready", "--resumable", "--json"], dir, { SLOP_FAKE_NOW: future });
      expect(stale.status, stale.stderr).toBe(0);
      const resumable = (JSON.parse(stale.stdout) as { resumable: { id: string }[] }).resumable;
      expect(resumable.some((r) => r.id === t.id)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // t-uy8vo: adhoc folded into provenance
  // -------------------------------------------------------------------------

  describe("adhoc folded into provenance.method", () => {
    it('new --adhoc: provenance.method is "adhoc", not a separate stored field', async () => {
      const dir = await makeScratchRepo("slop-g5-adhoc-provenance-");
      const t = newTicket(dir, "Adhoc via provenance", "--adhoc");
      const shown = runSlop(["show", t.slug, "--json"], dir);
      expect(shown.status, shown.stderr).toBe(0);
      const body = JSON.parse(shown.stdout) as {
        ticket: { provenance: { method: string }; adhoc?: unknown };
      };
      expect(body.ticket.provenance.method).toBe("adhoc");
      expect(body.ticket.adhoc).toBeUndefined();
    });

    it("adhoc nag exemption still works via provenance: an adhoc ticket completed directly from in_progress never nags; a non-adhoc one does", async () => {
      const dir = await makeScratchRepo("slop-g5-adhoc-nag-");

      const adhocTicket = newTicket(dir, "Adhoc direct-done", "--adhoc");
      expect(runSlop(["start", adhocTicket.slug], dir).status).toBe(0);
      const adhocDone = runSlop(["done", adhocTicket.slug, "--note", "shipped directly"], dir);
      expect(adhocDone.status, adhocDone.stderr).toBe(0);
      expect(adhocDone.stderr).not.toMatch(/review\/MR/i);

      const planTicket = newTicket(dir, "Non-adhoc direct-done");
      expect(runSlop(["start", planTicket.slug], dir).status).toBe(0);
      const planDone = runSlop(["done", planTicket.slug, "--note", "shipped directly too"], dir);
      expect(planDone.status, planDone.stderr).toBe(0);
      expect(planDone.stderr).toMatch(/review\/MR/i);
    });

    it("tolerates a legacy standalone adhoc: key on a hand-placed ticket file (G1's transcript_ref pattern, reused)", async () => {
      const dir = await makeScratchRepo("slop-g5-adhoc-legacy-");
      const ticketsDir = join(dir, ".slop", "db", "tickets");
      mkdirSync(ticketsDir, { recursive: true });
      const id = `ticket_${"0".repeat(26)}`;
      const now = "2026-07-23T10:00:00.000Z";
      const legacyTicket = {
        id,
        name: "Legacy adhoc-field ticket",
        slug: "legacy-adhoc-field-ticket",
        spec: { summary: "s", details_md: "", acceptance: [], context: [], meta: {}, v: 1 },
        state: "open",
        priority: 2,
        labels: [],
        adhoc: true, // pre-G5 standalone field — must be tolerated, not fatal
        blocks: [],
        relates_to: [],
        discovered_from: [],
        root_id: id,
        path: [],
        active_session: null,
        last_activity_at: now,
        latest_note: null,
        owner: null,
        provenance: { method: "new", created_by: { name: "legacy-writer", kind: "human" } },
        created_at: now,
        updated_at: now,
      };
      writeFileSync(join(ticketsDir, `${id}.jsonc`), `${JSON.stringify(legacyTicket, null, 2)}\n`);

      const shown = runSlop(["show", id, "--json"], dir);
      expect(shown.status, shown.stderr).toBe(0);
      const body = JSON.parse(shown.stdout) as { ticket: { id: string; adhoc?: unknown } };
      expect(body.ticket.id).toBe(id);
      expect(body.ticket.adhoc).toBeUndefined();

      const listed = runSlop(["list", "--json"], dir);
      expect(listed.status, listed.stderr).toBe(0);
      expect((JSON.parse(listed.stdout) as { total: number }).total).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // t-uy8vo: exit code 3 removed
  // -------------------------------------------------------------------------

  describe("exit code 3 (NOT_IMPLEMENTED) removed", () => {
    it("no command's --help mentions NOT_IMPLEMENTED", async () => {
      const dir = await makeScratchRepo("slop-g5-exit3-help-");
      const help = runSlop(["--help"], dir);
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).not.toMatch(/NOT_IMPLEMENTED/);

      const newHelp = runSlop(["new", "--help"], dir);
      expect(newHelp.status, newHelp.stderr).toBe(0);
      expect(newHelp.stdout).not.toMatch(/NOT_IMPLEMENTED/);
    });

    it("README.md and docs/cli-reference.md no longer list exit code 3 as an active row", () => {
      const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
      const cliRef = readFileSync(join(repoRoot, "docs", "cli-reference.md"), "utf8");
      expect(readme).not.toMatch(/\|\s*3\s*\|/);
      expect(cliRef).not.toMatch(/\|\s*3\s*\|/);
    });
  });

  // -------------------------------------------------------------------------
  // t-z4ci3: argv shim extended to --blocks/--relates-to
  // -------------------------------------------------------------------------

  describe("argv shim covers --blocks/--relates-to", () => {
    it("update --blocks -ref parses (a lone dash-prefixed short-ref value, the same hazard --label/--discovered-from already handle)", async () => {
      const dir = await makeScratchRepo("slop-g5-argv-blocks-");
      const blocker = newTicket(dir, "Blocker for argv shim test");
      const target = newTicket(dir, "Target ticket for argv shim test");

      // `-<handle>` is exactly as `-`-shaped as `-<label>`/`-<discovered-from ref>`
      // — Commander cannot parse this as a second value to --blocks without
      // the argv shim rewriting it to --blocks=-<handle> first.
      const result = runSlop(["update", target.slug, "--blocks", `-${blocker.handle}`], dir);
      expect(result.status, result.stderr).toBe(0);

      const shown = runSlop(["show", target.slug, "--json"], dir);
      expect(shown.status, shown.stderr).toBe(0);
      const body = JSON.parse(shown.stdout) as { ticket: { blocks: string[] } };
      expect(body.ticket.blocks).toEqual([]);
    });

    it("update --blocks +ref adds a blocker; update --relates-to +ref adds a relation (both via the argv shim)", async () => {
      const dir = await makeScratchRepo("slop-g5-argv-blocks-add-");
      const blocker = newTicket(dir, "Blocker to add via argv shim");
      const relatesTo = newTicket(dir, "Relates-to target via argv shim");
      const target = newTicket(dir, "Target for add-edges argv shim test");

      const blocksResult = runSlop(["update", target.slug, "--blocks", `+${blocker.handle}`], dir);
      expect(blocksResult.status, blocksResult.stderr).toBe(0);
      const relatesResult = runSlop(
        ["update", target.slug, "--relates-to", `+${relatesTo.handle}`],
        dir,
      );
      expect(relatesResult.status, relatesResult.stderr).toBe(0);

      const shown = runSlop(["show", target.slug, "--json"], dir);
      expect(shown.status, shown.stderr).toBe(0);
      const body = JSON.parse(shown.stdout) as {
        ticket: { blocks: string[]; relates_to: string[] };
      };
      expect(body.ticket.blocks).toEqual([blocker.id]);
      expect(body.ticket.relates_to).toEqual([relatesTo.id]);
    });
  });
});
