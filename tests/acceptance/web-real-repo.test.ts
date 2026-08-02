import {
  type ChildProcess,
  execFileSync,
  type SpawnSyncReturns,
  spawn,
  spawnSync,
} from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shortTicketCode } from "../../src/core/index.js";

// web-real-repo: closes the coverage gap ticket_01KY93E35ZXWBQ64QMXSVRTCKB
// flags — "test gap: exercise slop web against a real-CLI-produced repo,
// not just the hand-built fixture".
//
// Every other `slop web` test (tests/acceptance/D5.test.ts) runs against
// tests/fixtures/web-db/.slop/, a fixture HAND-BUILT via
// tests/fixtures/generate-web-db.ts (ticketSchema.parse + writeCanonical
// directly) — never against a `.slop/` directory the real CLI actually
// produced. A write-path/read-path mismatch (a field the write path never
// populates the way the view expects, an edge case only a real multi-step
// lifecycle produces) would pass every schema check in A2.test.ts yet
// still render wrong or 500 in the browser, uncaught by every existing
// `slop web` test.
//
// So this file, unlike D5.test.ts, never hand-builds a `.slop/` directory:
// it drives the compiled `dist/slop` binary through a real
// init -> new -> start -> plan -> plan --check -> update --progress ->
// review --mr -> done lifecycle (same `runSlop`-over-`spawnSync`
// convention as tests/acceptance/D2.test.ts / C4.test.ts), then points a
// second, real `slop web` process at that SAME directory and asserts over
// real HTTP that a handful of key views render the ticket the CLI
// actually produced — same server-spawn/readiness-wait/teardown shape as
// D5.test.ts's compiled-binary block. A deliberate smoke test, not a
// second copy of D5's exhaustive per-view coverage: a few strong,
// real-data assertions per view are enough to catch a write/read drift.
//
// ticket_01KY9S0172V8AYCYV9KWS6RC9P extends this same real-CLI-produced
// repo with: a parent/child pair, a `relates-to` edge (set via a scripted
// `slop edit` — see `editRelatesTo` below; there is no `--relates-to` flag
// on any mutating command today, so this is the one place this file steps
// outside pure CLI-flag-driven mutation, and it still goes through the
// real `slop edit` command + its real schema/edge validation, just with a
// scripted $EDITOR instead of a human one), a `discovered-from` edge, a
// ticket left `in_progress` (never advanced) to exercise the `stale`
// overlay + "Active session" deep link, a ticket left `review` (never
// `done`) to exercise review-staleness, and a `done --outcome` resolution
// containing both a `javascript:` link and raw HTML — the read-side half
// of D5's "no field rendered raw/unescaped" acceptance criterion, now
// proven against real CLI output rather than only a hand-built fixture.
// `SLOP_FAKE_NOW` (src/cli/commands/web.ts's testing-only clock
// override, same convention D5.test.ts uses) pins the server's "now" far
// enough past every ticket's real activity timestamp to make the
// intentionally-stalled tickets read as stale without this file actually
// sleeping for an hour.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
  // Same "build if missing" convention as every other compiled-binary
  // acceptance test (A1.test.ts, B1.test.ts, D2.test.ts, C4.test.ts,
  // D5.test.ts's own compiled-binary block) — never invoked by this file
  // itself in normal CI/gate runs, where the binary is already built.
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
// CLI spawn helpers — D2.test.ts / C4.test.ts's `runSlop` convention: strip
// every harness-identity env var a real agent harness (this one included)
// might set, so `start`'s harness auto-detection and `resolveActor`'s
// SLOP_ACTOR-less name resolution are deterministic regardless of what's
// actually running this suite.
// ---------------------------------------------------------------------------

const STRIPPED_HARNESS_ENV: NodeJS.ProcessEnv = {
  CLAUDECODE: undefined,
  CLAUDE_CODE_CHILD_SESSION: undefined,
  CLAUDE_CODE_SESSION_ID: undefined,
  OPENCODE: undefined,
  OPENCODE_PID: undefined,
  CODEX_SANDBOX: undefined,
  CODEX_SANDBOX_NETWORK_DISABLED: undefined,
  CODEX_HOME: undefined,
};

/** {@link runSlop}'s general form — same harness-env stripping, plus
 * caller-supplied overrides layered on top (e.g. `SLOP_ACTOR` for an
 * actor-identity test, or `EDITOR` to script `slop edit` — see
 * `editRelatesTo` below). `extraEnv`'s keys win over both `process.env`
 * and the stripped harness vars, applied last. */
function runSlopWithEnv(
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv,
  input?: string,
): SpawnSyncReturns<string> {
  return spawnSync(binaryPath, args, {
    cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, ...STRIPPED_HARNESS_ENV, ...extraEnv },
  });
}

