import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { fixedClock } from "../../core/clock.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import type { Ticket, TicketId } from "../../core/index.js";
import { newSessionId, newTicketId, ticketSchema } from "../../core/index.js";
import type { RepoPaths } from "../../repo/index.js";
import { readSession, readTicket, repoPaths } from "../../repo/index.js";
import { buildDoneTicket, runDone } from "./done.js";
import { runDrop } from "./drop.js";
import { runNew } from "./new.js";
import { runReview } from "./review.js";
import { runStart } from "./start.js";

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
    const done = buildDoneTicket(ticket, "shipped", undefined, clock);
    expect(done.state).toBe("done");
    expect(done.review).toBeUndefined();
    expect(done.active_session).toBeNull();
  });

  it("sets latest_note from --note when given", () => {
    const ticket = makeTicket({ latest_note: "old note" });
    const done = buildDoneTicket(ticket, "final note", undefined, clock);
    expect(done.latest_note).toBe("final note");
  });

  it("leaves latest_note untouched when no --note was given", () => {
    const ticket = makeTicket({ latest_note: "old note" });
    const done = buildDoneTicket(ticket, undefined, undefined, clock);
    expect(done.latest_note).toBe("old note");
  });

  it("bumps last_activity_at/updated_at", () => {
    const ticket = makeTicket({ last_activity_at: "2020-01-01T00:00:00.000Z" });
    const done = buildDoneTicket(ticket, undefined, undefined, clock);
    expect(done.last_activity_at).toBe("2026-07-23T12:00:00.000Z");
    expect(done.updated_at).toBe("2026-07-23T12:00:00.000Z");
  });
});

