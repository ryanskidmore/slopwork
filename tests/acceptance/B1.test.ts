import { type SpawnSyncReturns, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Ticket, isTicketId, parseJsonc, ticketSchema } from "../../src/core/index.js";
import { ensureDbDirs, listEventIds } from "../../src/repo/index.js";
import type { RepoPaths } from "../../src/repo/index.js";

// B1: `new` / `show` / `edit` / `update`
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "All §4.2 creation flags work; slug + prefix resolution; `jira:`
//   parent renders in `show`"
//
// This file drives the compiled `dist/slop` binary as a real CLI —
// spawned subprocesses, asserting stdout/stderr/exit codes and the actual
// ticket files landed on disk — not the internal `src/tickets/*`
// functions directly (those get their own thorough co-located unit
// tests). Per the B1 brief: `slop init` (D1) is landing concurrently and
// is NOT depended on here — every fixture builds `.slop/` directly via
// the repo layer's `ensureDbDirs` plus a hand-written `config.yaml`. A
// later item can switch these fixtures to `slop init` once it lands.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
  // Same "build if missing" convention as A1.test.ts / D1.test.ts.
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

const scratchDirs: string[] = [];

interface Fixture {
  root: string;
  paths: RepoPaths;
}

interface FixtureOptions {
  jira?: string;
}

/**
 * Build a `.slop/` db directly (B1's brief: do not depend on `slop init`,
 * landing concurrently as D1) — `ensureDbDirs` for the bare directory
 * skeleton, plus a hand-written `config.yaml` matching config.ts's schema.
 */
async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "slop-b1-"));
  scratchDirs.push(root);
  const paths = await ensureDbDirs(root);

  const lines = ["project: b1-fixture", "user: ryan", "remotes:"];
  if (options.jira !== undefined) {
    lines.push(`  jira: ${options.jira}`);
  }
  lines.push("defaults:", "  stale_after: 60m", "  review_stale_after: 24h");
  await writeFile(join(paths.slopDir, "config.yaml"), `${lines.join("\n")}\n`, "utf8");

  return { root, paths };
}

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Run the compiled binary with a controlled environment. `CLAUDECODE`/
 * `OPENCODE`/`CODEX_SANDBOX*` are deliberately stripped (not just "not
 * set") so actor-kind assertions are sound even when this whole suite
 * happens to run inside a real agent harness — the same reasoning
 * tests/acceptance/D1.test.ts's `runSlop` documents.
 */
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

/** `spawnSync` with explicit stdin `input` — needed for `--spec -`;
 * `runSlop` alone would inherit this test process's own (open, non-EOF)
 * stdin and hang waiting for input that never comes. */
function runSlopWithStdin(args: string[], cwd: string, input: string): SpawnSyncReturns<string> {
  return spawnSync(binaryPath, args, {
    cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, CLAUDECODE: undefined, OPENCODE: undefined },
  });
}