function runSlop(args: string[], cwd: string, input?: string): SpawnSyncReturns<string> {
  return runSlopWithEnv(args, cwd, {}, input);
}

interface NewTicketJson {
  id: string;
  slug: string;
  name: string;
  state: string;
  priority: number;
  parent: string | null;
}

/** `slop new <name> --json [...extraArgs]` — `--json` (E1) gives a small,
 * stable {id, slug, name, state, priority, parent} result, which this file
 * parses directly instead of regex-scraping the human-readable "created
 * <id> (slug: <slug>)" line D2.test.ts's fixtures rely on — one less thing
 * that could drift if that line's wording ever changes. */
function newTicket(root: string, name: string, extraArgs: string[] = []): NewTicketJson {
  const result = runSlop(["new", name, "--json", ...extraArgs], root);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as NewTicketJson;
}

/** Same as {@link newTicket}, but with a `--spec -` JSON body fed over
 * stdin (D2.test.ts's `newTicketWithSpec` convention) — this is how the
 * lifecycle ticket below gets a real, distinctive `spec.summary`/
 * `spec.details_md`/`acceptance` that the ticket-detail assertions can
 * check actually round-tripped through disk and back out through
 * FixtureDataSource into HTML, rather than the vacuous `defaultSpec()`
 * every other ticket in this file gets. */
function newTicketWithSpec(
  root: string,
  name: string,
  spec: Record<string, unknown>,
): NewTicketJson {
  const result = runSlop(["new", name, "--spec", "-", "--json"], root, JSON.stringify(spec));
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as NewTicketJson;
}

/** Same as {@link newTicket}, with caller-supplied env overrides — used
 * once, below, to set `SLOP_ACTOR` to an attacker-shaped string so
 * `provenance.created_by.name`'s render-time escaping (ticket-detail.ts's
 * "Provenance" row) is proven against something the real actor-resolution
 * path (D17) actually produced, not just a hand-built `Ticket` object. */
function newTicketWithEnv(
  root: string,
  name: string,
  extraArgs: string[],
  extraEnv: NodeJS.ProcessEnv,
): NewTicketJson {
  const result = runSlopWithEnv(["new", name, "--json", ...extraArgs], root, extraEnv);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as NewTicketJson;
}

/**
 * `relates-to` (ticket_01KY9S0172V8AYCYV9KWS6RC9P) has no `--relates-to`
 * flag on any mutating command (`new`'s `--blocks`/`--discovered-from`
 * cover the other two array edge kinds; `relates-to` was simply never
 * given one) — so the only real-CLI path to setting it is `slop edit`
 * (opens `$VISUAL`/`$EDITOR` on the ticket's raw JSONC file). This scripts
 * that editor with a tiny Bun program instead of a human, writing
 * `relates_to` directly and exiting 0 — `slop edit` still does everything
 * it always does afterward (reparse, re-validate against `ticketSchema`,
 * `validateTicketEdges`, `updateTicket`'s comment-preserving rewrite), so
 * this exercises the real write path, not a hand-poked file the CLI never
 * touched. `VISUAL` is explicitly cleared so a stray interactive-shell
 * `$VISUAL` in the host environment can never win over the scripted
 * `EDITOR` (`pickEditorCommand`'s own precedence, edit.ts).
 */
