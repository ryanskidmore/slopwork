import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import type { TicketId } from "../../core/index.js";
import { listSessions, queryEvents, readTicket, repoPaths } from "../../repo/index.js";
import { runNew } from "./new.js";
import { runUpdate } from "./update.js";

// Regression test for ticket_01KY93E2BKH5JCMAV3JWPNN63G: `update` (and
// `draft`/`undraft`, see draft.test.ts/undraft.test.ts) used to read the
// ticket OUTSIDE any lock and compute its write from that stale snapshot.
// Racing a concurrent `start`/`done` (which DO lock + re-read), the
// mismatch between `update`'s stale `expectedAfter` and the fresh on-disk
// text tripped `writeUpdate`'s `writeCanonical(expectedAfter)` fallback
// (src/core/jsonc.ts) — silently reverting the concurrent committed
// transition. The fix wraps `runUpdate`'s read-modify-write in
// `withLock(paths.lockFile, ...)` and re-reads the ticket by id INSIDE the
// lock, exactly like start.ts/stop.ts/done.ts already do.
//
// These tests spawn TWO REAL `bun src/cli/index.ts ...` processes (source,
// not `dist/slop` — no build step is triggered) racing the SAME ticket, and
// assert the final on-disk state reflects BOTH commands' intended effects
// regardless of which one's lock acquisition wins first. That "both effects
// survive, order-independent" property only holds once both commands
// re-read fresh state under a shared lock — before the fix, whichever
// process's write lands second (almost always, since without a lock both
// processes' initial reads race each other with no synchronization at all)
// clobbers the other's already-committed change.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const d = scratchDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

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
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of HARNESS_ENV_KEYS) env[key] = undefined;
  for (const [k, v] of Object.entries(overrides)) env[k] = v;
  return env;
}

function runSlopSource(args: string[], cwd: string, actor: string) {
  return spawnSync("bun", [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    env: slopEnv({ SLOP_ACTOR: actor }),
  });
}

function mustRunSlopSource(args: string[], cwd: string, actor: string) {
  const r = runSlopSource(args, cwd, actor);
  if (r.status !== 0) {
    throw new Error(`slop ${args.join(" ")} failed (exit ${r.status}):\n${r.stderr}`);
  }
  return r;
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  finishedAt: number;
}

function collect(proc: ChildProcess): Promise<SpawnResult> {
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  return new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code) => {
      resolve({ code, stdout, stderr, startedAt, finishedAt: Date.now() });
    });
  });
}

function hasGenuineOverlap(results: readonly SpawnResult[]): boolean {
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i];
      const b = results[j];
      if (!a || !b) continue;
      if (Math.max(a.startedAt, b.startedAt) < Math.min(a.finishedAt, b.finishedAt)) return true;
    }
  }
  return false;
}

async function makeCliRepo(): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "slop-update-race-"));
  scratchDirs.push(dir);
  const init = mustRunSlopSource(
    ["init", "--yes", "--project", "update-race-fixture", "--user", "ryan"],
    dir,
    "ryan",
  );
  expect(init.status, init.stderr).toBe(0);
  return { dir };
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

function newTicketCli(dir: string, actor: string, name: string): { id: TicketId; slug: string } {
  const result = mustRunSlopSource(["new", name], dir, actor);
  const m = CREATED_LINE.exec(result.stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(`could not parse "created <id> (slug: <slug>)" out of:\n${result.stdout}`);
  }
  return { id: m[1] as TicketId, slug: m[2] };
}

