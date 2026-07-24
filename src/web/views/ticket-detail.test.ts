import { type ChildProcess, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { newTicketId, ticketSchema } from "../../core/index.js";
import type { Ticket } from "../../core/index.js";
import { renderMrLink, renderResolutionSection } from "./ticket-detail.js";

// Stored-XSS regression (ticket_01KY93E2FG20KF5RVW7HRK9M7X): before this
// fix, ticket-detail.ts interpolated `ticket.review.mr` straight into a
// live `href` (`html\`<a href="${ticket.review.mr}">...\``) — `escapeHtml`
// neutralises HTML metacharacters but never inspects the URL scheme, so a
// `javascript:`/`data:`/`vbscript:` MR link executed the moment a human
// opened the ticket page. `mrUrlSchema` now blocks those schemes at write
// time, but `renderMrLink` is the render-time backstop for anything
// already on disk from before that guard existed.
describe("renderMrLink", () => {
  it("renders a safe https MR URL as a live, escaped href", () => {
    const out = renderMrLink("https://github.com/org/repo/pull/1");
    expect(out.raw).toContain('href="https://github.com/org/repo/pull/1"');
    expect(out.raw).toContain("<a ");
  });

  it("falls back to inert text — no href at all — for a javascript: MR URL", () => {
    const out = renderMrLink("javascript:alert(document.cookie)");
    expect(out.raw).not.toMatch(/href="javascript:/i);
    expect(out.raw).not.toContain("<a ");
    expect(out.raw).toContain("javascript:alert(document.cookie)"); // still shown, just as text
  });

  it("falls back to inert text for a data: MR URL", () => {
    const out = renderMrLink("data:text/html;base64,QQ==");
    expect(out.raw).not.toMatch(/src="data:|href="data:/i);
    expect(out.raw).not.toContain("<a ");
  });

  it("shows the no-MR-link placeholder when mr is undefined", () => {
    const out = renderMrLink(undefined);
    expect(out.raw).toContain("No MR link yet");
    expect(out.raw).not.toContain("<a ");
  });
});

// `resolution` (ticket_01KY9RWFGVDQNDH1XN43A0GH1M): rendered through the
// same markdown+sanitizeMarkdownHtml path as spec.details_md — never a raw
// interpolation.
function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: "a-ticket",
    spec: { summary: "Do the thing" },
    state: "done",
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

// This one case never calls `renderMarkdownToString` (it short-circuits on
// an empty/whitespace-only source before ever touching `Bun.markdown`), so
// — unlike every other case below — it's safe to exercise directly inside
// vitest. See the describe block below for why the rest can't be.
describe("renderResolutionSection — absent resolution", () => {
  it("renders nothing when resolution is absent", () => {
    const ticket = makeTicket();
    const out = renderResolutionSection(ticket);
    expect(out.raw).toBe("");
    expect(out.raw).not.toContain("Resolution");
  });
});

// ---------------------------------------------------------------------------
// Everything else about `renderResolutionSection` — the actual markdown
// rendering and its XSS guard — is exercised as a real, black-box HTTP
// request against a real spawned `bun`/source `slop web` process instead of
// calling `renderResolutionSection` in-process, for the exact reason
// tests/acceptance/D5.test.ts's header comment documents at length: a
// non-empty `resolution` makes `renderResolutionSection` call
// `renderMarkdownToString`, which calls `Bun.markdown.html()` —
// a Bun-only global that is **not available inside vitest's test workers**
// (they run as plain Node.js processes even when the vitest CLI itself was
// launched via `bun run test` — verified directly: `Bun` is `undefined`
// there). `markdown.test.ts` covers the pure post-processing step
// (`sanitizeMarkdownHtml`) vitest *can* run; this covers the real thing,
// end to end, the same way D5.test.ts does for the rest of `slop web`.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

function runSlop(args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync("bun", [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, SLOP_ACTOR: "ticket-detail-test-actor" },
  });
}

interface RunningServer {
  proc: ChildProcess;
  baseUrl: string;
}

/** Spawn `slop web --port 0` and wait for it to print its listen URL —
 * same polling shape as D5.test.ts's `spawnAndWaitForUrl`, kept local
 * rather than imported since tests/acceptance isn't reusable from here. */
function startWebServer(cwd: string, timeoutMs = 15_000): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [cliEntry, "web", "--port", "0"], {
      cwd,
      env: { ...process.env, SLOP_ACTOR: "ticket-detail-test-actor" },
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

const scratchDirs: string[] = [];
let server: RunningServer | undefined;

afterEach(async () => {
  await stopServer(server);
  server = undefined;
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

async function makeTicketWithResolution(
  resolution: string | undefined,
): Promise<{ id: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "slop-ticket-detail-web-test-"));
  scratchDirs.push(root);
  const init = runSlop(
    ["init", "--yes", "--project", "ticket-detail-fixture", "--user", "ryan"],
    root,
  );
  expect(init.status, init.stderr).toBe(0);

  const created = runSlop(["new", "Investigation ticket"], root);
  expect(created.status, created.stderr).toBe(0);
  const m = CREATED_LINE.exec(created.stdout);
  if (!m?.[1] || !m[2]) throw new Error(`could not parse created ticket:\n${created.stdout}`);
  const [, id, slug] = m;

  const started = runSlop(["start", slug as string], root);
  expect(started.status, started.stderr).toBe(0);

  const doneArgs = ["done", slug as string, "--note", "done"];
  if (resolution !== undefined) doneArgs.push("--outcome", resolution);
  const done = runSlop(doneArgs, root);
  expect(done.status, done.stderr).toBe(0);

  return { id: id as string, root };
}

describe("renderResolutionSection — end to end via a real spawned `slop web` server", () => {
  it(
    "renders markdown formatting, keeps a safe https link live, and neutralises both a " +
      "javascript: link and raw HTML embedded in the resolution",
    async () => {
      const resolution = [
        "## Findings",
        "",
        "Root cause was **X**.",
        "",
        "- step one",
        "- step two",
        "",
        "[click me](javascript:alert(document.cookie))",
        "",
        "[safe link](https://example.com/pr/1)",
        "",
        '<img src=x onerror="alert(1)">plain text after',
      ].join("\n");

      const { id, root } = await makeTicketWithResolution(resolution);
      server = await startWebServer(root);
      const res = await fetch(new URL(`tickets/${id}`, server.baseUrl));
      expect(res.status).toBe(200);
      const body = await res.text();

      // Rendered inside a clearly-labeled section.
      expect(body).toContain("<h2>Resolution</h2>");

      // Markdown formatting actually rendered, not shown as literal source.
      expect(body).toContain("Findings");
      expect(body).toContain("<strong>X</strong>");
      expect(body).toContain("<li>step one</li>");

      // Safe https link survives as a live href.
      expect(body).toContain('href="https://example.com/pr/1"');

      // javascript: link neutralised — no live href, text still shown.
      expect(body).not.toMatch(/href="javascript:/i);
      expect(body).toContain("click me");

      // Raw HTML neutralised (Bun.markdown's noHtmlBlocks/noHtmlSpans
      // escape it rather than passing it through) — never a live <img> tag
      // with an onerror handler; shown as inert, HTML-escaped text instead,
      // and the surrounding text still shows.
      expect(body).not.toContain("<img src=x onerror");
      expect(body).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
      expect(body).toContain("plain text after");
    },
  );

  it("omits the Resolution section entirely when the ticket has none", async () => {
    const { id, root } = await makeTicketWithResolution(undefined);
    server = await startWebServer(root);
    const res = await fetch(new URL(`tickets/${id}`, server.baseUrl));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("<h2>Resolution</h2>");
  });
});
