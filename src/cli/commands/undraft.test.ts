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
import { readTicket, repoPaths } from "../../repo/index.js";
import { runDraft } from "./draft.js";
import { runNew } from "./new.js";
import { runStart } from "./start.js";
import { runUndraft } from "./undraft.js";

// Regression test for ticket_01KY93E2BKH5JCMAV3JWPNN63G — see
// update.test.ts's module doc for the full bug description. This file
// covers `undraft`'s half: it used to read the ticket OUTSIDE any lock, so
// racing a concurrent `update` (also unlocked pre-fix, but now sharing the
// same lock post-fix) could silently lose one side's committed field
// change via `writeUpdate`'s `writeCanonical(expectedAfter)` fallback
// (src/core/jsonc.ts).
//
// Unlike draft.test.ts's race (mutually exclusive edges, so exactly one
// side must lose), `undraft --state open` and `update --priority 0` touch
// DISJOINT fields and neither's legality depends on the other's — so a
// correctly-locked pair must ALWAYS leave both effects intact, regardless
// of which one's lock is acquired first. That "both survive, every time"
// invariant is what this test asserts.

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
  const dir = await mkdtemp(join(tmpdir(), "slop-undraft-race-"));
  scratchDirs.push(dir);
  const init = mustRunSlopSource(
    ["init", "--yes", "--project", "undraft-race-fixture", "--user", "ryan"],
    dir,
    "ryan",
  );
  expect(init.status, init.stderr).toBe(0);
  return { dir };
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

function newDraftTicketCli(
  dir: string,
  actor: string,
  name: string,
): { id: TicketId; slug: string } {
  const result = mustRunSlopSource(["new", name, "--draft"], dir, actor);
  const m = CREATED_LINE.exec(result.stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(`could not parse "created <id> (slug: <slug>)" out of:\n${result.stdout}`);
  }
  return { id: m[1] as TicketId, slug: m[2] };
}

describe("undraft: race against a concurrent lock-holding mutator (regression, ticket_01KY93E2BKH5JCMAV3JWPNN63G)", () => {
  it("`undraft` racing `update --priority 0`, on a real repo: BOTH commands' committed effects survive every time, regardless of which process's lock wins", async () => {
    // Repeated across several independent tickets for the same reason
    // draft.test.ts's race is repeated: whether the pre-fix unlocked
    // write lands inside the other command's read-modify-write window
    // is timing-sensitive, so a single attempt can pass vacuously.
    // Post-fix this invariant holds unconditionally on every attempt.
    const ATTEMPTS = 6;
    const { dir } = await makeCliRepo();
    let sawOverlap = false;

    for (let i = 0; i < ATTEMPTS; i++) {
      const ticket = newDraftTicketCli(dir, "ryan", `Undraft vs update race ${i}`);

      const procA = spawn("bun", [cliEntry, "undraft", ticket.slug], {
        cwd: dir,
        env: slopEnv({ SLOP_ACTOR: "undrafter" }),
      });
      const procB = spawn("bun", [cliEntry, "update", ticket.slug, "--priority", "0"], {
        cwd: dir,
        env: slopEnv({ SLOP_ACTOR: "updater" }),
      });
      const [resA, resB] = await Promise.all([collect(procA), collect(procB)]);

      if (hasGenuineOverlap([resA, resB])) sawOverlap = true;

      expect(resA.code, `attempt ${i}: undraft stderr: ${resA.stderr}`).toBe(0);
      expect(resB.code, `attempt ${i}: update stderr: ${resB.stderr}`).toBe(0);

      const paths = repoPaths(dir);
      const finalTicket = await readTicket(paths, ticket.id);

      // Both commands' committed effects must survive, unconditionally
      // of ordering: undraft's transition to open is never lost, and
      // update's priority change is never lost either.
      expect(finalTicket.state, `attempt ${i}`).toBe("open");
      expect(finalTicket.priority, `attempt ${i}`).toBe(0);
    }

    expect(
      sawOverlap,
      "no attempt's undraft/update pair overlapped in wall-clock time — this run could pass vacuously off accidental serialisation",
    ).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// In-process coverage of `runUndraft` (real v8 coverage, no subprocess).
// ---------------------------------------------------------------------------

async function jsonNewTicket(
  root: string,
  name: string,
  extra: { draft?: boolean } = {},
): Promise<TicketId> {
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
        ...extra,
      }),
    );
    return (JSON.parse(out.stdout()) as { id: TicketId }).id;
  } finally {
    out.restore();
  }
}

describe("runUndraft (in-process)", () => {
  it("moves a draft ticket to open", async () => {
    const root = await makeTempRepo("slop-undraft-inproc-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Draft ticket to undraft", { draft: true });

    const out = captureOutput();
    try {
      await withCwd(root, () => runUndraft(id));
      expect(out.stdout()).toContain(`undrafted ${id}`);
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).state).toBe("open");
  });

  it("an already-open ticket is an idempotent no-op", async () => {
    const root = await makeTempRepo("slop-undraft-inproc-idempotent-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Already-open ticket");
    const paths = repoPaths(root);
    const before = await readTicket(paths, id);

    const out = captureOutput();
    try {
      await withCwd(root, () => runUndraft(id));
      expect(out.stdout()).toContain("already open — no changes made");
    } finally {
      out.restore();
    }
    const after = await readTicket(paths, id);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("refuses to undraft an in_progress ticket (CONFLICT, exit 6)", async () => {
    const root = await makeTempRepo("slop-undraft-inproc-conflict-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "In-progress ticket");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }

    await expect(withCwd(root, () => runUndraft(id))).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFLICT,
    });
  });

  it("round-trips draft -> undraft -> draft", async () => {
    const root = await makeTempRepo("slop-undraft-inproc-roundtrip-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Round trip ticket");
    const paths = repoPaths(root);

    const out1 = captureOutput();
    try {
      await withCwd(root, () => runDraft(id));
    } finally {
      out1.restore();
    }
    expect((await readTicket(paths, id)).state).toBe("draft");

    const out2 = captureOutput();
    try {
      await withCwd(root, () => runUndraft(id));
    } finally {
      out2.restore();
    }
    expect((await readTicket(paths, id)).state).toBe("open");
  });

  it("throws NOT_FOUND for an unresolvable ref", async () => {
    const root = await makeTempRepo("slop-undraft-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await expect(withCwd(root, () => runUndraft("no-such-ticket"))).rejects.toMatchObject({
      exitCode: EXIT_CODES.NOT_FOUND,
    });
  });
});
