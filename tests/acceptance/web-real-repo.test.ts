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
// produced. DECISIONS.md's D5 entry itself flags `transcript_ref`
// ("transcripts/<session.id>.jsonl", relative to the `.slop` root) as an
// assumption made on the WRITING side (src/sessions/transcript.ts) that
// the READING side (src/web/fixture-data-source.ts's `openTranscript`)
// independently has to agree with. A drift between those two — or any
// other write-path/read-path mismatch (a field the write path never
// populates the way the view expects, an edge case only a real multi-step
// lifecycle produces) — would pass every schema check in A2.test.ts yet
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
// `SLOP_WEB_FAKE_NOW` (src/cli/commands/web.ts's testing-only clock
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
  SLOP_TEST_CLAUDE_HOME: undefined,
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

function review(root: string, ref: string, mr: string, transcriptPath: string): void {
  const result = runSlop(["review", ref, "--mr", mr, "--transcript", transcriptPath], root);
  expect(result.status, result.stderr).toBe(0);
}

function done(
  root: string,
  ref: string,
  note: string,
  transcriptPath: string,
  outcome?: string,
): void {
  const args = ["done", ref, "--note", note, "--transcript", transcriptPath];
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
let staleTicket: NewTicketJson; // started, then left in_progress forever — stale under SLOP_WEB_FAKE_NOW below.
let staleSessionId: string;
let reviewTicket: NewTicketJson; // started, reviewed, then left in review forever — review-stale under SLOP_WEB_FAKE_NOW below.

const JIRA_BASE = "https://real-repo-fixture.atlassian.net";
const MR_URL = "https://github.com/real-repo-fixture/real-repo-fixture/pull/7";
const REVIEW_TICKET_MR_URL = "https://github.com/real-repo-fixture/real-repo-fixture/pull/9";
const PROGRESS_NOTE = "confirmed the web read path renders real CLI output end to end";
const DONE_NOTE = "web-real-repo smoke coverage landed; verified against a genuine CLI lifecycle";
const TRANSCRIPT_USER_MARKER =
  "please prove slop web can render a transcript that review and done actually captured";
const TRANSCRIPT_ASSISTANT_MARKER =
  "Captured. Running the verification command now before handing this back.";

// XSS-shaped strings, one per attacker-influenced field category this
// ticket's brief names ("names, spec, notes, resolution, transcript text,
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
const TRANSCRIPT_XSS_MARKER = "transcript-xss-marker";
const TRANSCRIPT_XSS_SAFE_URL = "https://example.com/transcript/safe";

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
      "real CLI produced.\n\n- Exercise the write path all the way into the web read path\n- Catch any transcript_ref convention drift\n",
    acceptance: [
      "slop web lists this ticket by name",
      "the ticket detail page renders this real spec",
      "the transcript view renders the transcript review/done actually captured",
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

  // A real transcript file (C4.test.ts's `--transcript <path>` fallback —
  // "works for any harness ... including 'other', the default
  // no-detection case"), captured at BOTH review and done: `done`'s own
  // captureTranscript call re-locates independently of review's (C3/C4's
  // documented contract — see src/sessions/transcript.ts's module doc),
  // so re-passing --transcript at done is what keeps transcript_ref set
  // through to the final, served state rather than being recaptured to
  // null.
  const transcriptPath = join(root, "fake-transcript.jsonl");
  await writeFile(
    transcriptPath,
    `${[
      JSON.stringify({
        type: "user",
        message: { role: "user", content: TRANSCRIPT_USER_MARKER },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-5",
          content: [
            { type: "text", text: TRANSCRIPT_ASSISTANT_MARKER },
            { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "bun test" } },
          ],
        },
      }),
      // ticket_01KY9S0172V8AYCYV9KWS6RC9P: a `text` block whose markdown
      // carries a `javascript:` link alongside a safe one — transcript
      // text renders through the exact same `renderMarkdownToString` ->
      // `sanitizeMarkdownHtml` path as spec.details_md/resolution
      // (transcript-view.ts's `renderBlock`), so this is "transcript text"
      // from this ticket's XSS-safety brief, proven against a transcript a
      // real `review`/`done --transcript` call actually captured.
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-5",
          content: [
            {
              type: "text",
              text: `${TRANSCRIPT_XSS_MARKER}: [bad](javascript:alert('t')) vs [safe](${TRANSCRIPT_XSS_SAFE_URL})`,
            },
          ],
        },
      }),
    ].join("\n")}\n`,
    "utf8",
  );

  review(root, mainTicket.slug, MR_URL, transcriptPath);
  // `--outcome`: the resolution writeup (RESOLUTION_MD) carries the same
  // javascript:/raw-HTML XSS shapes ticket-detail.test.ts's dedicated
  // resolution test already covers in isolation — proven here against a
  // ticket that also has a full real session/plan/review history around
  // it, not just a bare `done` call.
  done(root, mainTicket.slug, DONE_NOTE, transcriptPath, RESOLUTION_MD);

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
  review(root, reviewTicket.slug, REVIEW_TICKET_MR_URL, transcriptPath);
  // Never done — stays in review for the lifetime of this fixture.

  // SLOP_WEB_FAKE_NOW (src/cli/commands/web.ts's testing-only clock
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
    SLOP_WEB_FAKE_NOW: fakeNowIso,
  });
}, 90_000);

