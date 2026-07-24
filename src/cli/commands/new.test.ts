import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { shortTicketCode } from "../../core/index.js";

// ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1: `new` surfaces the short, stable
// t-<code> handle (core/ids.ts's shortTicketCode) so a human/agent can
// reuse it. Source-spawned (`bun src/cli/index.ts ...`), matching this
// directory's established convention (draft.test.ts/start.test.ts) —
// exercises the real CLI wiring, not just the pure derivation (that's
// core/ids.test.ts's job) or resolution (repo/refs.test.ts's job).

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

function slopEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, SLOP_ACTOR: "new-test" };
  for (const key of HARNESS_ENV_KEYS) env[key] = undefined;
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
  const root = await mkdtemp(join(tmpdir(), "slop-new-handle-test-"));
  scratchDirs.push(root);
  const init = mustRunSlop(
    ["init", "--yes", "--project", "new-handle-fixture", "--user", "ryan"],
    root,
  );
  expect(init.status, init.stderr).toBe(0);
  return root;
}

// Same regex several OTHER command test files (draft.test.ts, start.test.ts,
// update.test.ts, undraft.test.ts, done.test.ts, ...) depend on to bootstrap
// a ticket via `new` — a regression guard that adding the handle line never
// disturbs this first line's exact shape.
const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

describe("new: surfaces the t-<code> short handle (ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1)", () => {
  it("human output prints a handle line matching shortTicketCode(id), without disturbing the `created <id> (slug: <slug>)` line other commands' tests parse", async () => {
    const root = await makeFixtureRepo();
    const result = mustRunSlop(["new", "A ticket with a handle"], root);

    const created = CREATED_LINE.exec(result.stdout);
    expect(created?.[1], result.stdout).toBeTruthy();
    const id = created?.[1] as string;

    const expectedHandle = shortTicketCode(id);
    expect(result.stdout).toContain(`handle: ${expectedHandle}`);
    expect(result.stdout).toMatch(/^\s*handle: t-[0-9a-z]{5}$/m);
  });

  it("--json output includes a `handle` field matching shortTicketCode(id), alongside the existing documented fields", async () => {
    const root = await makeFixtureRepo();
    const result = mustRunSlop(["new", "A json ticket", "--json"], root);

    const body = JSON.parse(result.stdout) as {
      id: string;
      slug: string;
      handle: string;
      name: string;
      state: string;
      priority: number;
      parent: string | null;
    };
    expect(body.handle).toBe(shortTicketCode(body.id));
    expect(body.handle).toMatch(/^t-[0-9a-z]{5}$/);
    // Existing fields are untouched by the addition.
    expect(body.slug).toEqual(expect.any(String));
    expect(body.name).toBe("A json ticket");
  });

  it("two distinct tickets get distinct handles that each resolve back to their own ticket via `slop show`", async () => {
    const root = await makeFixtureRepo();
    const a = mustRunSlop(["new", "First distinct ticket", "--json"], root);
    const b = mustRunSlop(["new", "Second distinct ticket", "--json"], root);
    const aBody = JSON.parse(a.stdout) as { id: string; handle: string };
    const bBody = JSON.parse(b.stdout) as { id: string; handle: string };

    expect(aBody.handle).not.toBe(bBody.handle);

    const showA = mustRunSlop(["show", aBody.handle], root);
    expect(showA.stdout).toContain(aBody.id);
    const showB = mustRunSlop(["show", bBody.handle], root);
    expect(showB.stdout).toContain(bBody.id);
  });
});
