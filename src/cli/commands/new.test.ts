import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import { type TicketId, shortTicketCode } from "../../core/index.js";
import { readTicket, repoPaths } from "../../repo/index.js";
import { SlopError } from "../errors.js";
import { runNew } from "./new.js";

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

// ticket_01KYA3Z9FNZ2FDMDRWNKR9EV7J: `new --relates-to <ref>` — the
// relates-to edge previously had no CLI flag on any mutating command;
// this is the new one, mirroring `--blocks` exactly (bare ref, repeatable,
// add-only). Real-CLI-spawned, same convention as this file's other tests.
describe("new --relates-to <ref>: sets a relates-to edge (ticket_01KYA3Z9FNZ2FDMDRWNKR9EV7J)", () => {
  it("--help lists --relates-to", () => {
    const result = spawnSync("bun", [cliEntry, "new", "--help"], { encoding: "utf8" });
    expect(result.stdout).toContain("--relates-to");
  });

  it("adds a relates-to edge to an existing ticket, visible via `show --json`", async () => {
    const root = await makeFixtureRepo();
    const target = mustRunSlop(["new", "Target ticket", "--json"], root);
    const targetBody = JSON.parse(target.stdout) as { id: string; slug: string };

    const result = mustRunSlop(
      ["new", "Ticket relating to target", "--relates-to", targetBody.slug],
      root,
    );
    const created = CREATED_LINE.exec(result.stdout);
    const id = created?.[1] as string;

    const show = mustRunSlop(["show", id, "--json"], root);
    const shown = JSON.parse(show.stdout) as { ticket: { relates_to: string[] } };
    expect(shown.ticket.relates_to).toEqual([targetBody.id]);
  });

  it("is repeatable — multiple --relates-to flags all land in relates_to", async () => {
    const root = await makeFixtureRepo();
    const a = mustRunSlop(["new", "Related A", "--json"], root);
    const b = mustRunSlop(["new", "Related B", "--json"], root);
    const aBody = JSON.parse(a.stdout) as { id: string; slug: string };
    const bBody = JSON.parse(b.stdout) as { id: string; slug: string };

    const result = mustRunSlop(
      ["new", "Multi-relates ticket", "--relates-to", aBody.slug, "--relates-to", bBody.slug],
      root,
    );
    const created = CREATED_LINE.exec(result.stdout);
    const id = created?.[1] as string;

    const show = mustRunSlop(["show", id, "--json"], root);
    const shown = JSON.parse(show.stdout) as { ticket: { relates_to: string[] } };
    expect(shown.ticket.relates_to.sort()).toEqual([aBody.id, bBody.id].sort());
  });

  it("rejects a nonexistent --relates-to ref (exit 4, NOT_FOUND)", async () => {
    const root = await makeFixtureRepo();
    const result = runSlop(["new", "Bad relates-to", "--relates-to", "no-such-ticket"], root);
    expect(result.status).toBe(4);
    expect(result.stderr).toMatch(/no-such-ticket/);
  });
});

// ---------------------------------------------------------------------------
// In-process coverage of `runNew` (real v8 coverage, no subprocess) —
// tests/support/cli-harness.ts's withCwd/bootstrapRepo/captureOutput.
// ---------------------------------------------------------------------------

function baseOpts(overrides: Partial<Parameters<typeof runNew>[1]> = {}) {
  return {
    blocks: [] as string[],
    relatesTo: [] as string[],
    label: [] as string[],
    ...overrides,
  };
}

describe("runNew (in-process)", () => {
  it("creates a ticket with sensible defaults and prints the created line + handle", async () => {
    const root = await makeTempRepo("slop-new-inproc-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    const out = captureOutput();
    try {
      await withCwd(root, () => runNew("A plain ticket", baseOpts()));
    } finally {
      out.restore();
    }
    expect(out.stdout()).toMatch(/^created ticket_[0-9A-Z]+ {2}\(slug: a-plain-ticket\)/m);
    expect(out.stdout()).toMatch(/^\s*handle: t-[0-9a-z]{5}$/m);

    const paths = repoPaths(root);
    const created = await readTicket(
      paths,
      (out.stdout().match(/created (ticket_[0-9A-Z]+)/)?.[1] ?? "") as TicketId,
    );
    expect(created.name).toBe("A plain ticket");
    expect(created.state).toBe("open");
    expect(created.priority).toBe(2);
  });

  it("--json prints id/slug/handle/name/state/priority/parent", async () => {
    const root = await makeTempRepo("slop-new-inproc-json-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    const out = captureOutput();
    try {
      await withCwd(root, () => runNew("A json ticket", baseOpts({ json: true })));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      id: string;
      slug: string;
      handle: string;
      name: string;
      state: string;
      priority: number;
      parent: string | null;
    };
    expect(body.name).toBe("A json ticket");
    expect(body.handle).toBe(shortTicketCode(body.id));
    expect(body.parent).toBeNull();
  });

  it("--draft creates a draft-state ticket", async () => {
    const root = await makeTempRepo("slop-new-inproc-draft-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    const out = captureOutput();
    try {
      await withCwd(root, () => runNew("Draft ticket", baseOpts({ draft: true, json: true })));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { state: string };
    expect(body.state).toBe("draft");
  });

  it("--parent links to an existing ticket, and an unknown --parent ref throws NOT_FOUND", async () => {
    const root = await makeTempRepo("slop-new-inproc-parent-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    const out1 = captureOutput();
    let parentId: string;
    try {
      await withCwd(root, () => runNew("Parent ticket", baseOpts({ json: true })));
      parentId = (JSON.parse(out1.stdout()) as { id: string }).id;
    } finally {
      out1.restore();
    }

    const out2 = captureOutput();
    try {
      await withCwd(root, () => runNew("Child ticket", baseOpts({ parent: parentId, json: true })));
      const body = JSON.parse(out2.stdout()) as { parent: string | null };
      expect(body.parent).toBe(parentId);
    } finally {
      out2.restore();
    }

    const out3 = captureOutput();
    try {
      await expect(
        withCwd(root, () => runNew("Orphan ticket", baseOpts({ parent: "no-such-ticket" }))),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
    } finally {
      out3.restore();
    }
  });

  it("throws NOT_FOUND for an unresolvable --blocks ref, without creating the ticket", async () => {
    const root = await makeTempRepo("slop-new-inproc-blocks-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    const out = captureOutput();
    try {
      const err: unknown = await withCwd(root, () =>
        runNew("Never created", baseOpts({ blocks: ["no-such-ticket"] })),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SlopError);
      expect((err as SlopError).exitCode).toBe(EXIT_CODES.NOT_FOUND);
    } finally {
      out.restore();
    }
  });

  it("throws NOT_FOUND (via requireRepoRoot) outside any .slop repo", async () => {
    const root = await makeTempRepo("slop-new-inproc-norepo-");
    // No bootstrapRepo call — no .slop/ at all.
    await expect(withCwd(root, () => runNew("x", baseOpts()))).rejects.toThrow();
  });
});
