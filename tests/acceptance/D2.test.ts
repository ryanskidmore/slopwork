import { type SpawnSyncReturns, execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { newTicketId } from "../../src/core/index.js";
import { repoPaths } from "../../src/repo/index.js";
import { makeTempRepo } from "../support/temp-repo.js";

// D2: search
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "Finds text in `details_md` and progress notes"
//
// This file drives the compiled `dist/slop` binary as a real CLI —
// spawned subprocesses, asserting stdout/stderr/exit codes — same
// convention as tests/acceptance/B1.test.ts. Fixtures are built via `slop
// init --yes` + `slop new` + `slop update --progress` (D1/B1, both landed
// already — unlike B1.test.ts, which predates D1 and had to build `.slop/`
// by hand), NOT the repo layer directly: this exercises the exact
// end-to-end path a real agent driving `slop search` hits, including
// index auto-heal and real `ticket.updated` events for progress-note
// history.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
  // Same "build if missing" convention as A1.test.ts / B1.test.ts.
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
// Fixture + spawn helpers
// ---------------------------------------------------------------------------

/** `spawnSync` against the compiled binary, with `CLAUDECODE`/`OPENCODE`/
 * `CODEX_SANDBOX*` stripped (not just "not set") so actor-kind-dependent
 * behavior is deterministic even when this suite itself runs inside a
 * real agent harness — same reasoning as B1.test.ts's `runSlop`.
 * `input`, when given, is written to the child's stdin (needed for
 * `--spec -`); omitted otherwise. */
function runSlop(args: string[], cwd: string, input?: string): SpawnSyncReturns<string> {
  return spawnSync(binaryPath, args, {
    cwd,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      OPENCODE: undefined,
      CODEX_SANDBOX: undefined,
      CODEX_SANDBOX_NETWORK_DISABLED: undefined,
    },
  });
}