// `resolution` (ticket_01KY9RWFGVDQNDH1XN43A0GH1M): `--outcome` stores it
// on the ticket, mirroring how `--note` stores `latest_note` above —
// "given wins, else leave whatever was already there" (buildDoneTicket's
// doc comment), and absent stays absent (never coerced to null/"").
describe("buildDoneTicket — resolution (--outcome)", () => {
  const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

  it("stores resolution when given", () => {
    const ticket = makeTicket();
    const done = buildDoneTicket(ticket, undefined, "Root cause: X. Fixed by Y.", clock);
    expect(done.resolution).toBe("Root cause: X. Fixed by Y.");
  });

  it("round-trips a multi-line resolution", () => {
    const ticket = makeTicket();
    const resolution = "## Investigation\n\nline one\nline two\n\n- a\n- b";
    const done = buildDoneTicket(ticket, undefined, resolution, clock);
    expect(done.resolution).toBe(resolution);
  });

  it("leaves resolution undefined when no --outcome was given (same convention as `review` above)", () => {
    const ticket = makeTicket();
    const done = buildDoneTicket(ticket, "just a note", undefined, clock);
    expect(done.resolution).toBeUndefined();
  });

  it("--note and --outcome coexist: both are stored independently", () => {
    const ticket = makeTicket();
    const done = buildDoneTicket(ticket, "short note", "long-form writeup", clock);
    expect(done.latest_note).toBe("short note");
    expect(done.resolution).toBe("long-form writeup");
  });

  it("a resolution already on the ticket survives a done call that omits --outcome", () => {
    const ticket = makeTicket({ resolution: "earlier writeup" });
    const done = buildDoneTicket(ticket, undefined, undefined, clock);
    expect(done.resolution).toBe("earlier writeup");
  });

  it("existing done behavior (state/session-independent fields) is unchanged when --outcome is used", () => {
    const ticket = makeTicket();
    const done = buildDoneTicket(ticket, "shipped", "writeup", clock);
    expect(done.state).toBe("done");
    expect(done.review).toBeUndefined();
    expect(done.active_session).toBeNull();
    expect(done.last_activity_at).toBe("2026-07-23T12:00:00.000Z");
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

/** Same as {@link runSlop}, but pipes `input` in on stdin — for exercising
 * `--outcome -` (reads stdin, mirroring `--spec -`) as a real spawned
 * process rather than unit-testing `readStdin` in isolation. */
function runSlopWithStdin(args: string[], cwd: string, input: string): SpawnSyncReturns<string> {
  const env: Record<string, string | undefined> = { ...process.env, SLOP_ACTOR: "done-test-actor" };
  for (const key of STRIPPED_ENV_KEYS) env[key] = undefined;
  return spawnSync("bun", [cliEntry, ...args], { cwd, encoding: "utf8", env, input });
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

// ---------------------------------------------------------------------------
// ticket_01KY9RWFGVDQNDH1XN43A0GH1M: `done --outcome` stores a durable
// `resolution` writeup on the ticket. Real spawned processes (same style as
// the suites above) so `--outcome -`'s stdin read is exercised for real,
// not just unit-tested against `buildDoneTicket`, and so the full done
// write (state/session finalize/cascade) is proven undisturbed alongside it.
// ---------------------------------------------------------------------------

describe("done — resolution (ticket_01KY9RWFGVDQNDH1XN43A0GH1M): --outcome <text>", () => {
  it("stores --outcome as the ticket's resolution", async () => {
    const { root, paths } = await makeFixtureRepo();
    const { id, slug } = createTicket(root, "Investigation ticket");

    const started = runSlop(["start", slug], root);
    expect(started.status, started.stderr).toBe(0);

    const done = runSlop(
      [
        "done",
        slug,
        "--note",
        "done",
        "--outcome",
        "Root cause: stale cache. Fixed by invalidating on write.",
      ],
      root,
    );
    expect(done.status, done.stderr).toBe(0);

    const ticketAfterDone = await readTicket(paths, id);
    expect(ticketAfterDone.resolution).toBe(
      "Root cause: stale cache. Fixed by invalidating on write.",
    );
    // state/session/cascade machinery is unaffected by --outcome.
    expect(ticketAfterDone.state).toBe("done");
    expect(ticketAfterDone.active_session).toBeNull();
  });

  it("reads --outcome - from stdin, mirroring --spec -", async () => {
    const { root, paths } = await makeFixtureRepo();
    const { id, slug } = createTicket(root, "Stdin outcome ticket");

    const started = runSlop(["start", slug], root);
    expect(started.status, started.stderr).toBe(0);

    const multiline = "## Findings\n\nline one\nline two\n\n- step a\n- step b\n";
    const done = runSlopWithStdin(["done", slug, "--outcome", "-"], root, multiline);
    expect(done.status, done.stderr).toBe(0);

    const ticketAfterDone = await readTicket(paths, id);
    // resolutionSchema trims — compare against the trimmed form.
    expect(ticketAfterDone.resolution).toBe(multiline.trim());
  });

  it("leaves resolution absent when --outcome is not given", async () => {
    const { root, paths } = await makeFixtureRepo();
    const { id, slug } = createTicket(root, "No outcome ticket");

    const started = runSlop(["start", slug], root);
    expect(started.status, started.stderr).toBe(0);

    const done = runSlop(["done", slug, "--note", "shipped, no writeup"], root);
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain("resolution: (none)");

    const ticketAfterDone = await readTicket(paths, id);
    expect(ticketAfterDone.resolution).toBeUndefined();
    expect(ticketAfterDone as Record<string, unknown>).not.toHaveProperty("resolution");
  });

  it("--note and --outcome coexist: session end_summary and ticket resolution are stored independently", async () => {
    const { root, paths } = await makeFixtureRepo();
    const { id, slug } = createTicket(root, "Note and outcome ticket");

    const started = runSlop(["start", slug], root);
    expect(started.status, started.stderr).toBe(0);
    const ticketAfterStart = await readTicket(paths, id);
    const sessionId = ticketAfterStart.active_session;
    if (sessionId === null) throw new Error("expected an active session after start");

    const done = runSlop(
      ["done", slug, "--note", "short handoff note", "--outcome", "the full writeup"],
      root,
    );
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain("resolution: (set)");

    const sessionAfterDone = await readSession(paths, sessionId);
    expect(sessionAfterDone.end_summary).toBe("short handoff note");

    const ticketAfterDone = await readTicket(paths, id);
    expect(ticketAfterDone.latest_note).toBe("short handoff note");
    expect(ticketAfterDone.resolution).toBe("the full writeup");
  });

  it("done-cascade still fires (unblocked dependent) when --outcome is used", async () => {
    const { root, paths } = await makeFixtureRepo();
    const dependent = createTicket(root, "Dependent on an --outcome done ticket");
    const { id, slug } = createTicket(root, "Blocking ticket with outcome", [
      "--blocks",
      dependent.slug,
    ]);

    const started = runSlop(["start", slug], root);
    expect(started.status, started.stderr).toBe(0);

    const done = runSlop(["done", slug, "--outcome", "closed out the investigation"], root);
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain(dependent.id);

    const ticketAfterDone = await readTicket(paths, id);
    expect(ticketAfterDone.resolution).toBe("closed out the investigation");
    const dependentAfter = await readTicket(paths, dependent.id);
    expect(dependentAfter.state).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// In-process coverage of `runDone` (real v8 coverage, no subprocess).
// ---------------------------------------------------------------------------

async function jsonNewTicket(
  root: string,
  name: string,
  extra: { blocks?: string[]; adhoc?: boolean } = {},
): Promise<TicketId> {
  const out = captureOutput();
  try {
    await withCwd(root, () =>
      runNew(name, { blocks: [], relatesTo: [], label: [], json: true, ...extra }),
    );
    return (JSON.parse(out.stdout()) as { id: TicketId }).id;
  } finally {
    out.restore();
  }
}

async function startTicket(root: string, id: TicketId): Promise<void> {
  const out = captureOutput();
  try {
    await withCwd(root, () => runStart(id, {}));
  } finally {
    out.restore();
  }
}

describe("runDone (in-process)", () => {
  it("completes review -> done with no nag, cascading an unblock", async () => {
    const root = await makeTempRepo("slop-done-inproc-review-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const dependent = await jsonNewTicket(root, "Dependent ticket");
    const id = await jsonNewTicket(root, "Blocking ticket", { blocks: [dependent] });
    await startTicket(root, id);
    const reviewOut = captureOutput();
    try {
      await withCwd(root, () => runReview(id, { mr: "https://example.com/pr/1" }));
    } finally {
      reviewOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runDone(id, { note: "shipped via review" }));
      expect(out.stderr()).not.toMatch(/review\/MR/i);
      expect(out.stdout()).toContain(dependent);
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    const ticket = await readTicket(paths, id);
    expect(ticket.state).toBe("done");
    expect(ticket.active_session).toBeNull();
    const dependentTicket = await readTicket(paths, dependent);
    expect(dependentTicket.state).toBe("open");
  });

  it("completes in_progress -> done directly for a non-adhoc ticket, nagging on stderr", async () => {
    const root = await makeTempRepo("slop-done-inproc-nag-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Non-adhoc direct-done ticket");
    await startTicket(root, id);

    const out = captureOutput();
    try {
      await withCwd(root, () => runDone(id, { note: "shipped, skipped review" }));
      expect(out.stderr()).toMatch(/done without a review\/MR/i);
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).state).toBe("done");
  });

  it("completes in_progress -> done directly for an adhoc ticket silently (no nag)", async () => {
    const root = await makeTempRepo("slop-done-inproc-adhoc-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Adhoc direct-done ticket", { adhoc: true });
    await startTicket(root, id);

    const out = captureOutput();
    try {
      await withCwd(root, () => runDone(id, { note: "adhoc, shipped" }));
      expect(out.stderr()).not.toMatch(/review\/MR/i);
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).state).toBe("done");
  });

  it("--outcome stores a resolution writeup on the ticket", async () => {
    const root = await makeTempRepo("slop-done-inproc-outcome-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Outcome ticket", { adhoc: true });
    await startTicket(root, id);

    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runDone(id, { note: "done", outcome: "Root cause: X. Fixed by Y." }),
      );
      expect(out.stdout()).toContain("resolution: (set)");
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).resolution).toBe("Root cause: X. Fixed by Y.");
  });

  it("refuses to complete an already-dropped ticket (CONFLICT, exit 6)", async () => {
    const root = await makeTempRepo("slop-done-inproc-conflict-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Dropped ticket");
    const dropOut = captureOutput();
    try {
      await withCwd(root, () => runDrop(id, { reason: "wontdo" }));
    } finally {
      dropOut.restore();
    }

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runDone(id, {}))).rejects.toMatchObject({
        exitCode: EXIT_CODES.CONFLICT,
      });
    } finally {
      out.restore();
    }
  });

  it("throws NOT_FOUND for an unresolvable ref", async () => {
    const root = await makeTempRepo("slop-done-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runDone("no-such-ticket", {}))).rejects.toMatchObject({
        exitCode: EXIT_CODES.NOT_FOUND,
      });
    } finally {
      out.restore();
    }
  });
});
