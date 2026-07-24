import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import type { Session, Ticket, TicketId } from "../../core/index.js";
import {
  newSessionId,
  newTicketId,
  sessionSchema,
  shortTicketCode,
  ticketSchema,
} from "../../core/index.js";
import type { RepoPaths } from "../../repo/index.js";
import {
  createEntityFileCanonical,
  ensureDbDirs,
  rebuildIndex,
  sessionFilePath,
  ticketFilePath,
} from "../../repo/index.js";
import { runNew } from "./new.js";
import { runReview } from "./review.js";
import { runStart } from "./start.js";
import { runStatus } from "./status.js";

// ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1: `status` surfaces the short t-<code>
// handle (core/ids.ts's shortTicketCode) on its in_progress/review/stale
// rows. Source-spawned (`bun src/cli/index.ts status ...`) against
// fixtures built directly through the repo layer — same convention as
// tests/acceptance/D4.test.ts (which this file otherwise mirrors), except
// spawning from SOURCE rather than the compiled `dist/slop` binary, so
// this exercises the current source tree without requiring a rebuild.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const CONFIG_YAML = [
  "project: status-handle-fixture",
  "user: status-handle-tester",
  "defaults:",
  "  stale_after: 60m",
  "  review_stale_after: 24h",
  "transcripts: local",
  "",
].join("\n");

async function makeScratchRepo(prefix: string): Promise<RepoPaths> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  const paths = await ensureDbDirs(dir);
  await writeFile(join(dir, ".slop", "config.yaml"), CONFIG_YAML, "utf8");
  return paths;
}

function runSlop(
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync("bun", [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      OPENCODE: undefined,
      CODEX_SANDBOX: undefined,
      CODEX_SANDBOX_NETWORK_DISABLED: undefined,
      ...extraEnv,
    },
  });
}

const NOW = "2026-07-23T10:00:00.000Z";
let ticketCounter = 0;

function makeTicket(overrides: Partial<Ticket> & { name: string; state: Ticket["state"] }): Ticket {
  const id = overrides.id ?? newTicketId();
  ticketCounter += 1;
  return ticketSchema.parse({
    id,
    slug: `status-handle-${ticketCounter}`,
    spec: { summary: "s" },
    priority: 2,
    root_id: id,
    active_session: null,
    provenance: { method: "new", created_by: { name: "fixture", kind: "agent" } },
    last_activity_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  });
}

function makeSession(overrides: Partial<Session> & { ticket: TicketId }): Session {
  return sessionSchema.parse({
    id: newSessionId(),
    actor: { name: "fixture-agent", kind: "agent" },
    harness: { kind: "claude-code", session_id: null },
    git: { branch: "main", commit_at_start: null },
    started_at: NOW,
    ...overrides,
  });
}

async function writeTicket(paths: RepoPaths, ticket: Ticket): Promise<void> {
  await createEntityFileCanonical(ticketFilePath(paths, ticket.id), ticket);
}

async function writeSession(paths: RepoPaths, session: Session): Promise<void> {
  await createEntityFileCanonical(sessionFilePath(paths, session.id), session);
}

