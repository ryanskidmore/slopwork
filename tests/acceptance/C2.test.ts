import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SessionId, Ticket } from "../../src/core/index.js";
import { newTicketId, ticketSchema } from "../../src/core/index.js";
import type { EventContext, MutationEventSpec, RepoPaths } from "../../src/repo/index.js";
import {
  createTicket,
  ensureDbDirs,
  listEvents,
  listSessions,
  readSession,
  readTicket,
} from "../../src/repo/index.js";
import { diffPlanVersions, summarizePlanDiff } from "../../src/sessions/plan-diff.js";

// C2: Plans
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "Plan v2 diffable from v1; step status in `show`"

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
  // Same "build if missing" convention as A1.test.ts/C1.test.ts.
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
// Fixtures — repo layer directly for ticket setup (fast, exact control),
// the REAL compiled `dist/slop` binary for every `start`/`plan`/`show`
// invocation under test (D5's "vitest workers are Node, not Bun" —
// anything exercising the actual command surface goes through a spawned
// process, same convention C1.test.ts uses).
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

async function makeRepo(): Promise<{ dir: string; paths: RepoPaths }> {
  const dir = await mkdtemp(join(tmpdir(), "slop-c2-"));
  scratchDirs.push(dir);
  const paths = await ensureDbDirs(dir);
  await writeFile(join(dir, ".slop", "config.yaml"), "project: c2-test\n", "utf8");
  return { dir, paths };
}

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const d = scratchDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

const ctx: EventContext = { actor: { name: "fixture", kind: "human" }, session: null };
const ticketCreated: MutationEventSpec = { verb: "ticket.created" };

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "Fixture ticket",
    slug: `ticket-${id.slice(-10).toLowerCase()}`,
    spec: { summary: "s" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "fixture", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

const HARNESS_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "OPENCODE",
  "OPENCODE_PID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
] as const;

function slopEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, SLOP_ACTOR: "c2-test-actor" };
  for (const key of HARNESS_ENV_KEYS) env[key] = undefined;
  for (const [k, v] of Object.entries(overrides)) env[k] = v;
  return env;
}

function runSlop(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string | undefined> = {},
) {
  return spawnSync(binaryPath, args, { cwd, encoding: "utf8", env: slopEnv(envOverrides) });
}

