import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempRepo } from "../support/temp-repo.js";

// web-head-returns-404-despite (part 2): the stale panel (src/web/views/
// stale.ts) sorted and labelled REVIEW tickets by `last_activity_at`
// instead of `review.requested_at` — the exact divergence `isTicketStale`
// (src/web/overlays.ts) itself was already fixed to avoid (see that
// module's own "E1 fix" doc): a review ticket that sits unreviewed, then
// gets one unrelated `update --progress` note (bumping `last_activity_at`
// without addressing the review at all), read as fresher than it really is
// — under-reporting how long the MR had actually waited.
//
// This builds a real repo through the real CLI (init -> new -> start ->
// review -> update --progress, with a short delay between the last two so
// their timestamps are unambiguously different) so `review.requested_at`
// and `last_activity_at` genuinely diverge, then asserts the stale panel's
// displayed/sorted-by timestamp is the review one, not the later one.
// Same real-spawned-server convention as tests/acceptance/D5.test.ts (Bun
// globals aren't available inside vitest test workers).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

function runSlop(args: string[], cwd: string) {
  return spawnSync("bun", [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, SLOP_ACTOR: "web-stale-panel-review-anchor-test" },
  });
}

interface RunningServer {
  proc: ChildProcess;
  baseUrl: string;
}

function startWebServer(cwd: string, timeoutMs = 15_000): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [cliEntry, "web", "--port", "0"], {
      cwd,
      env: { ...process.env, SLOP_ACTOR: "web-stale-panel-review-anchor-test" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error(`timed out waiting for slop web to print a listen URL.\nstderr: ${stderr}`));
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /https?:\/\/127\.0\.0\.1:\d+\//.exec(stdout);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, baseUrl: match[0] });
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`slop web exited early (code ${code}) before printing a URL.\n${stderr}`));
    });
  });
}

async function stopServer(server: RunningServer | undefined): Promise<void> {
  if (!server) return;
  if (server.proc.exitCode !== null || server.proc.signalCode !== null) return;
  server.proc.kill();
  await Promise.race([once(server.proc, "exit"), new Promise((r) => setTimeout(r, 3000))]);
}

let server: RunningServer | undefined;

afterEach(async () => {
  await stopServer(server);
  server = undefined;
});

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

describe("web: stale panel anchors review rows on review.requested_at, not last_activity_at", () => {
  it("labels/sorts a review ticket by requested_at even after a later unrelated progress note", async () => {
    const root = await makeTempRepo("slop-web-stale-review-anchor-");
    const init = runSlop(
      ["init", "--yes", "--project", "stale-anchor-fixture", "--user", "ryan"],
      root,
    );
    expect(init.status, init.stderr).toBe(0);

    // A near-zero review_stale_after so the ticket reads as stale almost
    // immediately, regardless of real wall-clock timing.
    const configPath = join(root, ".slop", "config.yaml");
    const configText = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      configText.replace(/review_stale_after:\s*\S+/, "review_stale_after: 1ms"),
      "utf8",
    );

    const created = runSlop(["new", "Ticket with a rotting review"], root);
    expect(created.status, created.stderr).toBe(0);
    const m = CREATED_LINE.exec(created.stdout);
    if (!m?.[2]) throw new Error(`could not parse created ticket:\n${created.stdout}`);
    const slug = m[2];

    const started = runSlop(["start", slug], root);
    expect(started.status, started.stderr).toBe(0);

    const reviewed = runSlop(
      ["review", slug, "--mr", "https://github.com/ryan/slopwork-fixture/pull/1"],
      root,
    );
    expect(reviewed.status, reviewed.stderr).toBe(0);

    // Ensure a real, unambiguous gap between requested_at and the next
    // event's timestamp (ISO-with-milliseconds — anything sub-millisecond
    // apart could theoretically collide).
    await new Promise((r) => setTimeout(r, 50));

    const updated = runSlop(
      ["update", slug, "--progress", "unrelated note, not a review action"],
      root,
    );
    expect(updated.status, updated.stderr).toBe(0);

    const shown = runSlop(["show", slug, "--json"], root);
    expect(shown.status, shown.stderr).toBe(0);
    const parsed = JSON.parse(shown.stdout) as {
      ticket: { review?: { requested_at?: string }; last_activity_at: string };
    };
    const requestedAt = parsed.ticket.review?.requested_at;
    const lastActivityAt = parsed.ticket.last_activity_at;
    if (!requestedAt) throw new Error("ticket has no review.requested_at — test setup is wrong");
    // The whole point of this test depends on these genuinely differing.
    expect(lastActivityAt).not.toBe(requestedAt);
    expect(lastActivityAt > requestedAt).toBe(true);

    server = await startWebServer(root);
    const res = await fetch(new URL("/api/stale", server.baseUrl));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ ticket: { name: string }; since: string }>;
    };

    const row = body.rows.find((r) => r.ticket.name === "Ticket with a rotting review");
    expect(row, "expected the rotting-review ticket on /api/stale").toBeDefined();
    // The idle-duration anchor must be review.requested_at...
    expect(row?.since).toBe(requestedAt);
    // ...never the later, unrelated last_activity_at.
    expect(row?.since).not.toBe(lastActivityAt);
  });
});
