import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