afterAll(async () => {
  await stopServer(server);
  if (root) await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Assertions — a focused smoke test, not a second D5.test.ts: a handful of
// strong, real-data assertions per view.
// ---------------------------------------------------------------------------

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

  describe("/tickets", () => {
    it("lists every real ticket by name and slug", async () => {
      const res = await get("/tickets");
      expect(res.status).toBe(200);
      const body = await res.text();
      const tickets = allTickets();
      expect(body).toContain(`${tickets.length} of ${tickets.length} ticket`);
      for (const t of tickets) {
        expect(body, `expected /tickets to list "${t.name}"`).toContain(t.name);
        expect(body).toContain(t.slug);
      }
    });

    it("state=done filters down to exactly the ticket that went through done", async () => {
      const res = await get("/tickets?state=done");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(mainTicket.name);
      expect(body).not.toContain(dependentTicket.name);
      expect(body).not.toContain(blockerTicket.name);
    });

    it("shows a live Blocked badge on the real dependent ticket", async () => {
      const res = await get("/tickets");
      const body = await res.text();
      // dependentTicket's row: state badge (open) immediately followed by
      // the blocked badge — a crude but real assertion that the SAME row
      // carries both, not just that "Blocked" appears somewhere on the page.
      const rowRe = new RegExp(
        `<tr data-search="[^"]*${dependentTicket.slug}[^"]*">[\\s\\S]*?class="badge blocked"`,
      );
      expect(body).toMatch(rowRe);
    });
  });

  describe("/tree", () => {
    it("renders the real external jira: parent as a badge built from remotes.jira", async () => {
      const res = await get("/tree");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(blockerTicket.name);
      expect(body).toContain(
        `<a class="badge external-parent jira" href="${JIRA_BASE}/browse/PROJ-1"`,
      );
    });
  });

  describe("ticket detail: the blocked dependent", () => {
    it("200s and shows the Blocked badge on its own page", async () => {
      const res = await get(`/tickets/${dependentTicket.id}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(dependentTicket.name);
      expect(body).toContain('class="badge blocked"');
    });
  });

  describe("ticket detail: the real lifecycle ticket", () => {
    it("renders the real spec: summary, details_md as markdown, acceptance[]", async () => {
      const res = await get(`/tickets/${mainTicket.id}`);
      expect(res.status).toBe(200);
      const body = await res.text();

      expect(body).toContain(mainTicket.name);
      expect(body).toContain(
        "Prove slop web renders exactly what a real CLI lifecycle produced, not a hand-built fixture.",
      );
      expect(body).toContain("<h2>Why</h2>");
      expect(body).not.toContain("## Why");
      expect(body).toContain("slop web lists this ticket by name");
      expect(body).toContain(
        "the transcript view renders the transcript review/done actually captured",
      );
    });

    it("shows the real final state and the real --note as the session's end summary", async () => {
      const res = await get(`/tickets/${mainTicket.id}`);
      const body = await res.text();
      expect(body).toContain('class="badge state-done"');
      expect(body).toContain(DONE_NOTE);
    });

    it("shows the real plan version with its real checked-step count and step text", async () => {
      const res = await get(`/tickets/${mainTicket.id}`);
      const body = await res.text();
      expect(body).toContain("Plan v1 (2/4 checked)");
      expect(body).toContain("Write the new acceptance test against the compiled binary");
    });

    it("shows the real session's actor/harness and links to its real transcript", async () => {
      const res = await get(`/tickets/${mainTicket.id}`);
      const body = await res.text();
      expect(body).toContain("ryan");
      expect(body).toContain('<span class="badge">other</span>');
      expect(body).toContain(`/tickets/${mainTicket.id}/sessions/${mainSessionId}/transcript`);
    });

    it("shows the real updates timeline, including the real review MR link", async () => {
      const res = await get(`/tickets/${mainTicket.id}`);
      const body = await res.text();
      expect(body).toContain("requested review");
      expect(body).toContain("marked done");
      expect(body).toContain(MR_URL);
      expect(body).toContain(PROGRESS_NOTE);
    });
  });

  describe("transcript view: the real transcript review/done captured", () => {
    it("200s and renders the real captured conversation, not raw JSONL", async () => {
      const res = await get(`/tickets/${mainTicket.id}/sessions/${mainSessionId}/transcript`);
      expect(res.status).toBe(200);
      const body = await res.text();

      expect(body).toContain(TRANSCRIPT_USER_MARKER);
      expect(body).toContain(TRANSCRIPT_ASSISTANT_MARKER);
      expect(body).toContain("tool_use: Bash");
      expect(body).toContain('class="turn role-user"');
      expect(body).toContain('class="turn role-assistant"');
      // Never dumps the raw record straight from disk (D5's own guard,
      // re-checked here against a REAL captured file, not a hand-built one).
      expect(body).not.toContain('{"type":"user"');
      expect(body).not.toContain('{"type":"assistant"');
    });

    // ticket_01KY9S0172V8AYCYV9KWS6RC9P: "transcript text" is one of this
    // ticket's own named XSS-safety categories — a `javascript:` markdown
    // link inside a real captured transcript, neutralised the same way
    // resolution/details_md are.
    it("neutralises a javascript: link inside real transcript text, keeping the safe one live", async () => {
      const res = await get(`/tickets/${mainTicket.id}/sessions/${mainSessionId}/transcript`);
      const body = await res.text();
      expect(body).toContain(TRANSCRIPT_XSS_MARKER);
      expect(body).toContain(`href="${TRANSCRIPT_XSS_SAFE_URL}"`);
      expect(body).not.toMatch(/href="javascript:/i);
      expect(body).toContain("bad"); // the link's inert anchor text still shows
    });
  });

  // ---------------------------------------------------------------------------
  // ticket_01KY9S0172V8AYCYV9KWS6RC9P: everything the ticket-detail page adds
  // — handle, both-direction relationships, overlay reasons, resolution, and
  // the XSS-neutralisation guarantee — against this real CLI-produced repo.
  // ---------------------------------------------------------------------------

  describe("ticket detail: the short t-<code> handle", () => {
    it("renders the derived handle for the real ticket id", async () => {
      const res = await get(`/tickets/${mainTicket.id}`);
      const body = await res.text();
      expect(body).toContain(shortTicketCode(mainTicket.id));
    });
  });

  describe("ticket detail: parent/children (both directions)", () => {
    it("childTicket's page links to its real parent", async () => {
      const res = await get(`/tickets/${childTicket.id}`);
      const body = await res.text();
      expect(body).toContain(`href="/tickets/${parentTicket.id}"`);
      expect(body).toContain(parentTicket.name);
    });

    it("parentTicket's page lists the real child", async () => {
      const res = await get(`/tickets/${parentTicket.id}`);
      const body = await res.text();
      expect(body).toContain(`href="/tickets/${childTicket.id}"`);
      expect(body).toContain(childTicket.name);
    });
  });

  describe("ticket detail: blocks / blocked-by (both directions) + the blocked overlay reason", () => {
    it("blockerTicket's page shows the real dependent under Blocks →", async () => {
      const res = await get(`/tickets/${blockerTicket.id}`);
      const body = await res.text();
      expect(body).toContain("Blocks");
      expect(body).toContain(`href="/tickets/${dependentTicket.id}"`);
    });

    it("dependentTicket's page shows the real blocker under ← Blocked by, AND names it in the blocked-overlay reason", async () => {
      const res = await get(`/tickets/${dependentTicket.id}`);
      const body = await res.text();
      expect(body).toContain("Blocked by");
      expect(body).toContain(`href="/tickets/${blockerTicket.id}"`);
      expect(body).toContain(blockerTicket.name);
      // The reason line, not just the edge — see ticket-detail.ts's
      // renderOverlayReasons.
      expect(body).toContain("blocked by");
    });
  });

  describe("ticket detail: relates-to (both directions, set via a scripted slop edit)", () => {
    it("mainTicket's page shows relatesTarget under Relates to", async () => {
      const res = await get(`/tickets/${mainTicket.id}`);
      const body = await res.text();
      expect(body).toContain("Relates to");
      expect(body).toContain(`href="/tickets/${relatesTarget.id}"`);
      expect(body).toContain(relatesTarget.name);
    });

    it("relatesTarget's page shows mainTicket under Relates to (the derived reverse)", async () => {
      const res = await get(`/tickets/${relatesTarget.id}`);
      const body = await res.text();
      expect(body).toContain("Relates to");
      expect(body).toContain(`href="/tickets/${mainTicket.id}"`);
      expect(body).toContain(mainTicket.name);
    });
  });

  describe("ticket detail: discovered-from / discovered-here (both directions)", () => {
    it("discoveredTicket's page shows mainTicket under Discovered from →", async () => {
      const res = await get(`/tickets/${discoveredTicket.id}`);
      const body = await res.text();
      expect(body).toContain("Discovered from");
      expect(body).toContain(`href="/tickets/${mainTicket.id}"`);
    });

    it("mainTicket's page shows discoveredTicket under ← Discovered here", async () => {
      const res = await get(`/tickets/${mainTicket.id}`);
      const body = await res.text();
      expect(body).toContain("Discovered here");
      expect(body).toContain(`href="/tickets/${discoveredTicket.id}"`);
      expect(body).toContain(discoveredTicket.name);
    });
  });

  describe("ticket detail: the stale (in_progress) overlay reason + Active session deep link", () => {
    it("shows the Stale badge, the reason text, and links Active session to the real session's own card", async () => {
      const res = await get(`/tickets/${staleTicket.id}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('class="badge stale"');
      expect(body).toContain("no activity since");
      expect(body).toContain("threshold 60m");
      expect(body).toContain(`href="#session-${staleSessionId}"`);
      expect(body).toContain(`id="session-${staleSessionId}"`);
    });
  });

  describe("ticket detail: the review-stale overlay reason + Review section with its real MR", () => {
    it("shows the Stale badge, the review-anchored reason text, and the real MR link", async () => {
      const res = await get(`/tickets/${reviewTicket.id}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('class="badge stale"');
      expect(body).toContain("awaiting review since");
      expect(body).toContain("threshold 24h");
      expect(body).toContain(`href="${REVIEW_TICKET_MR_URL}"`);
    });

    it("also shows up on the /review and /stale panels", async () => {
      const reviewPanel = await (await get("/review")).text();
      expect(reviewPanel).toContain(reviewTicket.name);
      expect(reviewPanel).toContain(REVIEW_TICKET_MR_URL);

      const stalePanel = await (await get("/stale")).text();
      expect(stalePanel).toContain(reviewTicket.name);
      expect(stalePanel).toContain(staleTicket.name);
    });
  });

  describe("ticket detail: resolution (--outcome), rendered as markdown with XSS neutralised", () => {
    it("renders the real markdown, keeps the safe link live, and neutralises both the javascript: link and the data: image", async () => {
      const res = await get(`/tickets/${mainTicket.id}`);
      const body = await res.text();

      expect(body).toContain("<h2>Resolution</h2>");
      expect(body).toContain("<h2>Root cause</h2>");
      expect(body).toContain("<strong>before</strong>");
      expect(body).toContain("<li>verified from source</li>");

      // Safe link survives as a live href.
      expect(body).toContain('href="https://example.com/resolution/9"');

      // javascript: link neutralised — no live href, inert text still shows.
      expect(body).not.toMatch(/href="javascript:/i);
      expect(body).toContain("bad link");

      // data: image neutralised — no live src.
      expect(body).not.toMatch(/src="data:/i);

      // Raw HTML neutralised (escaped, not a live tag).
      expect(body).not.toContain('<img src=x onerror="alert(1)">plain text survives');
      expect(body).toContain("plain text survives");
    });
  });

  describe("ticket detail: a lock-free progress note, escaped in the updates timeline", () => {
    it("shows the progress note inline, HTML-escaped rather than live", async () => {
      const res = await get(`/tickets/${mainTicket.id}`);
      const body = await res.text();
      expect(body).toContain("progress note:");
      expect(body).not.toContain('<img src=x onerror="alert(1)">progress-note-xss-marker');
      expect(body).toContain("progress-note-xss-marker");
      expect(body).toContain(PROGRESS_NOTE); // the earlier, benign note is still present too
    });
  });

  describe("ticket detail: an attacker-shaped actor name (provenance.created_by), escaped", () => {
    it("escapes the real SLOP_ACTOR-resolved name in the Provenance row", async () => {
      const res = await get(`/tickets/${discoveredTicket.id}`);
      const body = await res.text();
      expect(body).toContain("Provenance");
      expect(body).not.toContain('<img src=x onerror="alert(1)">xss-actor');
      expect(body).toContain("xss-actor");
    });
  });

  describe("read-only contract", () => {
    it("POST to a real ticket detail route returns 405, not a mutation", async () => {
      const res = await get(`/tickets/${mainTicket.id}`, { method: "POST" });
      expect(res.status).toBe(405);
    });

    it("POST to /tickets (the list route) returns 405", async () => {
      const res = await get("/tickets", { method: "POST" });
      expect(res.status).toBe(405);
    });
  });
});