describe("update: race against a concurrent lock-holding mutator (regression, ticket_01KY93E2BKH5JCMAV3JWPNN63G)", () => {
  it("`update --priority 0` racing `start`, on a real repo: the started session is never orphaned and the priority change is never lost, regardless of which process's lock wins", async () => {
    const { dir } = await makeCliRepo();
    const ticket = newTicketCli(dir, "ryan", "Update vs start race");

    const procA = spawn("bun", [cliEntry, "update", ticket.slug, "--priority", "0"], {
      cwd: dir,
      env: slopEnv({ SLOP_ACTOR: "updater" }),
    });
    const procB = spawn("bun", [cliEntry, "start", ticket.slug], {
      cwd: dir,
      env: slopEnv({ SLOP_ACTOR: "starter" }),
    });
    const [resA, resB] = await Promise.all([collect(procA), collect(procB)]);

    expect(
      hasGenuineOverlap([resA, resB]),
      "update and start never overlapped in wall-clock time — this run could pass vacuously off accidental serialisation",
    ).toBe(true);

    expect(resA.code, `update stderr: ${resA.stderr}`).toBe(0);
    expect(resB.code, `start stderr: ${resB.stderr}`).toBe(0);

    const paths = repoPaths(dir);
    const finalTicket = await readTicket(paths, ticket.id);

    // Both commands' committed effects must survive, unconditionally of
    // ordering: start's transition to in_progress with an active session
    // is never reverted (no orphaned session), and update's priority
    // change is never lost.
    expect(finalTicket.priority).toBe(0);
    expect(finalTicket.state).toBe("in_progress");
    expect(finalTicket.active_session).not.toBeNull();

    const sessions = await listSessions(paths);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(finalTicket.active_session);
    // The started session must still be genuinely active (not orphaned
    // by a ticket write that silently reverted active_session back to
    // null while the session file itself stayed ended_at: null).
    expect(sessions[0]?.ended_at).toBeNull();
  }, 30_000);

  it("`update --priority 0` racing `done`, on a real repo: the completed ticket is never resurrected and the priority change is never lost, regardless of which process's lock wins", async () => {
    const { dir } = await makeCliRepo();
    const ticket = newTicketCli(dir, "ryan", "Update vs done race");

    mustRunSlopSource(["start", ticket.slug], dir, "ryan");
    mustRunSlopSource(["review", ticket.slug, "--mr", "https://example.com/pr/1"], dir, "ryan");

    const procA = spawn("bun", [cliEntry, "update", ticket.slug, "--priority", "0"], {
      cwd: dir,
      env: slopEnv({ SLOP_ACTOR: "updater" }),
    });
    const procB = spawn("bun", [cliEntry, "done", ticket.slug, "--note", "shipped"], {
      cwd: dir,
      env: slopEnv({ SLOP_ACTOR: "finisher" }),
    });
    const [resA, resB] = await Promise.all([collect(procA), collect(procB)]);

    expect(
      hasGenuineOverlap([resA, resB]),
      "update and done never overlapped in wall-clock time — this run could pass vacuously off accidental serialisation",
    ).toBe(true);

    expect(resA.code, `update stderr: ${resA.stderr}`).toBe(0);
    expect(resB.code, `done stderr: ${resB.stderr}`).toBe(0);

    const paths = repoPaths(dir);
    const finalTicket = await readTicket(paths, ticket.id);

    // `done`'s terminal transition must never be reverted back to
    // "review" by update's stale-snapshot write (the "resurrecting
    // terminal tickets" half of the bug), and update's priority change
    // must never be lost either.
    expect(finalTicket.state).toBe("done");
    expect(finalTicket.priority).toBe(0);
    expect(finalTicket.active_session).toBeNull();
    expect(finalTicket.review).toBeUndefined();

    const sessions = await listSessions(paths);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.ended_at).not.toBeNull();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ticket_01KY9RWFM80BKNE2CDX85QMKGS: `update --progress` (and ONLY
// --progress — no other flag) is lock-free. This is the payoff: N agents
// can post progress notes against the SAME ticket at the same instant with
// ZERO write contention and zero merge conflicts, because each note is an
// immutable event of its own (a freshly-minted ULID file — never
// collides), not a mutation of the shared ticket file that would need
// `withLock` to serialize. Contrast the "update vs start/done" tests
// above: those races serialize on the db lock (one waits for the other);
// this one never even tries to acquire it.
// ---------------------------------------------------------------------------

describe("update --progress: lock-free concurrency (ticket_01KY9RWFM80BKNE2CDX85QMKGS)", () => {
  it("8 concurrent pure `update --progress` calls against the SAME ticket all succeed, land as 8 distinct events, and the derived latest_note/last_activity_at reflect them — with no lock contention", async () => {
    const { dir } = await makeCliRepo();
    const ticket = newTicketCli(dir, "ryan", "Concurrent progress ticket");
    const paths = repoPaths(dir);

    const N = 8;
    const procs = Array.from({ length: N }, (_, i) =>
      spawn("bun", [cliEntry, "update", ticket.id, "--progress", `note-${i}`], {
        cwd: dir,
        env: slopEnv({ SLOP_ACTOR: `agent-${i}` }),
      }),
    );
    const results = await Promise.all(procs.map(collect));

    expect(
      hasGenuineOverlap(results),
      "the N update --progress calls never overlapped in wall-clock time — this run could pass vacuously off accidental serialisation",
    ).toBe(true);

    // All N succeed, and none ever saw a CONFLICT/lock error — there was
    // never a lock to contend on in the first place.
    for (const [i, r] of results.entries()) {
      expect(r.code, `update --progress note-${i} stderr: ${r.stderr}`).toBe(0);
      expect(r.stderr).not.toMatch(/CONFLICT|lock/i);
    }

    // All N progress events landed, as distinct ULID event files — none
    // clobbered another (the whole point: append-only, never a shared
    // mutation).
    const events = await queryEvents(paths, { ticket: ticket.id });
    const progressEntries = events.flatMap((e) =>
      typeof e.payload.progress === "string"
        ? [{ note: e.payload.progress, at: e.at, id: e.id }]
        : [],
    );
    expect(progressEntries).toHaveLength(N);
    expect(new Set(progressEntries.map((e) => e.id)).size).toBe(N); // distinct event files
    expect(new Set(progressEntries.map((e) => e.note)).size).toBe(N); // distinct notes, none lost

    // No ticket-file write contention: the ticket file itself was never
    // touched by any of these calls (a pure --progress call never takes
    // the lock or writes it).
    const finalTicket = await readTicket(paths, ticket.id);
    expect(finalTicket.latest_note).toBeNull();
    expect(finalTicket.updated_at).toBe(finalTicket.created_at);

    // The DERIVED effective values (what every real read path reports —
    // `show --json` here) are correct: latest_note is one of the N notes,
    // and last_activity_at is the newest of the N events' timestamps.
    const show = mustRunSlopSource(["show", ticket.id, "--json"], dir, "ryan");
    const shown = JSON.parse(show.stdout) as {
      ticket: { latest_note: string | null; last_activity_at: string };
    };
    expect(progressEntries.map((e) => e.note)).toContain(shown.ticket.latest_note);
    const newestAt = progressEntries.reduce((max, e) => (e.at > max ? e.at : max), "");
    expect(shown.ticket.last_activity_at).toBe(newestAt);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ticket_01KY9RWFM80BKNE2CDX85QMKGS's deferred item: a genuinely no-op
// `update` call (nothing in UPDATE_TOUCHABLE_FIELDS actually changes)
// early-returns with no write and no event — previously it still took the
// lock's write and emitted an empty-payload `ticket.updated` event.
// ---------------------------------------------------------------------------

describe("update: a PURE no-op call writes nothing and emits no event (CLI-layer early return)", () => {
  it("`update --state <same-state>`, nothing else given: ticket file byte-for-byte unchanged, no new event", async () => {
    const { dir } = await makeCliRepo();
    const ticket = newTicketCli(dir, "ryan", "No-op update ticket");
    const paths = repoPaths(dir);

    const before = await readTicket(paths, ticket.id);
    const eventsBefore = await queryEvents(paths, { ticket: ticket.id });

    // A freshly-`new`'d ticket is already "open" — this restates it.
    const result = mustRunSlopSource(["update", ticket.id, "--state", "open"], dir, "ryan");
    expect(result.status, result.stderr).toBe(0);

    const after = await readTicket(paths, ticket.id);
    expect(after).toEqual(before);

    const eventsAfter = await queryEvents(paths, { ticket: ticket.id });
    expect(eventsAfter.map((e) => e.id)).toEqual(eventsBefore.map((e) => e.id));
  });
});

// ---------------------------------------------------------------------------
// ticket_01KYA3Z9FNZ2FDMDRWNKR9EV7J: `update --relates-to <±ref>` — the
// relates-to edge previously had no CLI flag on any mutating command at
// all; this is the `update`-side half (`new --relates-to <ref>`, bare
// add-only, is the other half — see new.test.ts). Same `+ref`/`-ref`
// sigil convention as `--label`, validated via the same edges.ts module
// `new` uses (`validateTicketEdges`).
// ---------------------------------------------------------------------------

describe("update --relates-to <±ref>: add/remove a relates-to edge (ticket_01KYA3Z9FNZ2FDMDRWNKR9EV7J)", () => {
  it("--help lists --relates-to", () => {
    const result = spawnSync("bun", [cliEntry, "update", "--help"], { encoding: "utf8" });
    expect(result.stdout).toContain("--relates-to");
  });

  it("+ref adds a relates-to edge, visible via `show --json`", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const target = newTicketCli(dir, "ryan", "Related target");

    const result = mustRunSlopSource(
      ["update", main.id, "--relates-to", `+${target.slug}`],
      dir,
      "ryan",
    );
    expect(result.status, result.stderr).toBe(0);

    const paths = repoPaths(dir);
    const after = await readTicket(paths, main.id);
    expect(after.relates_to).toEqual([target.id]);
  });

  it("-ref removes a previously-added relates-to edge", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const target = newTicketCli(dir, "ryan", "Related target");
    mustRunSlopSource(["update", main.id, "--relates-to", `+${target.slug}`], dir, "ryan");

    const result = mustRunSlopSource(
      ["update", main.id, "--relates-to", `-${target.slug}`],
      dir,
      "ryan",
    );
    expect(result.status, result.stderr).toBe(0);

    const paths = repoPaths(dir);
    const after = await readTicket(paths, main.id);
    expect(after.relates_to).toEqual([]);
  });

  it("add and remove combined in one call (repeatable flag)", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const keep = newTicketCli(dir, "ryan", "Keep this one");
    const drop = newTicketCli(dir, "ryan", "Drop this one");
    const add = newTicketCli(dir, "ryan", "Add this one");
    mustRunSlopSource(
      ["update", main.id, "--relates-to", `+${keep.slug}`, "--relates-to", `+${drop.slug}`],
      dir,
      "ryan",
    );

    const result = mustRunSlopSource(
      ["update", main.id, "--relates-to", `+${add.slug}`, "--relates-to", `-${drop.slug}`],
      dir,
      "ryan",
    );
    expect(result.status, result.stderr).toBe(0);

    const paths = repoPaths(dir);
    const after = await readTicket(paths, main.id);
    expect(after.relates_to.sort()).toEqual([keep.id, add.id].sort());
  });

  it("rejects a nonexistent --relates-to ref (exit 4, NOT_FOUND), leaving the ticket untouched", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const paths = repoPaths(dir);
    const before = await readTicket(paths, main.id);

    const result = runSlopSource(
      ["update", main.id, "--relates-to", "+no-such-ticket"],
      dir,
      "ryan",
    );
    expect(result.status).toBe(4);
    expect(result.stderr).toMatch(/no-such-ticket/);

    const after = await readTicket(paths, main.id);
    expect(after).toEqual(before);
  });

  it("rejects a --relates-to entry missing the +/- sigil (exit 2, USAGE_ERROR)", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const target = newTicketCli(dir, "ryan", "Related target");

    const result = runSlopSource(["update", main.id, "--relates-to", target.slug], dir, "ryan");
    expect(result.status).toBe(2);
  });

  it("a redundant +ref on an already-present target is a no-op: no new event, ticket unchanged", async () => {
    const { dir } = await makeCliRepo();
    const main = newTicketCli(dir, "ryan", "Main ticket");
    const target = newTicketCli(dir, "ryan", "Related target");
    mustRunSlopSource(["update", main.id, "--relates-to", `+${target.slug}`], dir, "ryan");

    const paths = repoPaths(dir);
    const before = await readTicket(paths, main.id);
    const eventsBefore = await queryEvents(paths, { ticket: main.id });

    const result = mustRunSlopSource(
      ["update", main.id, "--relates-to", `+${target.slug}`],
      dir,
      "ryan",
    );
    expect(result.status, result.stderr).toBe(0);

    const after = await readTicket(paths, main.id);
    expect(after).toEqual(before);
    const eventsAfter = await queryEvents(paths, { ticket: main.id });
    expect(eventsAfter.map((e) => e.id)).toEqual(eventsBefore.map((e) => e.id));
  });
});

// ---------------------------------------------------------------------------
// In-process coverage of `runUpdate` (real v8 coverage, no subprocess).
// ---------------------------------------------------------------------------

function baseOpts(overrides: Partial<Parameters<typeof runUpdate>[1]> = {}) {
  return {
    label: [] as string[],
    relatesTo: [] as string[],
    acceptance: [] as string[],
    context: [] as string[],
    ...overrides,
  };
}

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

describe("runUpdate (in-process)", () => {
  it("a pure --progress call appends a note event without taking the lock or rewriting the ticket file", async () => {
    const root = await makeTempRepo("slop-update-inproc-progress-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Progress-only ticket");
    const paths = repoPaths(root);
    const before = await readTicket(paths, id);

    const out = captureOutput();
    try {
      await withCwd(root, () => runUpdate(id, baseOpts({ progress: "made some headway" })));
      expect(out.stdout()).toContain(`updated ${id}`);
    } finally {
      out.restore();
    }
    const after = await readTicket(paths, id);
    expect(after).toEqual(before); // never rewritten — pure progress is event-only
    const events = await queryEvents(paths, { ticket: id });
    expect(events.some((e) => e.payload.progress === "made some headway")).toBe(true);
  });

  it("--priority changes the stored priority", async () => {
    const root = await makeTempRepo("slop-update-inproc-priority-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Priority ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runUpdate(id, baseOpts({ priority: 0 })));
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).priority).toBe(0);
  });

  it("--label +x adds a label; a later --label -x removes it", async () => {
    const root = await makeTempRepo("slop-update-inproc-label-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Label ticket");
    const paths = repoPaths(root);

    const out1 = captureOutput();
    try {
      await withCwd(root, () => runUpdate(id, baseOpts({ label: ["+urgent"] })));
    } finally {
      out1.restore();
    }
    expect((await readTicket(paths, id)).labels).toContain("urgent");

    const out2 = captureOutput();
    try {
      await withCwd(root, () => runUpdate(id, baseOpts({ label: ["-urgent"] })));
    } finally {
      out2.restore();
    }
    expect((await readTicket(paths, id)).labels).not.toContain("urgent");
  });

  it("--relates-to +<ref> adds a symmetric relates-to edge, validated via validateTicketEdges", async () => {
    const root = await makeTempRepo("slop-update-inproc-relates-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Main ticket");
    const target = await jsonNewTicket(root, "Related target");

    const out = captureOutput();
    try {
      await withCwd(root, () => runUpdate(id, baseOpts({ relatesTo: [`+${target}`] })));
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).relates_to).toContain(target);
  });

  it("a fully redundant patch (no-op) writes nothing: no lock write, no event", async () => {
    const root = await makeTempRepo("slop-update-inproc-noop-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "No-op update ticket");
    const paths = repoPaths(root);
    const before = await readTicket(paths, id);
    const eventsBefore = await queryEvents(paths, { ticket: id });

    const out = captureOutput();
    try {
      // Same priority the ticket already has (default 2) — nothing changes.
      await withCwd(root, () => runUpdate(id, baseOpts({ priority: 2 })));
    } finally {
      out.restore();
    }
    const after = await readTicket(paths, id);
    expect(after).toEqual(before);
    const eventsAfter = await queryEvents(paths, { ticket: id });
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });

  it("throws NOT_FOUND for an unresolvable --relates-to target", async () => {
    const root = await makeTempRepo("slop-update-inproc-badrelates-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Ticket with bad relates-to");

    const out = captureOutput();
    try {
      await expect(
        withCwd(root, () => runUpdate(id, baseOpts({ relatesTo: ["+no-such-ticket"] }))),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
    } finally {
      out.restore();
    }
  });

  it("throws NOT_FOUND for an unresolvable <ref>", async () => {
    const root = await makeTempRepo("slop-update-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const out = captureOutput();
    try {
      await expect(
        withCwd(root, () => runUpdate("no-such-ticket", baseOpts({ priority: 1 }))),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
    } finally {
      out.restore();
    }
  });
});
