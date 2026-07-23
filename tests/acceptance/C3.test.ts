import { type SpawnSyncReturns, execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TicketId, TicketState } from "../../src/core/index.js";
import type { RepoPaths } from "../../src/repo/index.js";
import { queryEvents, readSession, readTicket, repoPaths } from "../../src/repo/index.js";

// C3: Lifecycle
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "State machine property test: only legal transitions; review without
//   `--mr` nags"
//
// Both clauses get dedicated coverage below, plus the end-to-end loop and
// drop/re-entry scenarios called out in this work item's brief. Every
// command under test is driven as a REAL CLI (spawning the compiled
// `dist/slop` binary) — vitest workers run under Node, not Bun (see
// tests/acceptance/D5-adjacent suites / DECISIONS.md's D5 entry, and this
// project's own README "Testing" convention). Fixtures are built via
// `slop init` + `slop new` (+ `slop start`/`review`/... as each scenario
// needs), never by hand-writing ticket files — the point of this suite is
// to prove what the CLI itself permits and rejects.

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
// Fixture/spawn helpers (same conventions as C1.test.ts/C4.test.ts)
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Every harness-identity env var a real harness sets — stripped so this
 * suite's own ambient environment never leaks into detection. */
const STRIPPED_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "OPENCODE",
  "OPENCODE_PID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_HOME",
] as const;

function runSlop(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  const env: Record<string, string | undefined> = { ...process.env, SLOP_ACTOR: "c3-test-actor" };
  for (const key of STRIPPED_ENV_KEYS) env[key] = undefined;
  for (const [k, v] of Object.entries(envOverrides)) env[k] = v;
  return spawnSync(binaryPath, args, { cwd, encoding: "utf8", env });
}