async function editRelatesTo(root: string, ref: string, targetId: string): Promise<void> {
  const scriptPath = join(root, `edit-relates-to-${ref}.mjs`);
  await writeFile(
    scriptPath,
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      "const path = process.argv[2];",
      'const data = JSON.parse(readFileSync(path, "utf8"));',
      `data.relates_to = ${JSON.stringify([targetId])};`,
      "writeFileSync(path, JSON.stringify(data, null, 2));",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = runSlopWithEnv(["edit", ref], root, {
    VISUAL: undefined,
    EDITOR: `bun ${scriptPath}`,
  });
  expect(result.status, result.stderr).toBe(0);
}

interface StartJson {
  session: {
    id: string;
    actor: string;
    harness: string;
    harness_session_id: string | null;
    started_at: string;
  };
  ticket: { id: string; slug: string; name: string; state: string };
}

function startTicket(root: string, ref: string): StartJson {
  const result = runSlop(["start", ref, "--json"], root);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as StartJson;
}

function plan(root: string, ref: string, steps: string[]): void {
  const result = runSlop(["plan", ref, ...steps], root);
  expect(result.status, result.stderr).toBe(0);
}

function planCheck(root: string, ref: string, step: number): void {
  const result = runSlop(["plan", ref, "--check", String(step)], root);
  expect(result.status, result.stderr).toBe(0);
}

function updateProgress(root: string, ref: string, note: string): void {
  const result = runSlop(["update", ref, "--progress", note], root);
  expect(result.status, result.stderr).toBe(0);
}

function review(root: string, ref: string, mr: string): void {
  const result = runSlop(["review", ref, "--mr", mr], root);
  expect(result.status, result.stderr).toBe(0);
}

function done(root: string, ref: string, note: string, outcome?: string): void {
  const args = ["done", ref, "--note", note];
  if (outcome !== undefined) args.push("--outcome", outcome);
  const result = runSlop(args, root);
  expect(result.status, result.stderr).toBe(0);
}

// ---------------------------------------------------------------------------
// Web-server spawn/teardown — identical shape to D5.test.ts's
// `spawnAndWaitForUrl`/`stopServer` (duplicated rather than imported: these
// are test-file-local helpers in D5.test.ts too, not an exported module).
// ---------------------------------------------------------------------------

interface RunningServer {
  proc: ChildProcess;
  baseUrl: string;
}

function spawnAndWaitForUrl(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 15_000,
): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(
        new Error(
          `timed out waiting for "${cmd} ${args.join(" ")}" to print a listen URL.\nstdout: ${stdout}\nstderr: ${stderr}`,
        ),
      );
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /https?:\/\/127\.0\.0\.1:\d+\//.exec(stdout);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, baseUrl: match[0] });
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(`process exited early (code ${code}) before printing a URL.\nstderr: ${stderr}`),
      );
    });
    proc.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function stopServer(server: RunningServer | undefined): Promise<void> {
  if (!server) return;
  if (server.proc.exitCode !== null || server.proc.signalCode !== null) return;
  server.proc.kill();
  await Promise.race([once(server.proc, "exit"), new Promise((r) => setTimeout(r, 3000))]);
}

// ---------------------------------------------------------------------------
// Fixture lifecycle — built ONCE in beforeAll, entirely through the
// compiled binary, no direct src/repo or src/core writes anywhere in this
// file.
// ---------------------------------------------------------------------------

let root: string;
let server: RunningServer | undefined;

// The three original tickets this lifecycle produces:
let dependentTicket: NewTicketJson; // blocked by blockerTicket the whole time — never started.
let blockerTicket: NewTicketJson; // external jira: parent; blocks dependentTicket; never started.
let mainTicket: NewTicketJson; // driven through the full start/plan/review/done lifecycle.
let mainSessionId: string;

// ticket_01KY9S0172V8AYCYV9KWS6RC9P additions — relationships/overlays the
// original three tickets above don't exercise on their own:
let parentTicket: NewTicketJson; // has one local child.
let childTicket: NewTicketJson; // --parent parentTicket.
let relatesTarget: NewTicketJson; // relates-to mainTicket, set via a scripted `slop edit` (no --relates-to flag exists).
let discoveredTicket: NewTicketJson; // --discovered-from mainTicket; created by an actor name with an XSS payload.
let staleTicket: NewTicketJson; // started, then left in_progress forever — stale under SLOP_FAKE_NOW below.
let staleSessionId: string;
let reviewTicket: NewTicketJson; // started, reviewed, then left in review forever — review-stale under SLOP_FAKE_NOW below.

const JIRA_BASE = "https://real-repo-fixture.atlassian.net";
const MR_URL = "https://github.com/real-repo-fixture/real-repo-fixture/pull/7";
const REVIEW_TICKET_MR_URL = "https://github.com/real-repo-fixture/real-repo-fixture/pull/9";
const PROGRESS_NOTE = "confirmed the web read path renders real CLI output end to end";
const DONE_NOTE = "web-real-repo smoke coverage landed; verified against a genuine CLI lifecycle";

// XSS-shaped strings, one per attacker-influenced field category this
// ticket's brief names ("names, spec, notes, resolution,
// actor names, MR/urls") that has a real CLI write path — MR itself is
// EXCLUDED (`mrUrlSchema`, core/entities/ticket.ts, rejects a non-http(s)
// scheme at write time, so `slop review --mr javascript:...` can never
// even reach the db through the real CLI; that render-time backstop is
// covered directly by `renderMrLink`'s own unit tests instead).
const XSS_MARK = '<img src=x onerror="alert(1)">';
const RESOLUTION_MD = [
  "## Root cause",
  "",
  "Fixed by validating config **before** startup.",
  "",
  "- verified from source",
  "- verified against the compiled binary",
  "",
  "[bad link](javascript:alert('resolution-xss'))",
  "",
  "![bad image](data:image/png;base64,QQ==)",
  "",
  "[safe link](https://example.com/resolution/9)",
  "",
  `${XSS_MARK}plain text survives`,
].join("\n");
const XSS_PROGRESS_NOTE = `${XSS_MARK}progress-note-xss-marker`;
const XSS_ACTOR_NAME = `${XSS_MARK}xss-actor`;