async function readTicketFile(paths: RepoPaths, id: string): Promise<Ticket> {
  const raw = await readFile(join(paths.ticketsDir, `${id}.jsonc`), "utf8");
  const { value, errors } = parseJsonc<unknown>(raw);
  expect(errors, `ticket file ${id} should be valid JSONC`).toEqual([]);
  return ticketSchema.parse(value);
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

function parseCreatedOutput(stdout: string): { id: string; slug: string } {
  const m = CREATED_LINE.exec(stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(`could not parse "created <id> (slug: <slug>)" out of stdout:\n${stdout}`);
  }
  return { id: m[1], slug: m[2] };
}

async function createTicketViaCli(
  fixture: Fixture,
  name: string,
  extraArgs: string[] = [],
): Promise<{ id: string; slug: string; result: SpawnSyncReturns<string> }> {
  const result = runSlop(["new", name, ...extraArgs], fixture.root);
  expect(result.status, result.stderr).toBe(0);
  return { ...parseCreatedOutput(result.stdout), result };
}

// ---------------------------------------------------------------------------
// Clause 1: "All §4.2 creation flags work"
//
// One `it` per flag from design.md §4.2's `new` signature, individually,
// each asserting the resulting ticket file on disk directly (not just
// stdout) — so a flag silently not wired up is caught by the assertion on
// the persisted entity, not just a plausible-looking success message.
// This checklist should track §4.2's bracketed flag list 1:1:
//   [--spec -] [--parent <ref>|jira:PROJ-123] [--blocks X] [--discovered-from Y]
//   [--label a:b] [--draft] [--adhoc] [--owner ryan] [--priority 1]
// ---------------------------------------------------------------------------

describe("B1: new / show / edit / update", () => {
  describe('"All §4.2 creation flags work"', () => {
    it("bare `new <name>` with no flags: sensible defaults for everything", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Add auth provider");
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.name).toBe("Add auth provider");
      expect(ticket.slug).toBe("add-auth-provider");
      expect(ticket.spec.summary).toBe("Add auth provider");
      expect(ticket.state).toBe("open");
      expect(ticket.priority).toBe(2);
      expect(ticket.provenance.method).toBe("new");
      expect(ticket.parent).toBeUndefined();
      expect(ticket.root_id).toBe(ticket.id);
      expect(ticket.path).toEqual([]);
      expect(ticket.owner).toBeNull();
    });

    it("--spec - (stdin, JSON object): used structurally", async () => {
      const fixture = await makeFixture();
      const spawned = runSlopWithStdin(
        ["new", "JSON spec ticket", "--spec", "-"],
        fixture.root,
        JSON.stringify({ summary: "Structured summary", acceptance: ["accept 1"] }),
      );
      expect(spawned.status, spawned.stderr).toBe(0);
      const { id } = parseCreatedOutput(spawned.stdout);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.spec.summary).toBe("Structured summary");
      expect(ticket.spec.acceptance).toEqual(["accept 1"]);
    });

    it('--spec - (stdin, bare markdown): D10 "bare markdown -> details_md"', async () => {
      const fixture = await makeFixture();
      const spawned = runSlopWithStdin(
        ["new", "Markdown spec ticket", "--spec", "-"],
        fixture.root,
        "# Heading\n\nSome *markdown* prose.",
      );
      expect(spawned.status, spawned.stderr).toBe(0);
      const { id } = parseCreatedOutput(spawned.stdout);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.spec.details_md).toBe("# Heading\n\nSome *markdown* prose.");
    });

    it("--spec (literal text, not stdin) also works, JSON and markdown alike", async () => {
      const fixture = await makeFixture();
      const jsonResult = runSlop(
        ["new", "Inline JSON spec", "--spec", JSON.stringify({ summary: "Inline summary" })],
        fixture.root,
      );
      expect(jsonResult.status, jsonResult.stderr).toBe(0);
      const { id: jsonId } = parseCreatedOutput(jsonResult.stdout);
      const jsonTicket = await readTicketFile(fixture.paths, jsonId);
      expect(jsonTicket.spec.summary).toBe("Inline summary");

      const mdResult = runSlop(
        ["new", "Inline markdown spec", "--spec", "just prose"],
        fixture.root,
      );
      expect(mdResult.status, mdResult.stderr).toBe(0);
      const { id: mdId } = parseCreatedOutput(mdResult.stdout);
      const mdTicket = await readTicketFile(fixture.paths, mdId);
      expect(mdTicket.spec.details_md).toBe("just prose");
    });

    it("--spec JSON with an unknown top-level key errors USAGE_ERROR(2) naming the key, instead of silently becoming details_md prose", async () => {
      const fixture = await makeFixture();
      const raw = JSON.stringify({ acceptence: "typo'd key" });
      const result = runSlop(["new", "Typo key spec", "--spec", raw], fixture.root);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("acceptence");
      const listing = await readdir(fixture.paths.ticketsDir);
      expect(listing).toEqual([]); // nothing was persisted
    });

    it("--spec JSON with only known keys but a schema violation errors USAGE_ERROR(2) naming the field", async () => {
      const fixture = await makeFixture();
      const raw = JSON.stringify({ acceptance: "not an array" });
      const result = runSlop(["new", "Bad shape spec", "--spec", raw], fixture.root);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("acceptance");
    });

    it("--spec truncated/malformed JSON (not valid JSON at all) still falls through to details_md, unchanged", async () => {
      const fixture = await makeFixture();
      const raw = '{"summary": "oops, truncated';
      const { id } = await createTicketViaCli(fixture, "Truncated JSON spec", ["--spec", raw]);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.spec.details_md).toBe(raw);
    });

    it("--summary/--details/--acceptance/--context: structured spec flags, no --spec JSON needed", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Structured spec ticket", [
        "--summary",
        "Structured summary",
        "--details",
        "Structured prose",
        "--acceptance",
        "criterion 1",
        "--acceptance",
        "criterion 2",
        "--context",
        "src/foo.ts:12",
      ]);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.spec.summary).toBe("Structured summary");
      expect(ticket.spec.details_md).toBe("Structured prose");
      expect(ticket.spec.acceptance).toEqual(["criterion 1", "criterion 2"]);
      expect(ticket.spec.context).toEqual(["src/foo.ts:12"]);
    });

    it("--details - reads the details prose from stdin, same as --spec -", async () => {
      const fixture = await makeFixture();
      const spawned = runSlopWithStdin(
        ["new", "Stdin details ticket", "--details", "-"],
        fixture.root,
        "# Heading\n\nSome *markdown* prose.",
      );
      expect(spawned.status, spawned.stderr).toBe(0);
      const { id } = parseCreatedOutput(spawned.stdout);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.spec.details_md).toBe("# Heading\n\nSome *markdown* prose.");
    });

    it("combining --spec with a structured field flag (e.g. --summary) is a USAGE_ERROR(2), nothing persisted", async () => {
      const fixture = await makeFixture();
      const result = runSlop(
        [
          "new",
          "Conflicting spec flags",
          "--spec",
          JSON.stringify({ summary: "from json" }),
          "--summary",
          "from flag",
        ],
        fixture.root,
      );
      expect(result.status).toBe(2);
      const listing = await readdir(fixture.paths.ticketsDir);
      expect(listing).toEqual([]);
    });

    it("--parent <local ref> (slug/prefix/full id all work — see also the dedicated slug+prefix describe below)", async () => {
      const fixture = await makeFixture();
      const { id: parentId, slug: parentSlug } = await createTicketViaCli(fixture, "Parent ticket");
      const { id: childId } = await createTicketViaCli(fixture, "Child ticket", [
        "--parent",
        parentSlug,
      ]);
      const child = await readTicketFile(fixture.paths, childId);
      expect(child.parent).toBe(parentId);
      expect(child.root_id).toBe(parentId);
      expect(child.path).toEqual([parentId]);
    });

    it("--parent jira:PROJ-123 (external): local root, empty path — see the dedicated jira: describe below for `show` rendering", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Externally parented", [
        "--parent",
        "jira:PROJ-1",
      ]);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.parent).toBe("jira:PROJ-1");
      expect(ticket.root_id).toBe(ticket.id);
      expect(ticket.path).toEqual([]);
    });

    it("--blocks X (repeatable)", async () => {
      const fixture = await makeFixture();
      const { id: b1 } = await createTicketViaCli(fixture, "Blocker one");
      const { id: b2 } = await createTicketViaCli(fixture, "Blocker two");
      const { id } = await createTicketViaCli(fixture, "Blocked ticket", [
        "--blocks",
        b1,
        "--blocks",
        b2,
      ]);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.blocks.sort()).toEqual([b1, b2].sort());
    });

    it("--discovered-from Y", async () => {
      const fixture = await makeFixture();
      const { id: origin } = await createTicketViaCli(fixture, "Origin ticket");
      const { id } = await createTicketViaCli(fixture, "Discovered ticket", [
        "--discovered-from",
        origin,
      ]);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.discovered_from).toEqual([origin]);
    });

    it("--label a:b (repeatable)", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Labeled ticket", [
        "--label",
        "type:feature",
        "--label",
        "team:core",
      ]);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.labels).toEqual(["type:feature", "team:core"]);
    });

    it("a --label starting with +/- on `new` is a USAGE_ERROR(2), not silently stored (label grammar consistency fix)", async () => {
      const fixture = await makeFixture();
      // Regression: `new` has no +/- add/remove semantics of its own (that's
      // `update --label <±label>`'s job — `new` only ever adds) — a `+`/`-`
      // -prefixed value used to be accepted verbatim as a literal label
      // (`"-weird"`, exit 0, no warning), a grammar mismatch that made the
      // label unreachable by a later `update --label -weird` (which parses
      // as "remove label weird", never "remove label -weird"). argv.ts's
      // rewrite pass still runs (so Commander doesn't choke on the `-`
      // -prefixed token first) — the label content itself is what's now
      // rejected, with a clean usage error rather than a raw Commander
      // "unknown option" error.
      const dash = runSlop(["new", "Dash label ticket", "--label", "-weird"], fixture.root);
      expect(dash.status).toBe(2);
      expect(dash.stderr).toContain("-weird");

      const plus = runSlop(["new", "Plus label ticket", "--label", "+weird"], fixture.root);
      expect(plus.status).toBe(2);
      expect(plus.stderr).toContain("+weird");

      // Nothing was persisted for either rejected attempt.
      const listing = await readdir(fixture.paths.ticketsDir);
      expect(listing).toEqual([]);
    });

    it("--draft (D13: drafts start in draft state)", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Draft ticket", ["--draft"]);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.state).toBe("draft");
    });

    it("--adhoc (G5, t-uy8vo: folded into provenance.method)", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Adhoc ticket", ["--adhoc"]);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.provenance.method).toBe("adhoc");
    });

    it("--owner ryan", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Owned ticket", ["--owner", "ryan"]);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.owner).toEqual({ name: "ryan", kind: "human" });
    });

    it("--priority 1 (0..3, default 2)", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Priority ticket", ["--priority", "1"]);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.priority).toBe(1);

      const bad = runSlop(["new", "Bad priority", "--priority", "9"], fixture.root);
      expect(bad.status).toBe(2); // USAGE_ERROR
    });

    it("an empty or whitespace-only name is a clean USAGE_ERROR(2), never a raw ZodError JSON dump (regression: raw-zoderrors-escape-as-exit)", async () => {
      const fixture = await makeFixture();

      const empty = runSlop(["new", ""], fixture.root);
      expect(empty.status).toBe(2);
      expect(empty.stderr).not.toContain("ZodError");
      expect(empty.stderr).not.toMatch(/^\s*error:\s*\[/); // not a raw JSON issues array
      expect(empty.stderr.toLowerCase()).toContain("name");

      const whitespace = runSlop(["new", "   "], fixture.root);
      expect(whitespace.status).toBe(2);
      expect(whitespace.stderr).not.toContain("ZodError");

      const listing = await readdir(fixture.paths.ticketsDir);
      expect(listing).toEqual([]); // nothing persisted for either rejected call
    });

    it("every flag combined in a single `new` call", async () => {
      const fixture = await makeFixture();
      const { id: parentId, slug: parentSlug } = await createTicketViaCli(fixture, "Combo parent");
      const { id: blockerId, slug: blockerSlug } = await createTicketViaCli(
        fixture,
        "Combo blocker",
      );
      const { id: originId, slug: originSlug } = await createTicketViaCli(fixture, "Combo origin");

      const result = runSlop(
        [
          "new",
          "Combo ticket",
          "--spec",
          JSON.stringify({ summary: "Combo summary" }),
          "--parent",
          parentSlug,
          "--blocks",
          blockerSlug,
          "--discovered-from",
          originSlug,
          "--label",
          "a:b",
          "--draft",
          "--adhoc",
          "--owner",
          "ryan",
          "--priority",
          "0",
        ],
        fixture.root,
      );
      expect(result.status, result.stderr).toBe(0);
      const { id } = parseCreatedOutput(result.stdout);
      const ticket = await readTicketFile(fixture.paths, id);

      expect(ticket.spec.summary).toBe("Combo summary");
      expect(ticket.parent).toBe(parentId);
      expect(ticket.root_id).toBe(parentId);
      expect(ticket.path).toEqual([parentId]);
      expect(ticket.blocks).toEqual([blockerId]);
      expect(ticket.discovered_from).toEqual([originId]);
      expect(ticket.labels).toEqual(["a:b"]);
      expect(ticket.state).toBe("draft");
      expect(ticket.provenance.method).toBe("adhoc");
      expect(ticket.owner).toEqual({ name: "ryan", kind: "human" });
      expect(ticket.priority).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Clause 2: "slug + prefix resolution"
  // -------------------------------------------------------------------------

  describe('"slug + prefix resolution"', () => {
    it("resolves the same ticket by full id, slug, and a unique short prefix", async () => {
      const fixture = await makeFixture();
      const { id, slug } = await createTicketViaCli(fixture, "Resolvable ticket");

      for (const ref of [id, slug, id.slice(0, id.length - 2)]) {
        const result = runSlop(["show", ref], fixture.root);
        expect(result.status, `ref "${ref}": ${result.stderr}`).toBe(0);
        expect(result.stdout).toContain(id);
      }
    });

    it("collision suffixes produce -2, -3, ... (D12)", async () => {
      const fixture = await makeFixture();
      const first = await createTicketViaCli(fixture, "Duplicate name");
      const second = await createTicketViaCli(fixture, "Duplicate name");
      const third = await createTicketViaCli(fixture, "Duplicate name");
      expect(first.slug).toBe("duplicate-name");
      expect(second.slug).toBe("duplicate-name-2");
      expect(third.slug).toBe("duplicate-name-3");

      // Every slug independently resolves back to its own ticket.
      const showFirst = runSlop(["show", first.slug], fixture.root);
      expect(showFirst.stdout).toContain(first.id);
      const showThird = runSlop(["show", third.slug], fixture.root);
      expect(showThird.stdout).toContain(third.id);
    });

    it("an ambiguous short prefix still errors git-style (exit 5), listing every candidate", async () => {
      const fixture = await makeFixture();
      const a = await createTicketViaCli(fixture, "Alpha");
      const b = await createTicketViaCli(fixture, "Beta");

      // Every ticket id starts with the literal "ticket_" prefix — a
      // guaranteed-ambiguous short ref regardless of the ULIDs' actual
      // random/timestamp bytes, so this assertion is deterministic rather
      // than depending on two ULIDs happening to share enough of their
      // timestamp component (see idMatchesRef, core/ids.ts).
      const result = runSlop(["show", "ticket_"], fixture.root);
      expect(result.status).toBe(5); // AMBIGUOUS_REF
      expect(result.stderr).toMatch(/short ref ".+" is ambiguous/);
      expect(result.stderr).toMatch(/candidates are:/i);
      expect(result.stderr).toContain(a.id);
      expect(result.stderr).toContain(b.id);
    });

    it("a ref that resolves to nothing errors NOT_FOUND (exit 4)", async () => {
      const fixture = await makeFixture();
      const result = runSlop(["show", "no-such-ticket-anywhere"], fixture.root);
      expect(result.status).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // Clause 3: "`jira:` parent renders in `show`"
  // -------------------------------------------------------------------------

  describe('"`jira:` parent renders in `show`"', () => {
    it("renders the ref and the resolved browse URL when remotes.jira is configured", async () => {
      const fixture = await makeFixture({ jira: "https://example.atlassian.net" });
      const { id } = await createTicketViaCli(fixture, "Jira-parented ticket", [
        "--parent",
        "jira:PROJ-123",
      ]);

      const show = runSlop(["show", id], fixture.root);
      expect(show.status, show.stderr).toBe(0);
      expect(show.stdout).toContain("jira:PROJ-123");
      expect(show.stdout).toContain("https://example.atlassian.net/browse/PROJ-123");

      const tree = runSlop(["show", id, "--tree"], fixture.root);
      expect(tree.status, tree.stderr).toBe(0);
      expect(tree.stdout).toContain("jira:PROJ-123");
      expect(tree.stdout).toContain("https://example.atlassian.net/browse/PROJ-123");

      const context = runSlop(["show", id, "--context"], fixture.root);
      expect(context.status, context.stderr).toBe(0);
      expect(context.stdout).toContain("jira:PROJ-123");
      expect(context.stdout).toContain("https://example.atlassian.net/browse/PROJ-123");
    });

    it("renders the bare ref (no URL) when remotes.jira is NOT configured", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Jira-parented, no remote", [
        "--parent",
        "jira:PROJ-9",
      ]);
      const show = runSlop(["show", id], fixture.root);
      expect(show.status, show.stderr).toBe(0);
      expect(show.stdout).toContain("jira:PROJ-9");
      expect(show.stdout).not.toContain("http");
    });

    it("root_id/path treat the jira: parent as terminating the local tree (D1: this ticket is its own local root)", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Jira root", ["--parent", "jira:PROJ-1"]);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.root_id).toBe(ticket.id);
      expect(ticket.path).toEqual([]);
      expect(isTicketId(ticket.parent as string)).toBe(false);
    });

    it("a malformed jira: ref warns (stderr) and still creates the ticket (§8.2 item 5: warn, never block)", async () => {
      const fixture = await makeFixture();
      const result = runSlop(
        ["new", "Malformed jira parent", "--parent", "jira:not-a-key"],
        fixture.root,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toMatch(/warning:.*doesn't look like/i);
      const { id } = parseCreatedOutput(result.stdout);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.parent).toBe("jira:not-a-key");
    });
  });

  // -------------------------------------------------------------------------
  // Supplementary CLI-level coverage for `edit` and `update` (the describe's
  // full name is "new / show / edit / update" — the three clauses above are
  // the quoted acceptance criterion; these round out the other two commands).
  // -------------------------------------------------------------------------

  describe("update", () => {
    // ticket_01KY9RWFM80BKNE2CDX85QMKGS: a pure `--progress` call (no
    // other flag) is lock-free — it appends a `ticket.updated` event and
    // never re-reads/rewrites the ticket file at all, so the file's OWN
    // `latest_note`/`last_activity_at` are untouched; every read path
    // (`show`, here) reports the EFFECTIVE values instead, folding the
    // new event in at read time (db-index.ts's `deriveEffectiveOverlay`).
    it("--progress sets the EFFECTIVE latest_note/last_activity_at (via `show --json`) without writing the ticket file", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Progress ticket");
      const before = await readTicketFile(fixture.paths, id);
      await new Promise((r) => setTimeout(r, 5));

      const result = runSlop(["update", id, "--progress", "made real progress"], fixture.root);
      expect(result.status, result.stderr).toBe(0);

      const after = await readTicketFile(fixture.paths, id);
      expect(after).toEqual(before); // the ticket FILE itself: byte-for-byte untouched

      const show = runSlop(["show", id, "--json"], fixture.root);
      expect(show.status, show.stderr).toBe(0);
      const shown = JSON.parse(show.stdout) as {
        ticket: { latest_note: string | null; last_activity_at: string };
      };
      expect(shown.ticket.latest_note).toBe("made real progress");
      expect(Date.parse(shown.ticket.last_activity_at)).toBeGreaterThan(
        Date.parse(before.last_activity_at),
      );
    });

    it("--state performs a legal transition (D13's draft <-> open); an illegal one rejects with exit 6", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "State ticket");

      const ok = runSlop(["update", id, "--state", "draft"], fixture.root);
      expect(ok.status, ok.stderr).toBe(0);
      expect((await readTicketFile(fixture.paths, id)).state).toBe("draft");

      // `update --state` is restricted to D13's side-effect-free draft <->
      // open edges (see C3's adversarial-review fix, src/tickets/state.ts):
      // `in_progress` creates a session `update` has no way to supply, so
      // it's rejected with exit 6 pointing at the dedicated command.
      const illegal = runSlop(["update", id, "--state", "in_progress"], fixture.root);
      expect(illegal.status).toBe(6); // CONFLICT
      expect(illegal.stderr).toMatch(/slop start/);
    });

    // Coordinator smoke-test bug: `--label +x -y` — the EXACT form
    // design.md §4.2 documents, one `--label` mention followed by two
    // space-separated, sigil-prefixed tokens — errored with "unknown
    // option '-y'" before the argv.ts pre-pass fix. All three invocation
    // shapes an agent (or the D1-generated onboarding docs) might
    // reasonably type must produce the same result.
    describe("--label +x -y (all documented invocation shapes)", () => {
      it("the documented form: one `--label` flag, two space-separated values", async () => {
        const fixture = await makeFixture();
        const { id } = await createTicketViaCli(fixture, "Label ticket doc form", [
          "--label",
          "keep",
        ]);
        const result = runSlop(["update", id, "--label", "+added", "-keep"], fixture.root);
        expect(result.status, result.stderr).toBe(0);
        expect((await readTicketFile(fixture.paths, id)).labels).toEqual(["added"]);
      });

      it("the repeated-flag form: --label +x --label -y", async () => {
        const fixture = await makeFixture();
        const { id } = await createTicketViaCli(fixture, "Label ticket repeated form", [
          "--label",
          "keep",
        ]);
        const result = runSlop(
          ["update", id, "--label", "+added", "--label", "-keep"],
          fixture.root,
        );
        expect(result.status, result.stderr).toBe(0);
        expect((await readTicketFile(fixture.paths, id)).labels).toEqual(["added"]);
      });

      it("the equals form: --label=+x --label=-y", async () => {
        const fixture = await makeFixture();
        const { id } = await createTicketViaCli(fixture, "Label ticket equals form", [
          "--label",
          "keep",
        ]);
        const result = runSlop(["update", id, "--label=+added", "--label=-keep"], fixture.root);
        expect(result.status, result.stderr).toBe(0);
        expect((await readTicketFile(fixture.paths, id)).labels).toEqual(["added"]);
      });

      it("the documented form does not swallow a following real flag (--priority)", async () => {
        const fixture = await makeFixture();
        const { id } = await createTicketViaCli(fixture, "Label ticket swallow guard");
        const result = runSlop(
          ["update", id, "--label", "+a", "-b", "--priority", "1"],
          fixture.root,
        );
        expect(result.status, result.stderr).toBe(0);
        const ticket = await readTicketFile(fixture.paths, id);
        expect(ticket.labels).toEqual(["a"]); // "+a" added, "-b" removed (no-op: never present)
        expect(ticket.priority).toBe(1); // --priority was NOT swallowed as a label value
      });

      it("three consecutive documented-form values in one --label mention", async () => {
        const fixture = await makeFixture();
        const { id } = await createTicketViaCli(fixture, "Label ticket triple");
        const result = runSlop(["update", id, "--label", "+a", "+b", "-c"], fixture.root);
        expect(result.status, result.stderr).toBe(0);
        expect((await readTicketFile(fixture.paths, id)).labels.sort()).toEqual(["a", "b"]);
      });
    });

    // §4.2's other single-value flags already worked with a leading-dash
    // value even before the argv fix (Commander accepts a `-`-prefixed
    // token as an option's one immediately-following value without
    // ambiguity) — asserted here so a future regression is caught, and so
    // it's on record that these were checked, not assumed, per the
    // coordinator's ask.
    it("--progress accepts a value starting with a dash", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Progress dash ticket");
      const result = runSlop(["update", id, "--progress", "-1 regression"], fixture.root);
      expect(result.status, result.stderr).toBe(0);
      // Lock-free pure progress (ticket_01KY9RWFM80BKNE2CDX85QMKGS): read
      // the EFFECTIVE value via `show --json`, not the ticket file — see
      // the test above.
      const show = runSlop(["show", id, "--json"], fixture.root);
      expect(show.status, show.stderr).toBe(0);
      const shown = JSON.parse(show.stdout) as { ticket: { latest_note: string | null } };
      expect(shown.ticket.latest_note).toBe("-1 regression");
    });

    it("--name accepts a value starting with a dash", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Name dash ticket");
      const result = runSlop(["update", id, "--name", "-foo"], fixture.root);
      expect(result.status, result.stderr).toBe(0);
      expect((await readTicketFile(fixture.paths, id)).name).toBe("-foo");
    });

    it("--name renames WITHOUT re-slugging (D12: slugs are stable handles)", async () => {
      const fixture = await makeFixture();
      const { id, slug } = await createTicketViaCli(fixture, "Original name");
      const result = runSlop(["update", id, "--name", "Totally different name"], fixture.root);
      expect(result.status, result.stderr).toBe(0);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.name).toBe("Totally different name");
      expect(ticket.slug).toBe(slug);
      // The old slug still resolves — nothing silently re-slugged it.
      const show = runSlop(["show", slug], fixture.root);
      expect(show.status, show.stderr).toBe(0);
      expect(show.stdout).toContain(id);
    });

    it("--priority", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Priority update", ["--priority", "2"]);
      const result = runSlop(["update", id, "--priority", "0"], fixture.root);
      expect(result.status, result.stderr).toBe(0);
      expect((await readTicketFile(fixture.paths, id)).priority).toBe(0);
    });

    it("--spec - replaces the spec (JSON via stdin)", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Spec update");
      const result = runSlopWithStdin(
        ["update", id, "--spec", "-"],
        fixture.root,
        JSON.stringify({ summary: "Replaced summary" }),
      );
      expect(result.status, result.stderr).toBe(0);
      expect((await readTicketFile(fixture.paths, id)).spec.summary).toBe("Replaced summary");
    });

    it("--spec JSON with an unknown top-level key on update errors USAGE_ERROR(2), leaving the existing spec untouched", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Spec update typo");
      const before = await readTicketFile(fixture.paths, id);
      const result = runSlop(
        ["update", id, "--spec", JSON.stringify({ acceptence: "typo'd key" })],
        fixture.root,
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("acceptence");
      const after = await readTicketFile(fixture.paths, id);
      expect(after.spec).toEqual(before.spec);
    });

    it("--acceptance on update replaces the acceptance[] wholesale, leaving summary/details/context untouched", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Structured field update", [
        "--summary",
        "Original summary",
        "--details",
        "Original prose",
        "--context",
        "original ctx",
      ]);
      const result = runSlop(["update", id, "--acceptance", "new criterion"], fixture.root);
      expect(result.status, result.stderr).toBe(0);
      const ticket = await readTicketFile(fixture.paths, id);
      expect(ticket.spec.acceptance).toEqual(["new criterion"]);
      expect(ticket.spec.summary).toBe("Original summary");
      expect(ticket.spec.details_md).toBe("Original prose");
      expect(ticket.spec.context).toEqual(["original ctx"]);
    });

    it("combining --spec with a structured field flag on update is a USAGE_ERROR(2), leaving the spec untouched", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Conflicting update spec flags");
      const before = await readTicketFile(fixture.paths, id);
      const result = runSlop(
        ["update", id, "--spec", JSON.stringify({ summary: "x" }), "--summary", "y"],
        fixture.root,
      );
      expect(result.status).toBe(2);
      const after = await readTicketFile(fixture.paths, id);
      expect(after.spec).toEqual(before.spec);
    });

    it("no flags at all is a usage error", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "No flags ticket");
      const result = runSlop(["update", id], fixture.root);
      expect(result.status).toBe(2);
    });

    it("emits an event for each mutation (ticket.updated / ticket.state_changed)", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Event ticket");
      // G2 (shard-event-storage): a plain (non-recursive) `readdir` of
      // `paths.eventsDir` no longer sees every event — the ones this CLI
      // run appends land in an `events/YYYY-MM/` shard, not flat — so the
      // total event count now has to go through the shard-aware
      // `listEventIds` (src/repo/events.ts, re-exported from the repo
      // barrel) instead of counting flat directory entries directly.
      const beforeCount = (await listEventIds(fixture.paths)).length;
      const result = runSlop(["update", id, "--priority", "0"], fixture.root);
      expect(result.status, result.stderr).toBe(0);
      const afterCount = (await listEventIds(fixture.paths)).length;
      expect(afterCount).toBe(beforeCount + 1);
    });
  });

  describe("edit", () => {
    /** Writes an executable fake-`$EDITOR` shell script INSIDE the given
     * fixture root (not a loose tmpdir file) so the existing `afterEach`
     * cleanup removes it automatically along with the rest of the
     * fixture — no separate tracking needed. */
    async function writeFakeEditor(
      fixture: Fixture,
      name: string,
      script: string,
    ): Promise<string> {
      const path = join(fixture.root, name);
      await writeFile(path, script, "utf8");
      chmodSync(path, 0o755);
      return path;
    }

    it("a valid hand-edit is saved and re-validated", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Editable ticket");

      const editorPath = await writeFakeEditor(
        fixture,
        "fake-editor-ok.sh",
        '#!/bin/sh\nsed -i \'s/"priority": [0-9]*/"priority": 0/\' "$1"\nexit 0\n',
      );

      const result = runSlop(["edit", id], fixture.root, { EDITOR: editorPath });
      expect(result.status, result.stderr).toBe(0);
      expect((await readTicketFile(fixture.paths, id)).priority).toBe(0);
    });

    it("an invalid hand-edit is rejected, the file is rolled back, and the draft is preserved", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Rejectable ticket");
      const before = await readTicketFile(fixture.paths, id);

      const editorPath = await writeFakeEditor(
        fixture,
        "fake-editor-bad.sh",
        '#!/bin/sh\necho "not even json" > "$1"\nexit 0\n',
      );

      const result = runSlop(["edit", id], fixture.root, { EDITOR: editorPath });
      expect(result.status).toBe(2); // USAGE_ERROR
      expect(result.stderr).toMatch(/failed validation and was NOT saved/);
      expect(result.stderr).toMatch(/your edit is preserved at/);

      // The rescued draft actually exists at the path the error names.
      const rescuePathMatch = /your edit is preserved at (\S+\.jsonc)/.exec(result.stderr);
      expect(rescuePathMatch).not.toBeNull();
      if (rescuePathMatch?.[1]) {
        const rescued = await readFile(rescuePathMatch[1], "utf8");
        expect(rescued).toContain("not even json");
        await rm(rescuePathMatch[1], { force: true });
      }

      // The real file was rolled back — still valid, unchanged.
      const after = await readTicketFile(fixture.paths, id);
      expect(after).toEqual(before);
    });

    it("no changes made is a clean no-op", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Untouched ticket");

      const editorPath = await writeFakeEditor(
        fixture,
        "fake-editor-noop.sh",
        "#!/bin/sh\nexit 0\n",
      );

      const result = runSlop(["edit", id], fixture.root, { EDITOR: editorPath });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/no changes/);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-process index freshness (B1 brief: verify, don't rebuild manually)
  // -------------------------------------------------------------------------

  describe("index freshness across processes", () => {
    it("a ticket created in one process resolves by slug in a separate process, with no manual reindex", async () => {
      const fixture = await makeFixture();
      const { slug, id } = await createTicketViaCli(fixture, "Cross process ticket");

      // A brand-new `slop show` invocation is a brand-new OS process with
      // no in-memory state shared with the `new` call above — this is
      // exactly A3's self-healing index (content fingerprint) at work,
      // not anything B1 has to trigger.
      const result = runSlop(["show", slug], fixture.root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(id);
    });
  });
});