async function makeFixtureRepo(): Promise<{ root: string; paths: RepoPaths }> {
  const root = await mkdtemp(join(tmpdir(), "slop-c3-cli-"));
  scratchDirs.push(root);
  const init = runSlop(["init", "--yes", "--project", "c3-fixture", "--user", "ryan"], root);
  expect(init.status, init.stderr).toBe(0);
  return { root, paths: repoPaths(root) };
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

function newTicket(
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

// ---------------------------------------------------------------------------
// Clause 1: "State machine property test: only legal transitions"
// ---------------------------------------------------------------------------

/**
 * Independent oracle: §2's state diagram, plus this work item's two
 * documented resolved-ambiguity decisions (DECISIONS.md's C3 entry) —
 * `done` requires `review` first (no direct `in_progress -> done` edge in
 * §2's diagram), and `stop`/`review`/`done`/`drop` don't get a same-state
 * shortcut the way `draft`/`undraft` do (re-running a side-effecting
 * action on a ticket already at its target state is a usage mistake, not
 * an idempotent no-op). Hand-written FRESH here — deliberately NOT
 * importing `checkStateTransition`/`checkReviewEntry`/`checkDoneEntry`/
 * `checkDropEntry`/`assertStartable`/`assertStoppable`/`assertDraftable`/
 * `assertUndraftable` from `src/tickets/state.ts` or `src/sessions/*.ts` —
 * so this validates the CLI's actual behavior against a second, separate
 * transcription of the spec, not the implementation checked against
 * itself.
 *
 * `Op -> (fromState -> toState)`; an absent entry for a given
 * `(op, fromState)` pair means the CLI MUST reject that call with exit 6
 * (CONFLICT) and leave the ticket's state unchanged.
 */
type Op = "draft" | "undraft" | "start" | "stop" | "review" | "done" | "drop";
const OPS: readonly Op[] = ["draft", "undraft", "start", "stop", "review", "done", "drop"];

const ORACLE: Record<Op, Partial<Record<TicketState, TicketState>>> = {
  // draft <-> open (D13); draft on an already-draft ticket is a documented no-op (B2).
  draft: { open: "draft", draft: "draft" },
  undraft: { draft: "open", open: "open" },
  // open -> in_progress (start); review -> in_progress is the D15
  // changes-requested re-entry. in_progress -> in_progress (takeover) is
  // deliberately NOT modeled here — a different feature with its own
  // dedicated coverage (C1.test.ts) — see runPropertyCase's skip below.
  start: { open: "in_progress", review: "in_progress" },
  stop: { in_progress: "open" },
  review: { in_progress: "review" },
  // C3's resolved decision: done is reachable ONLY via review (§2's
  // diagram draws no in_progress -> done edge; design.md §5's house rule
  // "open an MR and call review before claiming done").
  done: { review: "done" },
  // "dropped (wontdo) from anywhere" (§2) — anywhere non-terminal.
  drop: {
    draft: "dropped",
    open: "dropped",
    in_progress: "dropped",
    review: "dropped",
  },
};

const MR_URL = "https://example.com/pr/1";
const DROP_REASON = "property-test drop";

function argsFor(op: Op, slug: string, mrPresent: boolean): string[] {
  switch (op) {
    case "draft":
      return ["draft", slug];
    case "undraft":
      return ["undraft", slug];
    case "start":
      return ["start", slug];
    case "stop":
      return ["stop", slug, "--note", "handoff"];
    case "review":
      return mrPresent ? ["review", slug, "--mr", MR_URL] : ["review", slug];
    case "done":
      return ["done", slug, "--note", "done note"];
    case "drop":
      return ["drop", slug, "--reason", DROP_REASON];
  }
}

interface Step {
  op: Op;
  mrPresent: boolean;
}

async function assertCoherentTicket(paths: RepoPaths, id: TicketId, expectedState: TicketState) {
  const ticket = await readTicket(paths, id);
  expect(ticket.state).toBe(expectedState);
  // review present iff state === "review" (schema-enforced, but this
  // proves the CLI actually leaves the db in that shape, not just that
  // the schema COULD accept it).
  expect(ticket.review !== undefined).toBe(ticket.state === "review");
  // active_session is non-null iff the ticket is in a session-carrying
  // state (in_progress/review); cleared for draft/open/done/dropped.
  const shouldCarrySession = ticket.state === "in_progress" || ticket.state === "review";
  expect(ticket.active_session !== null).toBe(shouldCarrySession);
  return ticket;
}

async function runPropertyCase(
  root: string,
  paths: RepoPaths,
  id: TicketId,
  slug: string,
  startState: TicketState,
  steps: readonly Step[],
): Promise<void> {
  let expectedState: TicketState = startState;
  await assertCoherentTicket(paths, id, expectedState);

  for (const { op, mrPresent } of steps) {
    // `start` on an already-in_progress ticket is the --takeover path, a
    // different feature (its own dedicated legality, not a plain legal
    // /illegal binary) — C1.test.ts covers it directly. Skipping it here
    // keeps this property test's oracle honest rather than conflating
    // two different mechanisms.
    if (op === "start" && expectedState === "in_progress") continue;

    const legalTo = ORACLE[op][expectedState];
    const args = argsFor(op, slug, mrPresent);
    const result = runSlop(args, root);

    if (legalTo !== undefined) {
      expect(
        result.status,
        `${op} from "${expectedState}" (args=${JSON.stringify(args)}): expected success (0), ` +
          `got ${result.status}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
      ).toBe(0);
      if (op === "review") {
        if (mrPresent) {
          expect(result.stderr).not.toMatch(/warning:.*--mr/i);
        } else {
          expect(result.stderr).toMatch(/warning:.*--mr/i);
        }
      }
      expectedState = legalTo;
    } else {
      expect(
        result.status,
        `${op} from "${expectedState}" (args=${JSON.stringify(args)}): expected CONFLICT (6), ` +
          `got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      ).toBe(6);
    }

    await assertCoherentTicket(paths, id, expectedState);
  }
}

describe("C3: Lifecycle", () => {
  describe('"State machine property test: only legal transitions"', () => {
    // I/O-bound (each run spawns the compiled binary several times, real
    // process overhead) — a much lower run count than A2/B3's pure,
    // in-process property tests (300) is the right trade for genuine CLI
    // coverage within a reasonable wall-clock budget; still enough runs
    // to exercise every op from every reachable state many times over
    // via fast-check's own shrinking/distribution.
    const PROPERTY_RUNS = 20;

    const stepArb: fc.Arbitrary<Step> = fc.record({
      op: fc.constantFrom(...OPS),
      mrPresent: fc.boolean(),
    });
    const caseArb = fc.record({
      startDraft: fc.boolean(),
      steps: fc.array(stepArb, { minLength: 1, maxLength: 4 }),
    });

    it("every transition the CLI performs is in the independent oracle's legal set; every illegal " +
      "attempt is rejected with exit 6 and leaves state/review/active_session untouched", async () => {
      await fc.assert(
        fc.asyncProperty(caseArb, async ({ startDraft, steps }) => {
          const { root, paths } = await makeFixtureRepo();
          const extra = startDraft ? ["--draft"] : [];
          const { id, slug } = newTicket(root, "Property ticket", extra);
          const startState: TicketState = startDraft ? "draft" : "open";
          await runPropertyCase(root, paths, id, slug, startState, steps);
        }),
        { numRuns: PROPERTY_RUNS },
      );
    }, 120_000);
  });

  // ---------------------------------------------------------------------------
  // Clause 2: "review without `--mr` nags"
  // ---------------------------------------------------------------------------

  describe('"review without `--mr` nags"', () => {
    it("review <ref> with no --mr: warns on stderr, still transitions to review, review.mr absent", async () => {
      const { root, paths } = await makeFixtureRepo();
      const { id, slug } = newTicket(root, "No MR ticket");
      expect(runSlop(["start", slug], root).status).toBe(0);

      const result = runSlop(["review", slug], root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toMatch(/warning:.*no --mr given/i);

      const ticket = await readTicket(paths, id);
      expect(ticket.state).toBe("review");
      expect(ticket.review).toBeDefined();
      expect(ticket.review?.mr).toBeUndefined();
    });

    it("review <ref> --mr <url>: records the MR, does NOT nag", async () => {
      const { root, paths } = await makeFixtureRepo();
      const { id, slug } = newTicket(root, "With MR ticket");
      expect(runSlop(["start", slug], root).status).toBe(0);

      const result = runSlop(["review", slug, "--mr", MR_URL], root);
      expect(result.status, result.stderr).toBe(0);
      // No --mr nag specifically — a separate, unrelated "could not locate
      // a transcript" warning is legitimate here (no real harness in this
      // test env) and must not be conflated with the D15 nag under test.
      expect(result.stderr).not.toMatch(/no --mr given/i);

      const ticket = await readTicket(paths, id);
      expect(ticket.state).toBe("review");
      expect(ticket.review?.mr).toBe(MR_URL);
    });

    it("review is rejected (exit 6) from states where it's illegal (open, draft, done)", async () => {
      const { root } = await makeFixtureRepo();

      const openTicket = newTicket(root, "Open ticket");
      const openResult = runSlop(["review", openTicket.slug, "--mr", MR_URL], root);
      expect(openResult.status).toBe(6);

      const draftTicket = newTicket(root, "Draft ticket", ["--draft"]);
      const draftResult = runSlop(["review", draftTicket.slug, "--mr", MR_URL], root);
      expect(draftResult.status).toBe(6);

      const doneTicket = newTicket(root, "Done-bound ticket");
      expect(runSlop(["start", doneTicket.slug], root).status).toBe(0);
      expect(runSlop(["review", doneTicket.slug, "--mr", MR_URL], root).status).toBe(0);
      expect(runSlop(["done", doneTicket.slug], root).status).toBe(0);
      const doneResult = runSlop(["review", doneTicket.slug, "--mr", MR_URL], root);
      expect(doneResult.status).toBe(6);
    });
  });

  // ---------------------------------------------------------------------------
  // End-to-end loop: new -> start -> plan -> update --progress -> review
  // --mr -> done, asserting finalize + transcript + cascade.
  // ---------------------------------------------------------------------------

  describe("end-to-end loop", () => {
    it(
      "new -> start -> plan -> update --progress -> review --mr -> done finalizes the session, captures " +
        "(or null-refs) the transcript, and cascades ticket.ready to a dependent",
      async () => {
        const { root, paths } = await makeFixtureRepo();

        const dependent = newTicket(root, "Dependent on worker");
        const worker = newTicket(root, "Worker ticket", ["--blocks", dependent.slug]);

        expect(runSlop(["start", worker.slug], root).status).toBe(0);
        expect(runSlop(["plan", worker.slug, "step one", "step two"], root).status).toBe(0);
        expect(
          runSlop(["update", worker.slug, "--progress", "made good progress"], root).status,
        ).toBe(0);

        const reviewResult = runSlop(["review", worker.slug, "--mr", MR_URL], root);
        expect(reviewResult.status, reviewResult.stderr).toBe(0);

        const ticketBeforeDone = await readTicket(paths, worker.id);
        expect(ticketBeforeDone.state).toBe("review");
        const sessionId = ticketBeforeDone.active_session;
        expect(sessionId).not.toBeNull();

        const doneResult = runSlop(["done", worker.slug, "--note", "shipped and merged"], root);
        expect(doneResult.status, doneResult.stderr).toBe(0);

        const doneTicket = await readTicket(paths, worker.id);
        expect(doneTicket.state).toBe("done");
        expect(doneTicket.active_session).toBeNull();
        expect(doneTicket.review).toBeUndefined();

        // Session finalized: ended_at set, end_summary from --note.
        const session = await readSession(paths, sessionId as NonNullable<typeof sessionId>);
        expect(session.ended_at).not.toBeNull();
        expect(session.end_summary).toBe("shipped and merged");
        // Never blocks — a null ref + warning is a legitimate outcome here
        // (no real harness in this test env), never a failure.
        if (session.transcript_ref === null) {
          expect(doneResult.stderr).toMatch(/could not locate a transcript/i);
        } else {
          expect(session.transcript_ref).toMatch(/^transcripts\//);
        }

        // Cascade: the dependent this ticket was blocking is now ready,
        // with a ticket.ready event crediting the worker's closure.
        const dependentTicket = await readTicket(paths, dependent.id);
        expect(dependentTicket.state).toBe("open");
        const readyEvents = await queryEvents(paths, { ticket: dependent.id });
        const readyEvent = readyEvents.find((e) => e.verb === "ticket.ready");
        expect(readyEvent).toBeDefined();
        expect(readyEvent?.payload.unblocked_by).toBe(worker.id);

        expect(doneResult.stdout).toContain(dependent.id);
      },
    );

    it("done directly from in_progress (skipping review) is rejected, exit 6", async () => {
      const { root } = await makeFixtureRepo();
      const ticket = newTicket(root, "Skip-review ticket");
      expect(runSlop(["start", ticket.slug], root).status).toBe(0);
      const result = runSlop(["done", ticket.slug], root);
      expect(result.status).toBe(6);
      expect(result.stderr).toMatch(/reachable only from "review"/);
    });
  });

  // ---------------------------------------------------------------------------
  // drop
  // ---------------------------------------------------------------------------

  describe("drop", () => {
    it("drop --reason from in_progress finalizes the session and unblocks a dependent (cascade)", async () => {
      const { root, paths } = await makeFixtureRepo();
      const dependent = newTicket(root, "Dependent on dropped in-progress");
      const worker = newTicket(root, "In-progress worker", ["--blocks", dependent.slug]);

      expect(runSlop(["start", worker.slug], root).status).toBe(0);
      const beforeDrop = await readTicket(paths, worker.id);
      const sessionId = beforeDrop.active_session;
      expect(sessionId).not.toBeNull();

      const dropResult = runSlop(["drop", worker.slug, "--reason", "no longer needed"], root);
      expect(dropResult.status, dropResult.stderr).toBe(0);

      const dropped = await readTicket(paths, worker.id);
      expect(dropped.state).toBe("dropped");
      expect(dropped.active_session).toBeNull();

      const session = await readSession(paths, sessionId as NonNullable<typeof sessionId>);
      expect(session.ended_at).not.toBeNull();
      expect(session.end_summary).toBe("no longer needed");

      const dependentTicket = await readTicket(paths, dependent.id);
      expect(dependentTicket.state).toBe("open");
      const events = await queryEvents(paths, { ticket: dependent.id });
      expect(events.some((e) => e.verb === "ticket.ready")).toBe(true);
    });

    it("drop --reason from open (no active session) succeeds without touching any session", async () => {
      const { root, paths } = await makeFixtureRepo();
      const ticket = newTicket(root, "Open ticket to drop");
      const result = runSlop(["drop", ticket.slug, "--reason", "duplicate"], root);
      expect(result.status, result.stderr).toBe(0);
      const dropped = await readTicket(paths, ticket.id);
      expect(dropped.state).toBe("dropped");
      expect(dropped.active_session).toBeNull();
    });

    it("drop without --reason errors (usage error)", async () => {
      const { root } = await makeFixtureRepo();
      const ticket = newTicket(root, "No reason ticket");
      const result = runSlop(["drop", ticket.slug], root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/--reason/);
    });

    it('drop --reason "" (present but empty) is rejected as a usage error', async () => {
      const { root } = await makeFixtureRepo();
      const ticket = newTicket(root, "Empty reason ticket");
      const result = runSlop(["drop", ticket.slug, "--reason", "   "], root);
      expect(result.status).toBe(2);
    });

    it("drop is rejected (exit 6) from an already-terminal ticket", async () => {
      const { root } = await makeFixtureRepo();
      const ticket = newTicket(root, "Already dropped ticket");
      expect(runSlop(["drop", ticket.slug, "--reason", "first drop"], root).status).toBe(0);
      const second = runSlop(["drop", ticket.slug, "--reason", "second drop"], root);
      expect(second.status).toBe(6);
    });
  });

  // ---------------------------------------------------------------------------
  // Re-start from review (D15 changes-requested re-entry)
  // ---------------------------------------------------------------------------

  describe("re-start from review (D15 changes-requested re-entry)", () => {
    it("review -> in_progress clears review, starts a fresh session, and logs the re-entry in the audit trail", async () => {
      const { root, paths } = await makeFixtureRepo();
      const ticket = newTicket(root, "Changes requested ticket");

      expect(runSlop(["start", ticket.slug], root).status).toBe(0);
      const inProgress = await readTicket(paths, ticket.id);
      const firstSessionId = inProgress.active_session;
      expect(firstSessionId).not.toBeNull();

      expect(runSlop(["review", ticket.slug, "--mr", MR_URL], root).status).toBe(0);
      const inReview = await readTicket(paths, ticket.id);
      expect(inReview.state).toBe("review");
      expect(inReview.active_session).toBe(firstSessionId);

      // No --takeover needed: a plain `start` is enough for this edge.
      const restart = runSlop(["start", ticket.slug], root);
      expect(restart.status, restart.stderr).toBe(0);

      const reentered = await readTicket(paths, ticket.id);
      expect(reentered.state).toBe("in_progress");
      expect(reentered.review).toBeUndefined();
      expect(reentered.active_session).not.toBeNull();
      expect(reentered.active_session).not.toBe(firstSessionId);
      const secondSessionId = reentered.active_session;

      // Audit trail shows the re-entry, on both entities it touched.
      const ticketEvents = await queryEvents(paths, { ticket: ticket.id });
      const stateChanged = ticketEvents.filter(
        (e) => e.verb === "ticket.state_changed" && e.payload.to === "in_progress",
      );
      const reentryTicketEvent = stateChanged.find((e) => e.payload.from === "review");
      expect(reentryTicketEvent).toBeDefined();
      expect(reentryTicketEvent?.payload.re_entry).toBe(true);

      const firstSession = await readSession(
        paths,
        firstSessionId as NonNullable<typeof firstSessionId>,
      );
      expect(firstSession.ended_at).not.toBeNull();

      const secondSession = await readSession(
        paths,
        secondSessionId as NonNullable<typeof secondSessionId>,
      );
      expect(secondSession.ended_at).toBeNull();

      // No --takeover flag was needed AND no takeover conflict was raised.
      expect(restart.stderr).not.toMatch(/already has an active session/i);
      expect(restart.stdout).toMatch(/re-entered from review/i);
    });

    it("done still works after a changes-requested re-entry loop back through review", async () => {
      const { root, paths } = await makeFixtureRepo();
      const ticket = newTicket(root, "Full re-entry loop ticket");

      expect(runSlop(["start", ticket.slug], root).status).toBe(0);
      expect(runSlop(["review", ticket.slug, "--mr", MR_URL], root).status).toBe(0);
      expect(runSlop(["start", ticket.slug], root).status).toBe(0); // changes requested
      expect(runSlop(["review", ticket.slug, "--mr", `${MR_URL}-v2`], root).status).toBe(0);
      const done = runSlop(["done", ticket.slug], root);
      expect(done.status, done.stderr).toBe(0);

      const finalTicket = await readTicket(paths, ticket.id);
      expect(finalTicket.state).toBe("done");
      expect(finalTicket.review).toBeUndefined();
      expect(finalTicket.active_session).toBeNull();
    });
  });
});