async function get(path: string, init?: RequestInit): Promise<Response> {
  if (!server) throw new Error("server not started");
  return fetch(new URL(path, server.baseUrl), init);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "slop-web-real-repo-"));

  const init = runSlop(
    ["init", "--yes", "--project", "real-repo-fixture", "--user", "ryan", "--jira", JIRA_BASE],
    root,
  );
  expect(init.status, init.stderr).toBe(0);

  // A blocked dependent (design.md §2/§4.4: "Blocked" badge, D5's `blocks`
  // convention — "X.blocks = [Y]" reads "X blocks Y") — created first so
  // blockerTicket below can name it.
  dependentTicket = newTicket(root, "Write v2 gateway client SDK docs");

  // blockerTicket: a LOCAL ROOT whose own parent is an EXTERNAL jira: ref
  // (D1 — an external parent terminates the local tree; §4.4's tree/badge
  // rendering is exercised via /tree below) that ALSO blocks
  // dependentTicket, and is never itself started/done — so
  // dependentTicket stays "Blocked" for the lifetime of this fixture,
  // exactly the shape /tickets and /tickets/:id render a live blocker as.
  blockerTicket = newTicket(root, "Roll out v2 API gateway", [
    "--parent",
    "jira:PROJ-1",
    "--blocks",
    dependentTicket.id,
  ]);

  // mainTicket: the one driven through a REAL init->new->start->plan->
  // plan --check->update --progress->review --mr->done lifecycle — this
  // is what exercises the write path this ticket exists to catch drift
  // in. A distinctive `--spec` (summary/details_md/acceptance) proves the
  // ticket-detail view renders real spec content, not just name/slug.
  mainTicket = newTicketWithSpec(root, "Add web coverage against a CLI-produced repo", {
    summary:
      "Prove slop web renders exactly what a real CLI lifecycle produced, not a hand-built fixture.",
    details_md:
      "## Why\n\nEvery existing slop web test runs against a hand-built fixture db, never a repo the " +
      "real CLI produced.\n\n- Exercise the write path all the way into the web read path\n- Catch any write/read convention drift\n",
    acceptance: [
      "slop web lists this ticket by name",
      "the ticket detail page renders this real spec",
    ],
  });

  const started = startTicket(root, mainTicket.slug);
  mainSessionId = started.session.id;
  expect(started.ticket.state).toBe("in_progress");
  // No CLAUDECODE/OPENCODE/CODEX_* env reached the child (runSlop strips
  // it all) — harness auto-detection has nothing to detect, same as
  // C4.test.ts's "other" harness case.
  expect(started.session.harness).toBe("other");

  plan(root, mainTicket.slug, [
    "Read the D5 web-server-spawn harness conventions",
    "Write the new acceptance test against the compiled binary",
    "Verify assertions hold when spawned from source",
    "Verify assertions hold against the compiled binary",
  ]);
  planCheck(root, mainTicket.slug, 1);
  planCheck(root, mainTicket.slug, 2);

  updateProgress(root, mainTicket.slug, PROGRESS_NOTE);
  // A second, lock-free progress note (ticket_01KY9S0172V8AYCYV9KWS6RC9P) —
  // carries raw HTML, proving the updates timeline's inline "progress
  // note: ..." rendering (ticket-detail.ts's renderTimelineEntry) escapes
  // it rather than rendering it live. Both notes remain in the immutable
  // event timeline (events are append-only — only `latest_note` itself
  // ends up as whichever was written last).
  updateProgress(root, mainTicket.slug, XSS_PROGRESS_NOTE);

  review(root, mainTicket.slug, MR_URL);
  // `--outcome`: the resolution writeup (RESOLUTION_MD) carries the same
  // javascript:/raw-HTML XSS shapes ticket-detail.test.ts's dedicated
  // resolution test already covers in isolation — proven here against a
  // ticket that also has a full real session/plan/review history around
  // it, not just a bare `done` call.
  done(root, mainTicket.slug, DONE_NOTE, RESOLUTION_MD);

  // --- ticket_01KY9S0172V8AYCYV9KWS6RC9P: relationships beyond blocks/blocked-by ---

  parentTicket = newTicket(root, "Parent ticket for relationship coverage");
  childTicket = newTicket(root, "Child ticket for relationship coverage", [
    "--parent",
    parentTicket.id,
  ]);

  // relates-to: no `--relates-to` flag exists on any mutating command
  // today (see `editRelatesTo`'s own doc) — set via a scripted `slop edit`
  // instead, still the real write path.
  relatesTarget = newTicket(root, "Relates to the main ticket");
  await editRelatesTo(root, mainTicket.slug, relatesTarget.id);

  // discovered-from, AND an actor-name XSS check in one call: the actor
  // who creates this ticket resolves via SLOP_ACTOR (D17, highest
  // precedence), landing in `provenance.created_by.name` — rendered on
  // discoveredTicket's own detail page's "Provenance" row.
  discoveredTicket = newTicketWithEnv(
    root,
    "Discovered while working the main ticket",
    ["--discovered-from", mainTicket.id],
    { SLOP_ACTOR: XSS_ACTOR_NAME },
  );

  // --- stale/review-stale overlays: two tickets deliberately left mid-flight ---

  staleTicket = newTicket(root, "Left in_progress to go stale");
  const staleStarted = startTicket(root, staleTicket.slug);
  staleSessionId = staleStarted.session.id;
  // Never stopped/reviewed/done — stays in_progress, active_session set,
  // for the lifetime of this fixture.

  reviewTicket = newTicket(root, "Left in review to go review-stale");
  startTicket(root, reviewTicket.slug);
  review(root, reviewTicket.slug, REVIEW_TICKET_MR_URL);
  // Never done — stays in review for the lifetime of this fixture.

  // SLOP_FAKE_NOW (src/cli/commands/web.ts's testing-only clock
  // override, same convention D5.test.ts uses): every OTHER ticket in
  // this fixture ends in a terminal or never-started state (done/open),
  // which `isTicketStale` never flags regardless of the clock — only
  // staleTicket (in_progress) and reviewTicket (review) actually move
  // under this. +25h clears both the default `stale_after` (60m) and
  // `review_stale_after` (24h) thresholds without this file sleeping for
  // either.
  const fakeNowIso = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();

  server = await spawnAndWaitForUrl(binaryPath, ["web", "--port", "0"], root, {
    ...process.env,
    CLAUDECODE: undefined,
    OPENCODE: undefined,
    CODEX_SANDBOX: undefined,
    CODEX_SANDBOX_NETWORK_DISABLED: undefined,
    SLOP_FAKE_NOW: fakeNowIso,
  });
}, 90_000);

