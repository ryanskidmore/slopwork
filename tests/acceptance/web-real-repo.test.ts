import {
  type ChildProcess,
  type SpawnSyncReturns,
  execFileSync,
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

function runSlop(args: string[], cwd: string, input?: string): SpawnSyncReturns<string> {
  return spawnSync(binaryPath, args, {
    cwd,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      CLAUDE_CODE_CHILD_SESSION: undefined,
      CLAUDE_CODE_SESSION_ID: undefined,
      OPENCODE: undefined,
      OPENCODE_PID: undefined,
      CODEX_SANDBOX: undefined,
      CODEX_SANDBOX_NETWORK_DISABLED: undefined,
      CODEX_HOME: undefined,
      SLOP_TEST_CLAUDE_HOME: undefined,
    },
  });
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

function done(root: string, ref: string, note: string, transcriptPath: string): void {
  const result = runSlop(["done", ref, "--note", note, "--transcript", transcriptPath], root);
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

// The three tickets this lifecycle produces:
let dependentTicket: NewTicketJson; // blocked by blockerTicket the whole time — never started.
let blockerTicket: NewTicketJson; // external jira: parent; blocks dependentTicket; never started.
let mainTicket: NewTicketJson; // driven through the full start/plan/review/done lifecycle.
let mainSessionId: string;

const JIRA_BASE = "https://real-repo-fixture.atlassian.net";
const MR_URL = "https://github.com/real-repo-fixture/real-repo-fixture/pull/7";
const PROGRESS_NOTE = "confirmed the web read path renders real CLI output end to end";
const DONE_NOTE = "web-real-repo smoke coverage landed; verified against a genuine CLI lifecycle";
const TRANSCRIPT_USER_MARKER =
  "please prove slop web can render a transcript that review and done actually captured";
const TRANSCRIPT_ASSISTANT_MARKER =
  "Captured. Running the verification command now before handing this back.";

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
    ].join("\n")}\n`,
    "utf8",
  );

  review(root, mainTicket.slug, MR_URL, transcriptPath);
  done(root, mainTicket.slug, DONE_NOTE, transcriptPath);

  server = await spawnAndWaitForUrl(binaryPath, ["web", "--port", "0"], root, {
    ...process.env,
    CLAUDECODE: undefined,
    OPENCODE: undefined,
    CODEX_SANDBOX: undefined,
    CODEX_SANDBOX_NETWORK_DISABLED: undefined,
  });
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  if (root) await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Assertions — a focused smoke test, not a second D5.test.ts: a handful of
// strong, real-data assertions per view.
// ---------------------------------------------------------------------------

describe("web against a real init/new/start/plan/review/done lifecycle", () => {
  describe("/tickets", () => {
    it("lists all three real tickets by name and slug", async () => {
      const res = await get("/tickets");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("3 of 3 tickets");
      for (const t of [dependentTicket, blockerTicket, mainTicket]) {
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
  });
});
