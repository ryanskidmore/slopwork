import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import type { SessionId, TicketId } from "../../core/index.js";
import {
  listEvents,
  readSession,
  readTicket,
  repoPaths,
  sessionFilePath,
} from "../../repo/index.js";
import { runDrop } from "./drop.js";
import { runNew } from "./new.js";
import { runReview } from "./review.js";
import { runStart } from "./start.js";
import { runStop } from "./stop.js";

// ticket_01KY93E3WYD13E71QM7GHWG1DE (Fix 2) — `start`'s takeover/conflict
// gate used to read the ticket's recorded active session via
// `readSession(...).catch(() => null)` (start.ts:139 pre-fix): a `null`
// from an UNREADABLE (corrupt/missing) session file was indistinguishable
// from "no active session at all", so `start` proceeded exactly as if
// nothing were active — no `--takeover` required, no warning, no
// `session.takeover` event — silently overwriting `active_session` and
// abandoning the prior session with no audit trail. This suite exercises
// the fixed behaviour as three REAL processes spawned from SOURCE (`bun
// src/cli/index.ts ...`, mirroring stop.test.ts's spawn style), since the
// bug is specifically about the CLI-level conflict gate, not anything
// unit-testable in isolation.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

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
  "CODEX_HOME",
] as const;

function slopEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, SLOP_ACTOR: "start-test" };
  for (const key of HARNESS_ENV_KEYS) env[key] = undefined;
  for (const [k, v] of Object.entries(overrides)) env[k] = v;
  return env;
}

function runSlop(args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync("bun", [cliEntry, ...args], { cwd, encoding: "utf8", env: slopEnv() });
}

function mustRunSlop(args: string[], cwd: string): SpawnSyncReturns<string> {
  const r = runSlop(args, cwd);
  if (r.status !== 0) {
    throw new Error(`slop ${args.join(" ")} failed (exit ${r.status}):\n${r.stderr}`);
  }
  return r;
}

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeFixtureRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "slop-start-takeover-test-"));
  scratchDirs.push(root);
  const init = mustRunSlop(
    ["init", "--yes", "--project", "start-takeover-fixture", "--user", "ryan"],
    root,
  );
  expect(init.status, init.stderr).toBe(0);
  return root;
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;
const STARTED_LINE = /^started (session_[0-9A-Z]+) on/m;

function newTicket(root: string, name: string): { id: TicketId; slug: string } {
  const result = mustRunSlop(["new", name], root);
  const m = CREATED_LINE.exec(result.stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(`could not parse "created <id> (slug: <slug>)" out of:\n${result.stdout}`);
  }
  return { id: m[1] as TicketId, slug: m[2] };
}

function startedSessionId(result: SpawnSyncReturns<string>): SessionId {
  const m = STARTED_LINE.exec(result.stdout);
  if (!m?.[1]) {
    throw new Error(`could not parse "started <session_id> on ..." out of:\n${result.stdout}`);
  }
  return m[1] as SessionId;
}