afterAll(async () => {
  await stopServer(server);
  if (root) await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Assertions — a focused smoke test, not a second D5.test.ts: a handful of
// strong, real-data assertions per API route.
//
// rewrite-slop-web-as-a: every assertion below now drives `/api/*` and
// inspects parsed JSON, not server-rendered HTML strings — see D5.test.ts's
// header comment for why (the SPA, not this black-box HTTP suite, owns
// presentation now). Two categories of the OLD assertions here changed
// shape rather than just moving:
//
//  - "escaped in the HTML" (progress notes, actor names): a JSON API has no
//    HTML to escape into in the first place — `JSON.stringify` already
//    makes arbitrary string content byte-safe on the wire, and the SPA
//    renders plain-text fields through ordinary React children (which
//    HTML-escapes by construction, the same guarantee `escapeHtml` used to
//    provide by hand). What's left to prove at this layer is simpler and
//    still real: the API must hand back the attacker-shaped string
//    VERBATIM, never interpreted/stripped/mangled — proven below by exact
//    equality checks.
//  - markdown-derived fields (`spec.details_html`, `resolution_html`)
//    keep the FULL old XSS-neutralisation
//    assertions unchanged in spirit — these are still real, sanitized HTML
//    strings (src/web/markdown.ts), so `javascript:`/`data:` neutralisation
//    is exactly as testable, and exactly as load-bearing, as before.
// ---------------------------------------------------------------------------

interface TicketDetailLike {
  ticket: {
    id: string;
    name: string;
    handle: string;
    state: string;
    review: { mr: { url: string; safe_url: string | null } | null } | null;
    overlay: {
      blocked: boolean;
      blocked_by: Array<{ name: string }>;
      stale: boolean;
      stale_reason: { state: string; threshold: string } | null;
    };
    parent: { kind: string; ref?: { kind: string; ref: { id: string; name: string } } };
  };
  children: Array<{ id: string; name: string }>;
  relationships: {
    blocks: Array<{ kind: string; ref: { id: string; name: string } }>;
    blocked_by: Array<{ kind: string; ref: { id: string; name: string } }>;
    relates_to: Array<{ kind: string; ref: { id: string; name: string } }>;
    discovered_from: Array<{ kind: string; ref: { id: string; name: string } }>;
    discovered_here: Array<{ kind: string; ref: { id: string; name: string } }>;
  };
  spec: { summary: string; details_html: string; acceptance: string[] };
  resolution_html: string | null;
  events: Array<{
    verb: string;
    label: string;
    entity_kind: "ticket" | "session";
    progress_note: string | null;
    payload: Record<string, unknown>;
  }>;
  sessions: Array<{
    id: string;
    actor: { name: string };
    harness: string;
    end_summary: string | null;
    is_active: boolean;
    plan: Array<{ version: number; steps: Array<{ text: string; checked: boolean }> }>;
  }>;
  provenance: { created_by: { name: string } };
}

async function getTicketDetail(id: string): Promise<{ status: number; body: TicketDetailLike }> {
  const res = await get(`/api/tickets/${id}`);
  return { status: res.status, body: (await res.json()) as TicketDetailLike };
}

describe("web against a real init/new/start/plan/review/done lifecycle", () => {
  // Every ticket this file's beforeAll creates — used wherever a test needs
  // "every real ticket", so the count/list here never drifts out of sync
  // with however many `newTicket*` calls beforeAll happens to make.
  const allTickets = (): NewTicketJson[] => [
    dependentTicket,
    blockerTicket,
    mainTicket,
    parentTicket,
    childTicket,
    relatesTarget,
    discoveredTicket,
    staleTicket,
    reviewTicket,
  ];

  describe("/api/tickets", () => {
    it("lists every real ticket by name and slug", async () => {
      const res = await get("/api/tickets");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        tickets: Array<{ name: string; slug: string }>;
      };
      const tickets = allTickets();
      expect(body.total).toBe(tickets.length);
      const names = body.tickets.map((t) => t.name);
      const slugs = body.tickets.map((t) => t.slug);
      for (const t of tickets) {
        expect(names, `expected /api/tickets to list "${t.name}"`).toContain(t.name);
        expect(slugs).toContain(t.slug);
      }
    });

    it("state=done filters down to exactly the ticket that went through done", async () => {
      const res = await get("/api/tickets?state=done");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tickets: Array<{ name: string }> };
      const names = body.tickets.map((t) => t.name);
      expect(names).toContain(mainTicket.name);
      expect(names).not.toContain(dependentTicket.name);
      expect(names).not.toContain(blockerTicket.name);
    });

    it("shows a live blocked overlay on the real dependent ticket's own row", async () => {
      const res = await get("/api/tickets");
      const body = (await res.json()) as {
        tickets: Array<{ slug: string; overlay: { blocked: boolean } }>;
      };
      const row = body.tickets.find((t) => t.slug === dependentTicket.slug);
      expect(row?.overlay.blocked).toBe(true);
    });
  });

  describe("/api/tree", () => {
    it("renders the real external jira: parent as a badge built from remotes.jira", async () => {
      const res = await get("/api/tree");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        roots: Array<{
          ticket: { name: string };
          external_parent: { safe_url: string | null } | null;
        }>;
      };
      const node = body.roots.find((r) => r.ticket.name === blockerTicket.name);
      expect(node, "expected blockerTicket as a local root with an external parent").toBeDefined();
      expect(node?.external_parent?.safe_url).toBe(`${JIRA_BASE}/browse/PROJ-1`);
    });
  });

  describe("ticket detail: the blocked dependent", () => {
    it("200s and shows the blocked overlay on its own page", async () => {
      const { status, body } = await getTicketDetail(dependentTicket.id);
      expect(status).toBe(200);
      expect(body.ticket.name).toBe(dependentTicket.name);
      expect(body.ticket.overlay.blocked).toBe(true);
    });
  });

  describe("ticket detail: the real lifecycle ticket", () => {
    it("renders the real spec: summary, details_md as sanitized HTML, acceptance[]", async () => {
      const { status, body } = await getTicketDetail(mainTicket.id);
      expect(status).toBe(200);

      expect(body.ticket.name).toBe(mainTicket.name);
      expect(body.spec.summary).toContain(
        "Prove slop web renders exactly what a real CLI lifecycle produced, not a hand-built fixture.",
      );
      expect(body.spec.details_html).toContain("<h2>Why</h2>");
      expect(body.spec.details_html).not.toContain("## Why");
      expect(body.spec.acceptance).toContain("slop web lists this ticket by name");
      expect(body.spec.acceptance).toContain("the ticket detail page renders this real spec");
    });

    it("shows the real final state and the real --note as the session's end summary", async () => {
      const { body } = await getTicketDetail(mainTicket.id);
      expect(body.ticket.state).toBe("done");
      expect(body.sessions.some((s) => s.end_summary === DONE_NOTE)).toBe(true);
    });

    it("shows the real plan version with its real checked-step count and step text", async () => {
      const { body } = await getTicketDetail(mainTicket.id);
      const v1 = body.sessions[0]?.plan.find((p) => p.version === 1);
      expect(v1?.steps.filter((s) => s.checked).length).toBe(2);
      expect(v1?.steps.length).toBe(4);
      expect(
        v1?.steps.some(
          (s) => s.text === "Write the new acceptance test against the compiled binary",
        ),
      ).toBe(true);
    });

    it("shows the real session's actor/harness", async () => {
      const { body } = await getTicketDetail(mainTicket.id);
      const session = body.sessions[0];
      expect(session?.actor.name).toBe("ryan");
      expect(session?.harness).toBe("other");
      expect(session?.id).toBe(mainSessionId);
    });

    it("shows the real updates timeline, including the real review MR (from the review.requested event's payload) and the progress note", async () => {
      const { body } = await getTicketDetail(mainTicket.id);
      const reviewEvent = body.events.find(
        (e) => e.verb === "review.requested" && e.entity_kind === "ticket",
      );
      const doneEvent = body.events.find((e) => e.verb === "ticket.done");
      expect(reviewEvent?.label).toBe("requested review");
      expect(doneEvent?.label).toBe("marked done");
      expect(reviewEvent?.payload.mr).toBe(MR_URL);
      expect(body.events.some((e) => e.progress_note === PROGRESS_NOTE)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // ticket_01KY9S0172V8AYCYV9KWS6RC9P: everything the ticket-detail page adds
  // — handle, both-direction relationships, overlay reasons, resolution, and
  // the XSS-neutralisation guarantee — against this real CLI-produced repo.
  // ---------------------------------------------------------------------------

  describe("ticket detail: the short t-<code> handle", () => {
    it("returns the derived handle for the real ticket id", async () => {
      const { body } = await getTicketDetail(mainTicket.id);
      expect(body.ticket.handle).toBe(shortTicketCode(mainTicket.id));
    });
  });

  describe("ticket detail: parent/children (both directions)", () => {
    it("childTicket's detail references its real parent", async () => {
      const { body } = await getTicketDetail(childTicket.id);
      expect(body.ticket.parent.kind).toBe("local");
      expect(body.ticket.parent.ref?.ref.id).toBe(parentTicket.id);
      expect(body.ticket.parent.ref?.ref.name).toBe(parentTicket.name);
    });

    it("parentTicket's detail lists the real child", async () => {
      const { body } = await getTicketDetail(parentTicket.id);
      expect(body.children.map((c) => c.id)).toContain(childTicket.id);
      expect(body.children.map((c) => c.name)).toContain(childTicket.name);
    });
  });

  describe("ticket detail: blocks / blocked-by (both directions) + the blocked overlay reason", () => {
    it("blockerTicket's detail shows the real dependent under blocks →", async () => {
      const { body } = await getTicketDetail(blockerTicket.id);
      const ids = body.relationships.blocks.map((r) => r.ref.id);
      expect(ids).toContain(dependentTicket.id);
    });

    it("dependentTicket's detail shows the real blocker under ← blocked-by, AND names it in the blocked-overlay reason", async () => {
      const { body } = await getTicketDetail(dependentTicket.id);
      const ids = body.relationships.blocked_by.map((r) => r.ref.id);
      expect(ids).toContain(blockerTicket.id);
      // The overlay reason (overlay.blocked_by), not just the structural edge.
      expect(body.ticket.overlay.blocked).toBe(true);
      expect(body.ticket.overlay.blocked_by.map((b) => b.name)).toContain(blockerTicket.name);
    });
  });

  describe("ticket detail: relates-to (both directions, set via a scripted slop edit)", () => {
    it("mainTicket's detail shows relatesTarget under relates_to", async () => {
      const { body } = await getTicketDetail(mainTicket.id);
      const ids = body.relationships.relates_to.map((r) => r.ref.id);
      expect(ids).toContain(relatesTarget.id);
    });

    it("relatesTarget's detail shows mainTicket under relates_to (the derived reverse)", async () => {
      const { body } = await getTicketDetail(relatesTarget.id);
      const ids = body.relationships.relates_to.map((r) => r.ref.id);
      expect(ids).toContain(mainTicket.id);
    });
  });

  describe("ticket detail: discovered-from / discovered-here (both directions)", () => {
    it("discoveredTicket's detail shows mainTicket under discovered_from →", async () => {
      const { body } = await getTicketDetail(discoveredTicket.id);
      const ids = body.relationships.discovered_from.map((r) => r.ref.id);
      expect(ids).toContain(mainTicket.id);
    });

    it("mainTicket's detail shows discoveredTicket under ← discovered_here", async () => {
      const { body } = await getTicketDetail(mainTicket.id);
      const ids = body.relationships.discovered_here.map((r) => r.ref.id);
      expect(ids).toContain(discoveredTicket.id);
    });
  });

  describe("ticket detail: the stale (in_progress) overlay reason + active-session data", () => {
    it("shows the stale overlay, the reason, and flags the real session as active", async () => {
      const { status, body } = await getTicketDetail(staleTicket.id);
      expect(status).toBe(200);
      expect(body.ticket.overlay.stale).toBe(true);
      expect(body.ticket.overlay.stale_reason?.state).toBe("in_progress");
      expect(body.ticket.overlay.stale_reason?.threshold).toBe("60m");
      const session = body.sessions.find((s) => s.id === staleSessionId);
      expect(session?.is_active).toBe(true);
    });
  });

  describe("ticket detail: the review-stale overlay reason + review section with its real MR", () => {
    it("shows the stale overlay, the review-anchored reason, and the real MR link", async () => {
      const { status, body } = await getTicketDetail(reviewTicket.id);
      expect(status).toBe(200);
      expect(body.ticket.overlay.stale).toBe(true);
      expect(body.ticket.overlay.stale_reason?.state).toBe("review");
      expect(body.ticket.overlay.stale_reason?.threshold).toBe("24h");
      expect(body.ticket.review?.mr?.url).toBe(REVIEW_TICKET_MR_URL);
      expect(body.ticket.review?.mr?.safe_url).toBe(REVIEW_TICKET_MR_URL);
    });

    it("also shows up on /api/review and /api/stale", async () => {
      const reviewPanel = (await (await get("/api/review")).json()) as {
        tickets: Array<{ name: string; review: { mr: { url: string } | null } | null }>;
      };
      const row = reviewPanel.tickets.find((t) => t.name === reviewTicket.name);
      expect(row?.review?.mr?.url).toBe(REVIEW_TICKET_MR_URL);

      const stalePanel = (await (await get("/api/stale")).json()) as {
        rows: Array<{ ticket: { name: string } }>;
      };
      const names = stalePanel.rows.map((r) => r.ticket.name);
      expect(names).toContain(reviewTicket.name);
      expect(names).toContain(staleTicket.name);
    });
  });

  describe("ticket detail: resolution (--outcome), rendered as sanitized markdown HTML", () => {
    it("renders the real markdown, keeps the safe link live, and neutralises both the javascript: link and the data: image", async () => {
      const { body } = await getTicketDetail(mainTicket.id);
      const html = body.resolution_html ?? "";

      expect(html).toContain("<h2>Root cause</h2>");
      expect(html).toContain("<strong>before</strong>");
      expect(html).toContain("<li>verified from source</li>");

      // Safe link survives as a live href.
      expect(html).toContain('href="https://example.com/resolution/9"');

      // javascript: link neutralised — no live href, inert text still shows.
      expect(html).not.toMatch(/href="javascript:/i);
      expect(html).toContain("bad link");

      // data: image neutralised — no live src.
      expect(html).not.toMatch(/src="data:/i);

      // Raw HTML neutralised (escaped, not a live tag).
      expect(html).not.toContain('<img src=x onerror="alert(1)">plain text survives');
      expect(html).toContain("plain text survives");
    });
  });

  describe("ticket detail: a lock-free progress note carried through verbatim", () => {
    it("returns the attacker-shaped note as inert string data, not interpreted in any way", async () => {
      const { body } = await getTicketDetail(mainTicket.id);
      const notes = body.events.map((e) => e.progress_note).filter((n): n is string => n !== null);
      // Exact round-trip — never stripped, never rendered as live HTML server-side
      // (there IS no server-side HTML rendering left to inject into; the SPA renders
      // this through a plain React text child, which HTML-escapes by construction).
      expect(notes).toContain(XSS_PROGRESS_NOTE);
      expect(notes).toContain(PROGRESS_NOTE); // the earlier, benign note is still present too
    });
  });

  describe("ticket detail: an attacker-shaped actor name (provenance.created_by) carried through verbatim", () => {
    it("returns the real SLOP_ACTOR-resolved name unmodified", async () => {
      const { body } = await getTicketDetail(discoveredTicket.id);
      expect(body.provenance.created_by.name).toBe(XSS_ACTOR_NAME);
    });
  });

  describe("read-only contract", () => {
    it("POST to a real ticket detail API route returns 405, not a mutation", async () => {
      const res = await get(`/api/tickets/${mainTicket.id}`, { method: "POST" });
      expect(res.status).toBe(405);
    });

    it("POST to /api/tickets (the list route) returns 405", async () => {
      const res = await get("/api/tickets", { method: "POST" });
      expect(res.status).toBe(405);
    });
  });
});
