import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../core/clock.js";
import type { Ticket, TicketId } from "../../core/index.js";
import { newSessionId, newTicketId, ticketSchema } from "../../core/index.js";
import type { RepoPaths } from "../../repo/index.js";
import { readSession, readTicket, repoPaths } from "../../repo/index.js";
import { buildDoneTicket } from "./done.js";

const actor = { name: "ryan", kind: "human" } as const;

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: "a-ticket",
    spec: { summary: "Do the thing" },
    state: "review",
    review: { requested_at: "2026-07-23T09:00:00.000Z", by: actor },
    active_session: newSessionId(),
    root_id: id,
    provenance: { method: "new", created_by: actor },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

describe("buildDoneTicket", () => {
  const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

  it("moves state to done and clears review + active_session", () => {
    const ticket = makeTicket();
    const done = buildDoneTicket(ticket, "shipped", clock);
    expect(done.state).toBe("done");
    expect(done.review).toBeUndefined();
    expect(done.active_session).toBeNull();
  });

  it("sets latest_note from --note when given", () => {
    const ticket = makeTicket({ latest_note: "old note" });
    const done = buildDoneTicket(ticket, "final note", clock);
    expect(done.latest_note).toBe("final note");
  });

  it("leaves latest_note untouched when no --note was given", () => {
    const ticket = makeTicket({ latest_note: "old note" });
    const done = buildDoneTicket(ticket, undefined, clock);
    expect(done.latest_note).toBe("old note");
  });

  it("bumps last_activity_at/updated_at", () => {
    const ticket = makeTicket({ last_activity_at: "2020-01-01T00:00:00.000Z" });
    const done = buildDoneTicket(ticket, undefined, clock);
    expect(done.last_activity_at).toBe("2026-07-23T12:00:00.000Z");
    expect(done.updated_at).toBe("2026-07-23T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Fix 2 (ticket_01KY9NVM1YRM1F7NX1QS5JJAW1): `review` captures a
// transcript; a later `done` recapture that finds nothing new must NOT
// reset transcript_ref back to null. Exercised as two REAL spawned `slop`
// processes from SOURCE (mirroring tests/acceptance/C4.test.ts's spawn
// style, without the compiled `dist/slop` binary), matching the exact
// scenario the ticket names: harness `other` (no auto-detection), and
// `--transcript` re-passed at `review` but NOT at the later `done`.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

/** Same rationale as tests/acceptance/C4.test.ts / stop.test.ts: strip
 * every harness-identity env var so this suite's harness is
 * deterministically "other", regardless of the ambient environment. */
const STRIPPED_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "OPENCODE",
  "OPENCODE_PID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_HOME",
  "SLOP_TEST_CLAUDE_HOME",
] as const;

function runSlop(args: string[], cwd: string): SpawnSyncReturns<string> {
  const env: Record<string, string | undefined> = { ...process.env, SLOP_ACTOR: "done-test-actor" };
  for (const key of STRIPPED_ENV_KEYS) env[key] = undefined;
  return spawnSync("bun", [cliEntry, ...args], { cwd, encoding: "utf8", env });
}

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeFixtureRepo(): Promise<{ root: string; paths: RepoPaths }> {
  const root = await mkdtemp(join(tmpdir(), "slop-done-recapture-test-"));
  scratchDirs.push(root);
  const init = runSlop(
    ["init", "--yes", "--project", "done-recapture-fixture", "--user", "ryan"],
    root,
  );
  expect(init.status, init.stderr).toBe(0);
  return { root, paths: repoPaths(root) };
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

function newTicket(root: string, name: string): { id: TicketId; slug: string } {
  const result = runSlop(["new", name], root);
  expect(result.status, result.stderr).toBe(0);
  const m = CREATED_LINE.exec(result.stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(
      `could not parse "created <id> (slug: <slug>)" out of stdout:\n${result.stdout}`,
    );
  }
  return { id: m[1] as TicketId, slug: m[2] };
}

describe("done — Fix 2 (ticket_01KY9NVM1YRM1F7NX1QS5JJAW1): a recapture that finds nothing preserves an existing transcript_ref", () => {
  it("review --transcript captures a ref; a later done WITHOUT --transcript keeps it (harness `other`, no auto-detection)", async () => {
    const { root, paths } = await makeFixtureRepo();
    const { slug, id } = newTicket(root, "Recapture-preserves ticket");

    const manualTranscript = join(root, "manual-review-transcript.jsonl");
    await writeFile(manualTranscript, '{"turn":"review time"}\n', "utf8");

    const started = runSlop(["start", slug], root);
    expect(started.status, started.stderr).toBe(0);
    // harness "other": nothing auto-detected without --transcript.
    expect(started.stdout).toContain("harness: other");

    const ticketAfterStart = await readTicket(paths, id);
    const sessionId = ticketAfterStart.active_session;
    if (sessionId === null) throw new Error("expected an active session after start");

    const reviewed = runSlop(
      ["review", slug, "--mr", "https://example.com/pr/1", "--transcript", manualTranscript],
      root,
    );
    expect(reviewed.status, reviewed.stderr).toBe(0);
    expect(reviewed.stderr).not.toMatch(/could not locate a transcript/i);

    const sessionAfterReview = await readSession(paths, sessionId);
    expect(sessionAfterReview.transcript_ref).toBe(`transcripts/${sessionId}.jsonl`);

    // The bug: `done` WITHOUT --transcript, harness `other` (zero
    // auto-detection) — a naive recapture locates nothing and used to
    // silently overwrite transcript_ref back to null here.
    const done = runSlop(["done", slug, "--note", "shipped"], root);
    expect(done.status, done.stderr).toBe(0);

    const sessionAfterDone = await readSession(paths, sessionId);
    expect(sessionAfterDone.transcript_ref).toBe(sessionAfterReview.transcript_ref);
    expect(sessionAfterDone.transcript_ref).not.toBeNull();
    expect(done.stderr).toMatch(/kept the previously-captured transcript/i);
    expect(done.stdout).toContain(`transcripts/${sessionId}.jsonl`);

    const ticketAfterDone = await readTicket(paths, id);
    expect(ticketAfterDone.state).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// ticket_01KY9RWFDR9QEWQ5B1ZACQJ338: review made optional — `done` now
// accepts `in_progress -> done` directly (D15 revised), nagging on stderr
// for non-`adhoc` tickets that skip review, silently for `adhoc` ones, and
// never for the unchanged `review -> done` path. Same real-spawned-process
// style as the fixture above (`runSlop` against SOURCE, from a fresh
// `slop init` repo) rather than unit-testing `checkDoneEntry` in isolation
// again — that's already covered by state.test.ts; this exercises the CLI
// layer's nag decision plus the finalize/cascade machinery end to end.
// ---------------------------------------------------------------------------

function createTicket(
  root: string,
  name: string,
  extraArgs: string[] = [],
): { id: TicketId; slug: string } {
  const result = runSlop(["new", name, ...extraArgs], root);
  expect(result.status, result.stderr).toBe(0);
  const m = CREATED_LINE.exec(result.stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(
      `could not parse "created <id> (slug: <slug>)" out of stdout:\n${result.stdout}`,
    );
  }
  return { id: m[1] as TicketId, slug: m[2] };
}

describe("done — review made optional (ticket_01KY9RWFDR9QEWQ5B1ZACQJ338)", () => {
  it("adhoc ticket: start then done directly completes silently — no nag on stderr", async () => {
    const { root, paths } = await makeFixtureRepo();
    const { id, slug } = createTicket(root, "Adhoc direct-done ticket", ["--adhoc"]);

    const started = runSlop(["start", slug], root);
    expect(started.status, started.stderr).toBe(0);
    const ticketAfterStart = await readTicket(paths, id);
    expect(ticketAfterStart.adhoc).toBe(true);
    const sessionId = ticketAfterStart.active_session;
    if (sessionId === null) throw new Error("expected an active session after start");

    const done = runSlop(["done", slug, "--note", "adhoc, shipped directly"], root);
    expect(done.status, done.stderr).toBe(0);
    expect(done.stderr).not.toMatch(/review\/MR/i);

    const ticketAfterDone = await readTicket(paths, id);
    expect(ticketAfterDone.state).toBe("done");
    expect(ticketAfterDone.active_session).toBeNull();

    const sessionAfterDone = await readSession(paths, sessionId);
    expect(sessionAfterDone.ended_at).not.toBeNull();
    expect(sessionAfterDone.end_summary).toBe("adhoc, shipped directly");
  });

  it(
    "non-adhoc ticket: start then done directly completes WITH a nag on stderr; ticket ends done, " +
      "session finalizes, and the done-cascade still unblocks a dependent",
    async () => {
      const { root, paths } = await makeFixtureRepo();
      const dependent = createTicket(root, "Dependent on a direct-done ticket");
      const { id, slug } = createTicket(root, "Non-adhoc direct-done ticket", [
        "--blocks",
        dependent.slug,
      ]);

      const started = runSlop(["start", slug], root);
      expect(started.status, started.stderr).toBe(0);
      const ticketAfterStart = await readTicket(paths, id);
      expect(ticketAfterStart.adhoc).toBe(false);
      const sessionId = ticketAfterStart.active_session;
      if (sessionId === null) throw new Error("expected an active session after start");

      const done = runSlop(["done", slug, "--note", "shipped without going through review"], root);
      expect(done.status, done.stderr).toBe(0);
      expect(done.stderr).toMatch(/done without a review\/MR/i);
      expect(done.stderr).toMatch(/slop review --mr/);

      const ticketAfterDone = await readTicket(paths, id);
      expect(ticketAfterDone.state).toBe("done");
      expect(ticketAfterDone.active_session).toBeNull();

      const sessionAfterDone = await readSession(paths, sessionId);
      expect(sessionAfterDone.ended_at).not.toBeNull();
      expect(sessionAfterDone.end_summary).toBe("shipped without going through review");

      // B4's done-cascade still fires on the direct in_progress -> done path.
      expect(done.stdout).toContain(dependent.id);
      const dependentAfter = await readTicket(paths, dependent.id);
      expect(dependentAfter.state).toBe("open");
      const readyAfter = runSlop(["ready", "--json"], root);
      expect(readyAfter.status, readyAfter.stderr).toBe(0);
      expect(JSON.parse(readyAfter.stdout).ready.map((r: { id: string }) => r.id)).toContain(
        dependent.id,
      );
    },
  );

  it("review -> done (unchanged path): completes with no nag, regardless of the review-skipping wording", async () => {
    const { root, paths } = await makeFixtureRepo();
    const { id, slug } = createTicket(root, "Review-then-done ticket");

    const started = runSlop(["start", slug], root);
    expect(started.status, started.stderr).toBe(0);

    const reviewed = runSlop(["review", slug, "--mr", "https://example.com/org/repo/pull/7"], root);
    expect(reviewed.status, reviewed.stderr).toBe(0);
    const ticketAfterReview = await readTicket(paths, id);
    expect(ticketAfterReview.state).toBe("review");

    const done = runSlop(["done", slug, "--note", "shipped via review"], root);
    expect(done.status, done.stderr).toBe(0);
    expect(done.stderr).not.toMatch(/review\/MR/i);

    const ticketAfterDone = await readTicket(paths, id);
    expect(ticketAfterDone.state).toBe("done");
  });
});
