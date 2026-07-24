import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import { shortTicketCode } from "../../core/index.js";
import type { TicketId } from "../../core/index.js";
import { runNew } from "./new.js";
import { runShow } from "./show.js";
import { runUpdate } from "./update.js";

// ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1: `show` surfaces the short t-<code>
// handle, AND resolves a ref given in that exact form back to the same
// ticket (repo/refs.ts's new precedence step). Source-spawned
// (`bun src/cli/index.ts ...`), matching this directory's established
// convention (draft.test.ts/start.test.ts) — this exercises the real CLI
// wiring end-to-end; the pure derivation is core/ids.test.ts's job and the
// resolution/collision/precedence logic is repo/refs.test.ts's job.

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
  const env: Record<string, string | undefined> = { ...process.env, SLOP_ACTOR: "show-test" };
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

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

async function makeFixtureWithTicket(
  name: string,
): Promise<{ root: string; id: string; slug: string }> {
  const root = await mkdtemp(join(tmpdir(), "slop-show-handle-test-"));
  scratchDirs.push(root);
  const init = mustRunSlop(
    ["init", "--yes", "--project", "show-handle-fixture", "--user", "ryan"],
    root,
  );
  expect(init.status, init.stderr).toBe(0);

  const created = mustRunSlop(["new", name], root);
  const m = CREATED_LINE.exec(created.stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(`could not parse "created <id> (slug: <slug>)" out of:\n${created.stdout}`);
  }
  return { root, id: m[1], slug: m[2] };
}

describe("show: surfaces the t-<code> short handle (ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1)", () => {
  it("the plain (no --tree/--context) human view prints a handle line matching shortTicketCode(id)", async () => {
    const { root, id } = await makeFixtureWithTicket("Show handle ticket");
    const result = mustRunSlop(["show", id], root);
    const expectedHandle = shortTicketCode(id);
    expect(result.stdout).toContain(`handle: ${expectedHandle}`);
  });

  it("--json includes a top-level `handle` field matching shortTicketCode(id), alongside the untouched `ticket` object", async () => {
    const { root, id } = await makeFixtureWithTicket("Show json handle ticket");
    const result = mustRunSlop(["show", id, "--json"], root);
    const body = JSON.parse(result.stdout) as {
      ticket: { id: string };
      handle: string;
    };
    expect(body.handle).toBe(shortTicketCode(id));
    expect(body.ticket.id).toBe(id);
  });

  it("resolves the ticket's own t-<code> handle as the <ref> argument, returning that exact ticket", async () => {
    const { root, id } = await makeFixtureWithTicket("Resolve via handle ticket");
    const handle = shortTicketCode(id);
    const result = mustRunSlop(["show", handle], root);
    expect(result.stdout).toContain(id);

    const jsonResult = mustRunSlop(["show", handle, "--json"], root);
    const body = JSON.parse(jsonResult.stdout) as { ticket: { id: string } };
    expect(body.ticket.id).toBe(id);
  });

  it("resolves the handle case-insensitively", async () => {
    const { root, id } = await makeFixtureWithTicket("Case insensitive handle ticket");
    const handle = shortTicketCode(id).toUpperCase();
    const result = mustRunSlop(["show", handle], root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(id);
  });

  it("a well-formed but nonexistent handle is NOT_FOUND (exit 4), the same as any other unresolvable ref", async () => {
    const { root } = await makeFixtureWithTicket("Solo ticket");
    // "t-00000" is well-shaped but essentially never a real derived code
    // for a freshly created ticket in a brand-new repo.
    const result = runSlop(["show", "t-00000"], root);
    expect(result.status).toBe(4);
  });

  it("--context stays exactly the budgeted context text (no handle line injected into that path)", async () => {
    // Deliberate scoping decision (see show.ts's comment): the handle is
    // surfaced on the plain view and in --json, but NOT prepended to
    // --context's own output, because that text is exactly
    // renderContextPackWithBudget's budgeted result — E1's own bound
    // (`bounded.stdout.length <= budget + 1`) would be broken by any
    // fixed-size prefix added unconditionally ahead of it.
    const { root, id } = await makeFixtureWithTicket("Context budget ticket");
    const result = mustRunSlop(["show", id, "--context"], root);
    expect(result.stdout).not.toContain("handle:");
    expect(result.stdout).toContain(`# Context: Context budget ticket`);
  });
});

// ---------------------------------------------------------------------------
// In-process coverage of `runShow` (real v8 coverage, no subprocess).
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

describe("runShow (in-process)", () => {
  it("plain view: prints the handle line and the formatted ticket detail", async () => {
    const root = await makeTempRepo("slop-show-inproc-plain-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Plain view ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runShow(id, {}));
      expect(out.stdout()).toMatch(/^handle: t-[0-9a-z]{5}$/m);
      expect(out.stdout()).toContain("Plain view ticket");
    } finally {
      out.restore();
    }
  });

  it("--json includes ticket, handle, and jira_url:null when no external parent", async () => {
    const root = await makeTempRepo("slop-show-inproc-json-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Json view ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runShow(id, { json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      ticket: { id: string };
      handle: string;
      jira_url: string | null;
    };
    expect(body.ticket.id).toBe(id);
    expect(body.jira_url).toBeNull();
  });

  it("--tree renders an ancestry/descendant tree", async () => {
    const root = await makeTempRepo("slop-show-inproc-tree-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Tree root ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runShow(id, { tree: true }));
      expect(out.stdout()).toContain("Tree root ticket");
    } finally {
      out.restore();
    }
  });

  it("--tree --json includes a tree.root node", async () => {
    const root = await makeTempRepo("slop-show-inproc-tree-json-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Tree json ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runShow(id, { tree: true, json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { tree: { root: { id: string } } };
    expect(body.tree.root.id).toBe(id);
  });

  it("--context includes the context pack, bounded by --budget without corrupting --json", async () => {
    const root = await makeTempRepo("slop-show-inproc-context-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Context ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runShow(id, { context: true, json: true, budget: 5 }));
    } finally {
      out.restore();
    }
    expect(() => JSON.parse(out.stdout())).not.toThrow();
    const body = JSON.parse(out.stdout()) as { context: unknown };
    expect(body.context).toBeDefined();
  });

  it("reflects a lock-free --progress update via the effective overlay (ticket_01KY9RWFM80BKNE2CDX85QMKGS)", async () => {
    const root = await makeTempRepo("slop-show-inproc-effective-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Effective note ticket");

    const updateOut = captureOutput();
    try {
      await withCwd(root, () =>
        runUpdate(id, {
          label: [],
          relatesTo: [],
          acceptance: [],
          context: [],
          progress: "fresh progress note",
        }),
      );
    } finally {
      updateOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runShow(id, {}));
      expect(out.stdout()).toContain("fresh progress note");
    } finally {
      out.restore();
    }
  });

  it("throws NOT_FOUND for an unresolvable ref", async () => {
    const root = await makeTempRepo("slop-show-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runShow("no-such-ticket", {}))).rejects.toMatchObject({
        exitCode: EXIT_CODES.NOT_FOUND,
      });
    } finally {
      out.restore();
    }
  });
});