describe("status: surfaces the t-<code> short handle (ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1)", () => {
  it("in_progress: human row and --json row both carry the handle", async () => {
    const paths = await makeScratchRepo("slop-status-handle-inprogress-");
    const session = makeSession({ ticket: newTicketId() });
    const ticket = makeTicket({
      id: session.ticket,
      root_id: session.ticket,
      name: "In progress handle ticket",
      state: "in_progress",
      active_session: session.id,
    });
    await writeTicket(paths, ticket);
    await writeSession(paths, session);
    await rebuildIndex(paths);

    const expectedHandle = shortTicketCode(ticket.id);

    const human = runSlop(["status"], paths.root);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain(`In progress (1, oldest session first):`);
    expect(human.stdout).toContain(`(${expectedHandle})`);

    const json = runSlop(["status", "--json"], paths.root);
    expect(json.status, json.stderr).toBe(0);
    const body = JSON.parse(json.stdout) as { in_progress: { id: string; handle: string }[] };
    expect(body.in_progress).toHaveLength(1);
    expect(body.in_progress[0]?.handle).toBe(expectedHandle);
    expect(body.in_progress[0]?.id).toBe(ticket.id);
  });

  it("review: human row and --json row both carry the handle", async () => {
    const paths = await makeScratchRepo("slop-status-handle-review-");
    const ticket = makeTicket({
      name: "Review handle ticket",
      state: "review",
      review: {
        requested_at: NOW,
        by: { name: "ryan", kind: "human" },
        mr: "https://example.com/pr/1",
      },
    });
    await writeTicket(paths, ticket);
    await rebuildIndex(paths);

    const expectedHandle = shortTicketCode(ticket.id);

    const human = runSlop(["status"], paths.root);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain("Awaiting review (1, longest-waiting first):");
    expect(human.stdout).toContain(`(${expectedHandle})`);

    const json = runSlop(["status", "--json"], paths.root);
    const body = JSON.parse(json.stdout) as { review: { id: string; handle: string }[] };
    expect(body.review).toHaveLength(1);
    expect(body.review[0]?.handle).toBe(expectedHandle);
    expect(body.review[0]?.id).toBe(ticket.id);
  });

  it("stale: the human row carries the handle; the --json row's shape stays exactly as documented (unchanged) — see status.ts's comment for why", async () => {
    const paths = await makeScratchRepo("slop-status-handle-stale-");
    const ticket = makeTicket({
      name: "Stale handle ticket",
      state: "in_progress",
      last_activity_at: "2026-07-23T08:00:00.000Z", // 2h before FAKE_NOW, past the 60m threshold
    });
    await writeTicket(paths, ticket);
    await rebuildIndex(paths);

    const fakeNow = { SLOP_STATUS_FAKE_NOW: "2026-07-23T10:00:00.000Z" };
    const expectedHandle = shortTicketCode(ticket.id);

    const human = runSlop(["status"], paths.root, fakeNow);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain("Stale (1):");
    expect(human.stdout).toContain(`(${expectedHandle})`);

    const json = runSlop(["status", "--json"], paths.root, fakeNow);
    const body = JSON.parse(json.stdout) as {
      stale: { id: string; slug: string; name: string; state: string }[];
    };
    // Exactly the 4 documented fields — no `handle` here (deliberately;
    // tests/acceptance/D4.test.ts and C5.test.ts pin this exact shape
    // with `toEqual`, outside this ticket's edit allowlist to update).
    expect(body.stale).toEqual([
      { id: ticket.id, slug: ticket.slug, name: ticket.name, state: "in_progress" },
    ]);
  });

  it("empty repo: no crash, no stray handle text", async () => {
    const paths = await makeScratchRepo("slop-status-handle-empty-");
    const result = runSlop(["status"], paths.root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no tickets yet");
  });
});

// ---------------------------------------------------------------------------
// In-process coverage of `runStatus` (real v8 coverage, no subprocess).
// ---------------------------------------------------------------------------

async function jsonNewTicket(root: string, name: string): Promise<TicketId> {
  const out = captureOutput();
  try {
    await withCwd(root, () => runNew(name, { blocks: [], relatesTo: [], label: [], json: true }));
    return (JSON.parse(out.stdout()) as { id: TicketId }).id;
  } finally {
    out.restore();
  }
}

const originalFakeNow = process.env.SLOP_STATUS_FAKE_NOW;
afterEach(() => {
  if (originalFakeNow === undefined) delete process.env.SLOP_STATUS_FAKE_NOW;
  else process.env.SLOP_STATUS_FAKE_NOW = originalFakeNow;
});

describe("runStatus (in-process)", () => {
  it("empty repo: prints the no-tickets hint", async () => {
    const root = await makeTempRepo("slop-status-inproc-empty-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    const out = captureOutput();
    try {
      await withCwd(root, () => runStatus({}));
      expect(out.stdout().toLowerCase()).toContain("no tickets yet");
    } finally {
      out.restore();
    }
  });

  it("counts by state, and an in_progress ticket's session/actor/harness", async () => {
    const root = await makeTempRepo("slop-status-inproc-counts-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "In-progress status ticket");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runStatus({ json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      counts: { in_progress: number; total: number };
      in_progress: { id: string; session: { actor: string } | null }[];
    };
    expect(body.counts.total).toBe(1);
    expect(body.counts.in_progress).toBe(1);
    expect(body.in_progress[0]?.id).toBe(id);
    expect(body.in_progress[0]?.session?.actor).toBe("ryan");
  });

  it("a review-state ticket surfaces its MR link", async () => {
    const root = await makeTempRepo("slop-status-inproc-review-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Review status ticket");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }
    const reviewOut = captureOutput();
    try {
      await withCwd(root, () => runReview(id, { mr: "https://example.com/pr/9" }));
    } finally {
      reviewOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runStatus({ json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      review: { id: string; mr: string | null }[];
    };
    expect(body.review).toHaveLength(1);
    expect(body.review[0]?.mr).toBe("https://example.com/pr/9");
  });

  it("SLOP_STATUS_FAKE_NOW pins the clock: a session started long ago reads as stale", async () => {
    const root = await makeTempRepo("slop-status-inproc-stale-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Soon-to-be-stale ticket");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }

    // Default stale_after is 60m (DEFAULT_STALE_AFTER) — pin "now" far
    // enough past session start that the ticket must read as stale.
    process.env.SLOP_STATUS_FAKE_NOW = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
    const out = captureOutput();
    try {
      await withCwd(root, () => runStatus({ json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { stale: { id: string; state: string }[] };
    expect(body.stale).toEqual([
      { id, slug: expect.any(String), name: expect.any(String), state: "in_progress" },
    ]);
  });

  it("--budget bounds output without corrupting --json", async () => {
    const root = await makeTempRepo("slop-status-inproc-budget-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await jsonNewTicket(root, "Budgeted status ticket 1");
    await jsonNewTicket(root, "Budgeted status ticket 2");

    const out = captureOutput();
    try {
      await withCwd(root, () => runStatus({ json: true, budget: 1 }));
    } finally {
      out.restore();
    }
    expect(() => JSON.parse(out.stdout())).not.toThrow();
  });

  it("human view renders counts/in-progress/review/stale sections", async () => {
    const root = await makeTempRepo("slop-status-inproc-human-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await jsonNewTicket(root, "Human view ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runStatus({}));
      expect(out.stdout()).toContain("Slopwork status");
      expect(out.stdout()).toContain("In progress (0");
      expect(out.stdout()).toContain("Awaiting review (0");
      expect(out.stdout()).toContain("Stale (0)");
    } finally {
      out.restore();
    }
  });
});