describe("C2: Plans", () => {
  // -------------------------------------------------------------------------
  // Clause 1: "Plan v2 diffable from v1"
  // -------------------------------------------------------------------------

  describe('"Plan v2 diffable from v1"', () => {
    it("a revision appends a new version, leaves v1 untouched, and the exact delta is reportable", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket({ name: "Diffable plan ticket" });
      await createTicket(paths, ticket, ctx, ticketCreated);

      const start = runSlop(["start", ticket.slug], dir);
      expect(start.status, start.stderr).toBe(0);

      const v1 = runSlop(["plan", ticket.slug, "step one", "step two"], dir);
      expect(v1.status, v1.stderr).toBe(0);
      expect(v1.stdout).toContain("plan v1 set");

      const v2 = runSlop(["plan", ticket.slug, "step one", "step two", "step three"], dir);
      expect(v2.status, v2.stderr).toBe(0);
      expect(v2.stdout).toContain("plan v2 revised");
      // The CLI's own revision output already shows the diff, unprompted.
      expect(v2.stdout).toContain("diff v1 -> v2");
      expect(v2.stdout).toContain("+ step three");

      const afterTicket = await readTicket(paths, ticket.id);
      const sessionId = afterTicket.active_session as SessionId;
      const session = await readSession(paths, sessionId);

      // Both versions persist on the session -- a genuine append, not a
      // mutate-in-place.
      expect(session.plan).toHaveLength(2);
      expect(session.plan[0]?.version).toBe(1);
      expect(session.plan[0]?.steps.map((s) => s.text)).toEqual(["step one", "step two"]);
      expect(session.plan[1]?.version).toBe(2);
      expect(session.plan[1]?.steps.map((s) => s.text)).toEqual([
        "step one",
        "step two",
        "step three",
      ]);

      // The pure diff function reports the exact delta between the two
      // persisted versions.
      const v1Version = session.plan[0];
      const v2Version = session.plan[1];
      if (!v1Version || !v2Version) throw new Error("unreachable");
      const diff = diffPlanVersions(v1Version, v2Version);
      expect(diff.fromVersion).toBe(1);
      expect(diff.toVersion).toBe(2);
      expect(diff.entries).toContainEqual({ kind: "added", text: "step three", afterIndex: 2 });
      expect(diff.entries.filter((e) => e.kind === "kept")).toHaveLength(2);
      expect(summarizePlanDiff(diff)).toBe("+1 added");

      // And the version history is observable through the CLI, not just
      // the underlying data -- `show --context` renders both the latest
      // checklist and a v1 -> v2 history line.
      const shown = runSlop(["show", ticket.slug, "--context"], dir);
      expect(shown.status, shown.stderr).toBe(0);
      expect(shown.stdout).toContain("v2 of 2");
      expect(shown.stdout).toContain("v1 -> v2");
      expect(shown.stdout).toContain("added");

      // `slop context` (C1's mid-session reprint) renders the same thing.
      const contextOut = runSlop(["context", ticket.slug], dir);
      expect(contextOut.status, contextOut.stderr).toBe(0);
      expect(contextOut.stdout).toContain("v2 of 2");
      expect(contextOut.stdout).toContain("v1 -> v2");
    });

    it("does not mutate v1's steps when v2 changes an unrelated step's checked state", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket({ name: "Untouched v1 ticket" });
      await createTicket(paths, ticket, ctx, ticketCreated);
      runSlop(["start", ticket.slug], dir);
      runSlop(["plan", ticket.slug, "step one", "step two"], dir);
      runSlop(["plan", ticket.slug, "--check", "1"], dir);
      runSlop(["plan", ticket.slug, "step one", "step two", "step three"], dir);

      const afterTicket = await readTicket(paths, ticket.id);
      const session = await readSession(paths, afterTicket.active_session as SessionId);
      expect(session.plan).toHaveLength(2);
      // v1 still shows step one unchecked -- checking happened on v1 while
      // it was current, but v1 itself, as a historical record, is
      // immutable once superseded... except the check happened BEFORE the
      // revision, so v1's OWN steps show it checked; what must never
      // happen is v2's creation retroactively rewriting v1.
      expect(session.plan[0]?.steps[0]?.checked).toBe(true);
      expect(session.plan[1]?.steps[0]?.checked).toBe(true); // carried forward
    });
  });

  // -------------------------------------------------------------------------
  // Clause 2: "step status in `show`"
  // -------------------------------------------------------------------------

  describe('"step status in show"', () => {
    it("checked and unchecked steps both render correctly in `slop show --context`", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket({ name: "Show status ticket" });
      await createTicket(paths, ticket, ctx, ticketCreated);
      runSlop(["start", ticket.slug], dir);
      runSlop(["plan", ticket.slug, "alpha", "beta", "gamma"], dir);
      runSlop(["plan", ticket.slug, "--check", "1"], dir);
      runSlop(["plan", ticket.slug, "--check", "3"], dir);

      const shown = runSlop(["show", ticket.slug, "--context"], dir);
      expect(shown.status, shown.stderr).toBe(0);
      expect(shown.stdout).toContain("[x] alpha");
      expect(shown.stdout).toContain("[ ] beta");
      expect(shown.stdout).toContain("[x] gamma");
      expect(shown.stdout).toContain("2/3 checked");

      const afterTicket = await readTicket(paths, ticket.id);
      const session = await readSession(paths, afterTicket.active_session as SessionId);
      expect(session.plan.at(-1)?.steps.map((s) => s.checked)).toEqual([true, false, true]);
    });
  });

  // -------------------------------------------------------------------------
  // `--check`/`--uncheck`: 1-based, toggle correctly, out-of-range -> exit 2,
  // never spawn a new version.
  // -------------------------------------------------------------------------

  describe("--check/--uncheck", () => {
    it("is 1-based: --check 1 checks the FIRST listed step", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      runSlop(["start", ticket.slug], dir);
      runSlop(["plan", ticket.slug, "first", "second"], dir);

      const checked = runSlop(["plan", ticket.slug, "--check", "1"], dir);
      expect(checked.status, checked.stderr).toBe(0);

      const afterTicket = await readTicket(paths, ticket.id);
      const session = await readSession(paths, afterTicket.active_session as SessionId);
      expect(session.plan.at(-1)?.steps[0]).toEqual({ text: "first", checked: true });
      expect(session.plan.at(-1)?.steps[1]).toEqual({ text: "second", checked: false });
    });

    it("--uncheck flips a checked step back off", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      runSlop(["start", ticket.slug], dir);
      runSlop(["plan", ticket.slug, "only step"], dir);
      runSlop(["plan", ticket.slug, "--check", "1"], dir);
      const unchecked = runSlop(["plan", ticket.slug, "--uncheck", "1"], dir);
      expect(unchecked.status, unchecked.stderr).toBe(0);

      const afterTicket = await readTicket(paths, ticket.id);
      const session = await readSession(paths, afterTicket.active_session as SessionId);
      expect(session.plan.at(-1)?.steps[0]?.checked).toBe(false);
    });

    it("rejects step 0 and out-of-range N with exit USAGE_ERROR (2)", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      runSlop(["start", ticket.slug], dir);
      runSlop(["plan", ticket.slug, "only step"], dir);

      const zero = runSlop(["plan", ticket.slug, "--check", "0"], dir);
      expect(zero.status).toBe(2);
      expect(zero.stderr).toMatch(/out of range/i);

      const tooBig = runSlop(["plan", ticket.slug, "--check", "99"], dir);
      expect(tooBig.status).toBe(2);
      expect(tooBig.stderr).toMatch(/out of range/i);
    });

    it("--check/--uncheck never create a new plan version", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      runSlop(["start", ticket.slug], dir);
      runSlop(["plan", ticket.slug, "a", "b"], dir);
      runSlop(["plan", ticket.slug, "--check", "1"], dir);
      runSlop(["plan", ticket.slug, "--uncheck", "1"], dir);
      runSlop(["plan", ticket.slug, "--check", "2"], dir);

      const afterTicket = await readTicket(paths, ticket.id);
      const session = await readSession(paths, afterTicket.active_session as SessionId);
      expect(session.plan).toHaveLength(1);
      expect(session.plan[0]?.version).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Revising preserves check-state per the documented rule.
  // -------------------------------------------------------------------------

  describe("check-state carry-forward across a revision", () => {
    it("identical step text carries its checked state forward; new/changed text starts unchecked", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      runSlop(["start", ticket.slug], dir);
      runSlop(["plan", ticket.slug, "keep me", "reword me"], dir);
      runSlop(["plan", ticket.slug, "--check", "1"], dir);
      runSlop(["plan", ticket.slug, "--check", "2"], dir);

      const revised = runSlop(
        ["plan", ticket.slug, "keep me", "reword me (v2)", "brand new step"],
        dir,
      );
      expect(revised.status, revised.stderr).toBe(0);

      const afterTicket = await readTicket(paths, ticket.id);
      const session = await readSession(paths, afterTicket.active_session as SessionId);
      const latest = session.plan.at(-1);
      expect(latest?.steps).toEqual([
        { text: "keep me", checked: true }, // identical text -> carried forward
        { text: "reword me (v2)", checked: false }, // different text -> starts unchecked
        { text: "brand new step", checked: false },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // `plan` with no active session.
  // -------------------------------------------------------------------------

  describe("plan with no active session", () => {
    it("errors clearly (exit CONFLICT, 6) and creates nothing", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);

      const result = runSlop(["plan", ticket.slug, "step one"], dir);
      expect(result.status).toBe(6);
      expect(result.stderr).toMatch(/no active session/i);
      expect(result.stderr).toMatch(/slop start/i);

      const sessions = await listSessions(paths);
      expect(sessions).toHaveLength(0);
    });

    it("also refuses --check when there is no active session", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      const result = runSlop(["plan", ticket.slug, "--check", "1"], dir);
      expect(result.status).toBe(6);
    });
  });

  // -------------------------------------------------------------------------
  // Usage errors: conflicting/missing arguments.
  // -------------------------------------------------------------------------

  describe("usage errors", () => {
    it("rejects --check and --uncheck together", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      runSlop(["start", ticket.slug], dir);
      runSlop(["plan", ticket.slug, "a"], dir);
      const result = runSlop(["plan", ticket.slug, "--check", "1", "--uncheck", "1"], dir);
      expect(result.status).toBe(2);
    });

    it("rejects steps combined with --check", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      runSlop(["start", ticket.slug], dir);
      const result = runSlop(["plan", ticket.slug, "a step", "--check", "1"], dir);
      expect(result.status).toBe(2);
    });

    it("rejects an empty invocation (no steps, no --check/--uncheck)", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      runSlop(["start", ticket.slug], dir);
      const result = runSlop(["plan", ticket.slug], dir);
      expect(result.status).toBe(2);
    });

    it("a blank/whitespace-only step is a clean USAGE_ERROR(2), never a raw ZodError JSON dump (regression: raw-zoderrors-escape-as-exit)", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      runSlop(["start", ticket.slug], dir);

      const blank = runSlop(["plan", ticket.slug, ""], dir);
      expect(blank.status).toBe(2);
      expect(blank.stderr).not.toContain("ZodError");
      expect(blank.stderr).not.toMatch(/^\s*error:\s*\[/); // not a raw JSON issues array
      expect(blank.stderr).toContain("step 1");

      const whitespace = runSlop(["plan", ticket.slug, "good step", "   "], dir);
      expect(whitespace.status).toBe(2);
      expect(whitespace.stderr).not.toContain("ZodError");
      expect(whitespace.stderr).toContain("step 2");

      // Nothing was persisted for either rejected call.
      const sessions = await listSessions(paths);
      expect(sessions[0]?.plan ?? []).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Event verbs: exactly the right one per mutation.
  // -------------------------------------------------------------------------

  describe("event verbs", () => {
    it("emits plan.set on the first call, plan.revised on later calls, plan.step_checked on toggles", async () => {
      const { dir, paths } = await makeRepo();
      const ticket = makeTicket();
      await createTicket(paths, ticket, ctx, ticketCreated);
      runSlop(["start", ticket.slug], dir);

      const setResult = runSlop(["plan", ticket.slug, "a", "b"], dir);
      expect(setResult.status, setResult.stderr).toBe(0);
      const revisedResult = runSlop(["plan", ticket.slug, "a", "b", "c"], dir);
      expect(revisedResult.status, revisedResult.stderr).toBe(0);
      const checkResult = runSlop(["plan", ticket.slug, "--check", "1"], dir);
      expect(checkResult.status, checkResult.stderr).toBe(0);
      const uncheckResult = runSlop(["plan", ticket.slug, "--uncheck", "1"], dir);
      expect(uncheckResult.status, uncheckResult.stderr).toBe(0);

      const events = await listEvents(paths);
      const planEvents = events.filter((e) => e.verb.startsWith("plan."));
      expect(planEvents.map((e) => e.verb)).toEqual([
        "plan.set",
        "plan.revised",
        "plan.step_checked",
        "plan.step_checked",
      ]);

      // Every plan event is scoped to the session it mutated, and carries
      // the actor that ran the command.
      const afterTicket = await readTicket(paths, ticket.id);
      const sessionId = afterTicket.active_session as SessionId;
      for (const e of planEvents) {
        expect(e.session).toBe(sessionId);
        expect(e.entity).toEqual({ kind: "session", id: sessionId });
        expect(e.actor.name).toBe("c2-test-actor");
      }

      const checkPayloads = planEvents
        .filter((e) => e.verb === "plan.step_checked")
        .map((e) => e.payload);
      expect(checkPayloads).toEqual([
        { step: 1, checked: true },
        { step: 1, checked: false },
      ]);
    });
  });
});