async function makeFixture(): Promise<string> {
  const root = await makeTempRepo("slop-d2-");
  const init = runSlop(["init", "--yes", "--project", "d2-fixture", "--user", "ryan"], root);
  expect(init.status, init.stderr).toBe(0);
  return root;
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

function parseCreatedOutput(stdout: string): { id: string; slug: string } {
  const m = CREATED_LINE.exec(stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(`could not parse "created <id> (slug: <slug>)" out of stdout:\n${stdout}`);
  }
  return { id: m[1], slug: m[2] };
}

function newTicket(
  root: string,
  name: string,
  extraArgs: string[] = [],
): { id: string; slug: string } {
  const result = runSlop(["new", name, ...extraArgs], root);
  expect(result.status, result.stderr).toBe(0);
  return parseCreatedOutput(result.stdout);
}

/** `slop new <name> --spec -`, feeding a JSON spec object over stdin —
 * this is how these fixtures put a distinctive term ONLY inside
 * `details_md` (never in `name`/`summary`), so a match there can only
 * come from actually scanning `details_md`. */
function newTicketWithSpec(
  root: string,
  name: string,
  spec: Record<string, unknown>,
): { id: string; slug: string } {
  const result = runSlop(["new", name, "--spec", "-"], root, JSON.stringify(spec));
  expect(result.status, result.stderr).toBe(0);
  return parseCreatedOutput(result.stdout);
}

function updateProgress(root: string, ref: string, note: string): void {
  const result = runSlop(["update", ref, "--progress", note], root);
  expect(result.status, result.stderr).toBe(0);
}

function search(root: string, text: string, extraArgs: string[] = []): SpawnSyncReturns<string> {
  return runSlop(["search", text, ...extraArgs], root);
}

interface SearchJsonResult {
  id: string;
  slug: string;
  name: string;
  state: string;
  priority: number;
  field: string;
  matched_terms: string[];
  snippet: string;
  last_activity_at: string;
}

interface SearchJsonOutput {
  query: { text: string; terms: string[]; limit: number | null };
  results: SearchJsonResult[];
  count: number;
  problems: { id: string; path: string; message: string }[];
}

function searchJson(root: string, text: string, extraArgs: string[] = []): SearchJsonOutput {
  const result = search(root, text, ["--json", ...extraArgs]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as SearchJsonOutput;
}

// ---------------------------------------------------------------------------

describe("D2: search", () => {
  // -------------------------------------------------------------------------
  // The quoted acceptance criterion itself: details_md AND progress notes,
  // tested separately, plus the "can't pass by matching everything" guard.
  // -------------------------------------------------------------------------

  describe('"Finds text in `details_md` and progress notes"', () => {
    it("finds a term whose only occurrence is deep inside spec.details_md", async () => {
      const root = await makeFixture();
      const term = "gryphon78widget";
      const { id } = newTicketWithSpec(root, "Totally unrelated ticket name", {
        summary: "Also a totally unrelated summary",
        details_md:
          `A long paragraph of unrelated prose that, somewhere deep inside it, ` +
          `happens to mention the ${term} before continuing on with more unrelated words.`,
      });

      const out = searchJson(root, term);
      const hit = out.results.find((r) => r.id === id);
      expect(hit, JSON.stringify(out)).toBeDefined();
      expect(hit?.field).toBe("details_md");
      expect(hit?.snippet).toContain(`**${term}**`);
    });

    it("finds a term whose only occurrence is in a progress note that is NO LONGER the latest one", async () => {
      const root = await makeFixture();
      const term = "kumquatzephyr42";
      const { id } = newTicket(root, "Progress note ticket");

      // The term lands in the FIRST note, then a second, unrelated note
      // supersedes it as `latest_note` — a latest_note-only implementation
      // would silently fail to find `term` after this second call.
      updateProgress(root, id, `investigated and found the ${term} was the root cause`);
      updateProgress(root, id, "unrelated follow-up note that supersedes the previous one");

      // Sanity check: the term really is gone from latest_note now, so
      // this test cannot pass by accidentally still matching the current
      // field.
      const show = runSlop(["show", id], root);
      expect(show.status, show.stderr).toBe(0);
      expect(show.stdout).not.toContain(term);

      const out = searchJson(root, term);
      const hit = out.results.find((r) => r.id === id);
      expect(hit, JSON.stringify(out)).toBeDefined();
      expect(hit?.field).toBe("note");
      expect(hit?.snippet).toContain(`**${term}**`);
    });

    it("a term present in neither returns no matches (guards against matching everything)", async () => {
      const root = await makeFixture();
      newTicket(root, "Some ticket");
      const out = searchJson(root, "zzzznonexistentterm999");
      expect(out.results).toEqual([]);
      expect(out.count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Matching behaviour
  // -------------------------------------------------------------------------

  describe("matching", () => {
    it("is case-insensitive", async () => {
      const root = await makeFixture();
      const { id } = newTicket(root, "Ticket about ZEPHYRUS99 casing");
      const out = searchJson(root, "zephyrus99");
      expect(out.results.map((r) => r.id)).toContain(id);
    });

    it("multi-word query: all terms must appear somewhere, not as one exact phrase", async () => {
      const root = await makeFixture();
      const { id } = newTicketWithSpec(root, "alpha7492 marker ticket", {
        summary: "summary text",
        details_md: "unrelated prose containing beta8143 marker deep inside it",
      });

      const both = searchJson(root, "alpha7492 beta8143");
      expect(both.results.map((r) => r.id)).toContain(id);

      // Dropping in a term present nowhere at all fails the whole ticket —
      // AND semantics across terms, not OR.
      const missingOne = searchJson(root, "alpha7492 nonexistentzzz999");
      expect(missingOne.results.map((r) => r.id)).not.toContain(id);
    });
  });

  // -------------------------------------------------------------------------
  // Ranking: "field weight (name/summary above details_md above notes),
  // number of matching terms, then recency" — an explainable rule, not a
  // scoring engine.
  // -------------------------------------------------------------------------

  describe("ranking", () => {
    it("a name match sorts above a details_md-only match", async () => {
      const root = await makeFixture();
      const term = "flamingopeach19";
      const detailsOnly = newTicketWithSpec(root, "Details only ticket", {
        summary: "summary text",
        details_md: `buried deep in the prose: ${term} appears only here`,
      });
      const nameMatch = newTicket(root, `Ticket titled ${term} directly`);

      const out = searchJson(root, term);
      const ids = out.results.map((r) => r.id);
      expect(ids.indexOf(nameMatch.id)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(detailsOnly.id)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(nameMatch.id)).toBeLessThan(ids.indexOf(detailsOnly.id));
    });
  });

  // -------------------------------------------------------------------------
  // Snippets — the difference between a useful search and a list of ids.
  // -------------------------------------------------------------------------

  describe("snippets", () => {
    it("marks the matched term and bounds the surrounding context", async () => {
      const root = await makeFixture();
      const term = "sequoiaglacier84";
      const filler = "lorem ipsum dolor sit amet ".repeat(20).trim();
      const { id } = newTicketWithSpec(root, "Long details ticket", {
        summary: "summary text",
        details_md: `${filler} ${term} ${filler}`,
      });

      const out = searchJson(root, term);
      const hit = out.results.find((r) => r.id === id);
      expect(hit).toBeDefined();
      expect(hit?.snippet).toContain(`**${term}**`);
      // Bounded, not the whole (hundreds-of-chars) details_md field.
      expect(hit?.snippet.length ?? 0).toBeLessThan(150);
      expect(hit?.snippet.startsWith("…")).toBe(true);
      expect(hit?.snippet.endsWith("…")).toBe(true);
    });

    it("a short field's snippet has no ellipsis (nothing was truncated)", async () => {
      const root = await makeFixture();
      const term = "briefnoteterm7";
      const { id } = newTicket(root, "Some ticket");
      updateProgress(root, id, term);

      const out = searchJson(root, term);
      const hit = out.results.find((r) => r.id === id);
      expect(hit?.snippet).toBe(`**${term}**`);
    });
  });

  // -------------------------------------------------------------------------
  // Human output shape: one line per hit.
  // -------------------------------------------------------------------------

  describe("human output", () => {
    it("one line per hit: id, slug, state, priority, name, and a marked snippet", async () => {
      const root = await makeFixture();
      const term = "octopusmarine77";
      const { id, slug } = newTicket(root, `Ticket about ${term} things`);

      const result = search(root, term);
      expect(result.status, result.stderr).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      const line = lines[0] ?? "";
      expect(line).toContain(id);
      expect(line).toContain(slug);
      expect(line).toContain("open"); // default state
      expect(line).toContain("p2"); // default priority
      expect(line).toContain(`**${term}**`);
    });

    it('no matches: exits 0 with a clear "no matches" line, not an error', async () => {
      const root = await makeFixture();
      newTicket(root, "Some ticket");
      const result = search(root, "zzzabsentterm123");
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain('no matches for "zzzabsentterm123"');
    });
  });

  // -------------------------------------------------------------------------
  // --json
  // -------------------------------------------------------------------------

  describe("--json", () => {
    it("shape: query/results/count/problems, one full result object", async () => {
      const root = await makeFixture();
      const term = "walrustundra31";
      const { id, slug } = newTicket(root, `Ticket about ${term}`);

      const out = searchJson(root, term);
      expect(out.query).toEqual({ text: term, terms: [term], limit: null });
      expect(out.count).toBe(out.results.length);
      expect(out.problems).toEqual([]);

      const hit = out.results.find((r) => r.id === id);
      expect(hit).toMatchObject({ id, slug, state: "open", priority: 2, field: "name" });
      expect(Array.isArray(hit?.matched_terms)).toBe(true);
      expect(hit?.matched_terms).toContain(term);
      expect(typeof hit?.snippet).toBe("string");
      expect(typeof hit?.last_activity_at).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // --limit
  // -------------------------------------------------------------------------

  describe("--limit", () => {
    it("caps the number of results returned", async () => {
      const root = await makeFixture();
      const term = "trumpethallway55";
      newTicket(root, `One ${term} ticket`);
      newTicket(root, `Two ${term} ticket`);
      newTicket(root, `Three ${term} ticket`);

      const unlimited = searchJson(root, term);
      expect(unlimited.count).toBe(3);

      const limited = searchJson(root, term, ["--limit", "2"]);
      expect(limited.results).toHaveLength(2);
      expect(limited.query.limit).toBe(2);
    });

    it("--limit 0 (and other non-positive values) is a usage error", async () => {
      const root = await makeFixture();
      const result = search(root, "anything", ["--limit", "0"]);
      expect(result.status).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Usage errors
  // -------------------------------------------------------------------------

  describe("usage", () => {
    it("blank/whitespace-only search text is a usage error (exit 2)", async () => {
      const root = await makeFixture();
      const result = search(root, "   ");
      expect(result.status).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Corrupt ticket file must not take search down (consistent with
  // `slop reindex`'s fault tolerance, db-index.ts's "Fault tolerance").
  // -------------------------------------------------------------------------

  describe("corrupt ticket file", () => {
    it("is skipped with a stderr warning; every readable ticket still searches normally, exit 0", async () => {
      const root = await makeFixture();
      const term = "penguinlagoon62";
      const { id: goodId } = newTicket(root, `Good ticket about ${term}`);

      const paths = repoPaths(root);
      const badPath = join(paths.ticketsDir, `${newTicketId()}.jsonc`);
      await writeFile(badPath, "{ not even valid jsonc {{{");

      const result = search(root, term);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(goodId);
      expect(result.stderr).toContain("warning:");
      expect(result.stderr).toContain(badPath);

      // --json surfaces the same problem machine-readably, not just on stderr.
      const out = searchJson(root, term);
      expect(out.problems.some((p) => p.path === badPath)).toBe(true);
      expect(out.results.map((r) => r.id)).toContain(goodId);
    });
  });
});