describe("start — Fix 2 (ticket_01KY93E3WYD13E71QM7GHWG1DE): fails CLOSED on an unreadable recorded active session", () => {
  it("a normal null active_session still starts cleanly (regression guard)", async () => {
    const root = await makeFixtureRepo();
    const ticket = newTicket(root, "Plain start, nothing active");

    const started = runSlop(["start", ticket.slug], root);
    expect(started.status, started.stderr).toBe(0);
    // Ordinary degrade-gracefully warnings (no git repo in the scratch
    // dir, harness not detectable under a stripped env) are expected and
    // fine — the load-bearing assertion is that nothing conflict-shaped
    // was ever printed for a ticket with no active session at all.
    expect(started.stderr).not.toMatch(/could not be read/i);
    expect(started.stderr).not.toMatch(/--takeover/);

    const paths = repoPaths(root);
    const finalTicket = await readTicket(paths, ticket.id);
    expect(finalTicket.state).toBe("in_progress");
    expect(finalTicket.active_session).not.toBeNull();
  });

  it("refuses (CONFLICT, exit 6) without --takeover when the recorded active session's file is CORRUPT — does not silently proceed", async () => {
    const root = await makeFixtureRepo();
    const ticket = newTicket(root, "Corrupt active session, no takeover");
    const paths = repoPaths(root);

    const firstStart = mustRunSlop(["start", ticket.slug], root);
    const firstSessionId = startedSessionId(firstStart);

    // Corrupt the recorded active session's file in place — hand-edited,
    // never via git — so `current.active_session` still points at it, but
    // reading it now fails.
    await writeFile(sessionFilePath(paths, firstSessionId), "{ this is not valid jsonc", "utf8");

    const retry = runSlop(["start", ticket.slug], root);
    expect(retry.status).toBe(6); // EXIT_CODES.CONFLICT
    expect(retry.stderr).toMatch(/could not be read/i);
    expect(retry.stderr).toMatch(/--takeover/);
    expect(retry.stderr).not.toMatch(/session\.takeover/i); // no takeover was logged — nothing proceeded

    // The ticket must be untouched: still pointing at the original
    // (broken) session, still in_progress from the first start only.
    const ticketAfterRefusal = await readTicket(paths, ticket.id);
    expect(ticketAfterRefusal.active_session).toBe(firstSessionId);
  });

  it("refuses (CONFLICT, exit 6) without --takeover when the recorded active session's file is MISSING entirely", async () => {
    const root = await makeFixtureRepo();
    const ticket = newTicket(root, "Missing active session, no takeover");
    const paths = repoPaths(root);

    const firstStart = mustRunSlop(["start", ticket.slug], root);
    const firstSessionId = startedSessionId(firstStart);
    await rm(sessionFilePath(paths, firstSessionId));

    const retry = runSlop(["start", ticket.slug], root);
    expect(retry.status).toBe(6);
    expect(retry.stderr).toMatch(/could not be read/i);
    expect(retry.stderr).toMatch(/--takeover/);
  });

  it("--takeover proceeds past an unreadable recorded active session, printing a warning that NAMES the broken file, and still logs the takeover on the new session", async () => {
    const root = await makeFixtureRepo();
    const ticket = newTicket(root, "Corrupt active session, with takeover");
    const paths = repoPaths(root);

    const firstStart = mustRunSlop(["start", ticket.slug], root);
    const firstSessionId = startedSessionId(firstStart);
    const brokenFile = sessionFilePath(paths, firstSessionId);
    await writeFile(brokenFile, "{ still not valid jsonc", "utf8");

    const takeover = runSlop(["start", ticket.slug, "--takeover"], root);
    expect(takeover.status, takeover.stderr).toBe(0);

    // The warning must name the exact broken file, not just the session id.
    expect(takeover.stderr).toMatch(/warning:/);
    expect(takeover.stderr).toContain(brokenFile);
    expect(takeover.stderr).toMatch(/could not be read/i);

    const newSessionId = startedSessionId(takeover);
    expect(newSessionId).not.toBe(firstSessionId);

    // The ticket now points at the NEW session, not the broken one — the
    // takeover mechanically succeeded.
    const finalTicket = await readTicket(paths, ticket.id);
    expect(finalTicket.active_session).toBe(newSessionId);
    expect(finalTicket.state).toBe("in_progress");

    // Audit trail: "every takeover is logged" — the new session's own
    // session.started event must record this as a takeover, naming the
    // broken session it superseded, even though that broken session's own
    // file could never be patched with a matching session.takeover event.
    const events = await listEvents(paths);
    const startedEvent = events.find(
      (e) => e.verb === "session.started" && e.session === newSessionId,
    );
    expect(startedEvent, "expected a session.started event for the new session").toBeDefined();
    expect(startedEvent?.payload.takeover).toBe(true);
    expect(startedEvent?.payload.unreadable_previous_session).toBe(firstSessionId);

    // The broken file itself was left alone: the only event ever
    // recorded against it is its ORIGINAL session.started (from the
    // first `start`, before corruption) — no session.takeover/
    // session.ended was ever appended for it by the --takeover run
    // above, proving that run never attempted to patch the broken file.
    const eventsOnBrokenSession = events.filter((e) => e.entity.id === firstSessionId);
    expect(eventsOnBrokenSession.map((e) => e.verb)).toEqual(["session.started"]);
  });
});

// ---------------------------------------------------------------------------
// In-process coverage of `runStart` (real v8 coverage, no subprocess).
// ---------------------------------------------------------------------------

async function jsonNewTicket(root: string, name: string): Promise<TicketId> {
  const out = captureOutput();
  try {
    await withCwd(root, () =>
      runNew(name, {
        blocks: [],
        relatesTo: [],
        label: [],
        acceptance: [],
        context: [],
        json: true,
      }),
    );
    return (JSON.parse(out.stdout()) as { id: TicketId }).id;
  } finally {
    out.restore();
  }
}

describe("runStart (in-process)", () => {
  it("starts a fresh ticket: moves it to in_progress, creates a session, prints the context pack", async () => {
    const root = await makeTempRepo("slop-start-inproc-fresh-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Fresh start ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
      expect(out.stdout()).toMatch(/^started session_[0-9A-Z]+ on/m);
      expect(out.stdout()).toContain("actor: ryan");
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    const ticket = await readTicket(paths, id);
    expect(ticket.state).toBe("in_progress");
    expect(ticket.active_session).not.toBeNull();
  });

  it("--json prints the machine-readable session/ticket/git summary, omitting the context pack", async () => {
    const root = await makeTempRepo("slop-start-inproc-json-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Json start ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runStart(id, { json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      session: { id: string; actor: string };
      ticket: { id: string; state: string };
      takeover: boolean;
    };
    expect(body.ticket.id).toBe(id);
    expect(body.ticket.state).toBe("in_progress");
    expect(body.takeover).toBe(false);
  });

  it("--as overrides the resolved actor identity for this session", async () => {
    const root = await makeTempRepo("slop-start-inproc-as-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "As-override ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runStart(id, { as: "someone-else" }));
      expect(out.stdout()).toContain("actor: someone-else");
    } finally {
      out.restore();
    }
  });

  it("--harness overrides auto-detection", async () => {
    const root = await makeTempRepo("slop-start-inproc-harness-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Harness override ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runStart(id, { harness: "codex" }));
      expect(out.stdout()).toContain("harness: codex");
    } finally {
      out.restore();
    }
  });

  it("refuses a second start without --takeover while a session is genuinely still active (CONFLICT, exit 6)", async () => {
    const root = await makeTempRepo("slop-start-inproc-conflict-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Conflict start ticket");
    const first = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      first.restore();
    }

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runStart(id, {}))).rejects.toMatchObject({
        exitCode: EXIT_CODES.CONFLICT,
      });
    } finally {
      out.restore();
    }
  });

  it("--takeover proceeds past an active session, ending it as superseded (session.takeover)", async () => {
    const root = await makeTempRepo("slop-start-inproc-takeover-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Takeover ticket");
    const first = captureOutput();
    try {
      await withCwd(root, () => runStart(id, { as: "first-actor" }));
    } finally {
      first.restore();
    }
    const paths = repoPaths(root);
    const afterFirst = await readTicket(paths, id);
    const firstSessionId = afterFirst.active_session as SessionId;

    const out = captureOutput();
    try {
      await withCwd(root, () => runStart(id, { as: "second-actor", takeover: true }));
      expect(out.stdout()).toContain("took over from");
    } finally {
      out.restore();
    }
    const previous = await readSession(paths, firstSessionId);
    expect(previous.ended_at).not.toBeNull();
    const afterTakeover = await readTicket(paths, id);
    expect(afterTakeover.active_session).not.toBe(firstSessionId);
  });

  it("re-entering a review-state ticket via start closes the review session as a re-entry, not a takeover", async () => {
    const root = await makeTempRepo("slop-start-inproc-reentry-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Review re-entry ticket");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }
    const reviewOut = captureOutput();
    try {
      await withCwd(root, () => runReview(id, {}));
    } finally {
      reviewOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
      expect(out.stdout()).toContain("re-entered from review");
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).state).toBe("in_progress");
  });

  it("refuses to start a dropped (terminal) ticket", async () => {
    const root = await makeTempRepo("slop-start-inproc-terminal-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Terminal ticket");
    const dropOut = captureOutput();
    try {
      await withCwd(root, () => runDrop(id, { reason: "wontdo" }));
    } finally {
      dropOut.restore();
    }

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runStart(id, {}))).rejects.toThrow();
    } finally {
      out.restore();
    }
  });

  it("throws NOT_FOUND for an unresolvable ref", async () => {
    const root = await makeTempRepo("slop-start-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runStart("no-such-ticket", {}))).rejects.toMatchObject({
        exitCode: EXIT_CODES.NOT_FOUND,
      });
    } finally {
      out.restore();
    }
  });

  it("starting an in_progress-turned-open ticket after `stop` works fine (no conflict)", async () => {
    const root = await makeTempRepo("slop-start-inproc-restart-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Restarted ticket");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }
    const stopOut = captureOutput();
    try {
      await withCwd(root, () => runStop(id, { note: "pausing" }));
    } finally {
      stopOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
      expect(out.stdout()).not.toContain("took over");
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).state).toBe("in_progress");
  });
});
