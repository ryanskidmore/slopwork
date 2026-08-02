import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// G4: elicitations (t-jggg9) — structured questions, awaiting_input
// overlay, questions inbox.
//
// CLI-facing coverage runs against the REAL compiled binary (same
// spawn-a-subprocess convention as G2.test.ts/G3.test.ts); the web-facing
// coverage spawns a real `slop web` server against a repo built through
// the real CLI (same convention as web-stale-panel-review-anchor.test.ts).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

beforeAll(() => {
  if (!existsSync(binaryPath)) {
    execFileSync("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  }
  if (!existsSync(binaryPath)) {
    throw new Error(
      `${binaryPath} is still missing after attempting "bun run build". ` +
        'Run "bun run build" manually and re-run the tests.',
    );
  }
}, 120_000);

const scratchDirs: string[] = [];

afterAll(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function runSlop(args: string[], cwd: string, input?: string) {
  return spawnSync(binaryPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
    input,
  });
}

async function makeScratchRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  const init = runSlop(["init", "--yes", "--project", "g4-fixture", "--user", "g4-tester"], dir);
  if (init.status !== 0) {
    throw new Error(`slop init failed in fixture setup: ${init.stderr}`);
  }
  return dir;
}

interface NewTicketJson {
  id: string;
  slug: string;
  handle: string;
  name: string;
  state: string;
}

function newTicket(dir: string, name: string, ...extraArgs: string[]): NewTicketJson {
  const result = runSlop(["new", name, "--json", ...extraArgs], dir);
  if (result.status !== 0) {
    throw new Error(`slop new "${name}" failed in fixture setup: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as NewTicketJson;
}

interface AskJson {
  question: {
    id: string;
    ticket: { id: string; slug: string; handle: string; name: string; state: string };
    text: string;
    options: string[];
    asked_by: { name: string; kind: string };
    asked_at: string;
  };
}

function ask(dir: string, ref: string, text: string, ...extraArgs: string[]): AskJson {
  const result = runSlop(["ask", ref, text, "--json", ...extraArgs], dir);
  if (result.status !== 0) {
    throw new Error(`slop ask "${ref}" "${text}" failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as AskJson;
}

interface AnswerJson {
  question_id: string;
  ticket: { id: string; slug: string; handle: string; name: string; state: string };
  answer: { id: string; text: string; by: { name: string; kind: string }; answered_at: string };
}

interface ShowJson {
  ticket: {
    id: string;
    slug: string;
    state: string;
    active_session: string | null;
  };
  awaiting_input: {
    open: boolean;
    questions: Array<{
      id: string;
      text: string;
      options: string[];
      asked_by: { name: string; kind: string };
      asked_at: string;
    }>;
  };
}

function show(dir: string, ref: string): ShowJson {
  const result = runSlop(["show", ref, "--json"], dir);
  if (result.status !== 0) {
    throw new Error(`slop show "${ref}" failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as ShowJson;
}

interface EventsJson {
  events: Array<{ id: string; verb: string; payload: Record<string, unknown> }>;
}

function events(dir: string, ref: string): EventsJson {
  const result = runSlop(["events", "--ticket", ref, "--json"], dir);
  if (result.status !== 0) {
    throw new Error(`slop events --ticket "${ref}" failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as EventsJson;
}

describe("G4: elicitations", () => {
  // -------------------------------------------------------------------------
  // ask/answer round-trip, events on the spine
  // -------------------------------------------------------------------------

  describe("slop ask / slop answer", () => {
    it("ask records question.asked; answer records question.answered — both land on the ticket's event spine", async () => {
      const dir = await makeScratchRepo("slop-g4-roundtrip-");
      const ticket = newTicket(dir, "Needs a decision");

      const asked = ask(dir, ticket.id, "Which approach?", "--option", "A", "--option", "B");
      expect(asked.question.text).toBe("Which approach?");
      expect(asked.question.options).toEqual(["A", "B"]);
      expect(asked.question.ticket.id).toBe(ticket.id);
      expect(asked.question.id).toMatch(/^event_/);

      // The ticket is now awaiting_input, with the open question surfaced.
      const shownAfterAsk = show(dir, ticket.id);
      expect(shownAfterAsk.awaiting_input.open).toBe(true);
      expect(shownAfterAsk.awaiting_input.questions).toHaveLength(1);
      expect(shownAfterAsk.awaiting_input.questions[0]?.id).toBe(asked.question.id);
      expect(shownAfterAsk.awaiting_input.questions[0]?.text).toBe("Which approach?");

      // On the spine: a real question.asked event, ticket-scoped.
      const eventsAfterAsk = events(dir, ticket.id);
      const askedEvent = eventsAfterAsk.events.find((e) => e.verb === "question.asked");
      expect(askedEvent).toBeDefined();
      expect(askedEvent?.id).toBe(asked.question.id);
      expect(askedEvent?.payload.text).toBe("Which approach?");
      expect(askedEvent?.payload.options).toEqual(["A", "B"]);

      const answerResult = runSlop(
        ["answer", asked.question.id, "B, because it's simpler.", "--json"],
        dir,
      );
      expect(answerResult.status, answerResult.stderr).toBe(0);
      const answered = JSON.parse(answerResult.stdout) as AnswerJson;
      expect(answered.question_id).toBe(asked.question.id);
      expect(answered.answer.text).toBe("B, because it's simpler.");

      // Answered — no longer awaiting_input.
      const shownAfterAnswer = show(dir, ticket.id);
      expect(shownAfterAnswer.awaiting_input.open).toBe(false);
      expect(shownAfterAnswer.awaiting_input.questions).toEqual([]);

      // On the spine: a real question.answered event referencing the question.
      const eventsAfterAnswer = events(dir, ticket.id);
      const answeredEvent = eventsAfterAnswer.events.find((e) => e.verb === "question.answered");
      expect(answeredEvent).toBeDefined();
      expect(answeredEvent?.payload.question_id).toBe(asked.question.id);
      expect(answeredEvent?.payload.text).toBe("B, because it's simpler.");
    });

    it("answering an already-answered question is a CONFLICT (exit 6), naming who answered and when", async () => {
      const dir = await makeScratchRepo("slop-g4-double-answer-");
      const ticket = newTicket(dir, "Double answer test");
      const asked = ask(dir, ticket.id, "OK to proceed?");

      const first = runSlop(["answer", asked.question.id, "Yes", "--json"], dir);
      expect(first.status, first.stderr).toBe(0);

      const second = runSlop(["answer", asked.question.id, "No, wait"], dir);
      expect(second.status).toBe(6);
      expect(second.stderr).toContain(asked.question.id);
      expect(second.stderr.toLowerCase()).toContain("already answered");
    });

    it("resolves a question by unique short prefix, and rejects an unknown ref as NOT_FOUND", async () => {
      const dir = await makeScratchRepo("slop-g4-prefix-");
      const ticket = newTicket(dir, "Prefix test");
      const asked = ask(dir, ticket.id, "Prefix ok?");

      const shortRef = asked.question.id.slice(0, 12);
      const answered = runSlop(["answer", shortRef, "Yes", "--json"], dir);
      expect(answered.status, answered.stderr).toBe(0);

      const notFound = runSlop(["answer", "event_00000000000000000000000000", "nope"], dir);
      expect(notFound.status).toBe(4);
    });

    it("rejects an empty question/answer as a usage error", async () => {
      const dir = await makeScratchRepo("slop-g4-empty-");
      const ticket = newTicket(dir, "Empty text test");
      const badAsk = runSlop(["ask", ticket.id, "   "], dir);
      expect(badAsk.status).toBe(2);

      const asked = ask(dir, ticket.id, "Real question?");
      const badAnswer = runSlop(["answer", asked.question.id, "  "], dir);
      expect(badAnswer.status).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // slop questions — the inbox
  // -------------------------------------------------------------------------

  describe("slop questions", () => {
    it("default: unanswered only, oldest first, grouped by ticket; --all includes answered; --ticket scopes", async () => {
      const dir = await makeScratchRepo("slop-g4-inbox-");
      const a = newTicket(dir, "Ticket A");
      const b = newTicket(dir, "Ticket B");

      const qA1 = ask(dir, a.id, "A: first question");
      const qA2 = ask(dir, a.id, "A: second question");
      const qB1 = ask(dir, b.id, "B: only question");
      const answerA1 = runSlop(["answer", qA1.question.id, "answered", "--json"], dir);
      expect(answerA1.status, answerA1.stderr).toBe(0);

      // Default: unanswered only — qA1 excluded, qA2/qB1 remain.
      const defaultResult = runSlop(["questions", "--json"], dir);
      expect(defaultResult.status, defaultResult.stderr).toBe(0);
      const defaultBody = JSON.parse(defaultResult.stdout) as {
        groups: Array<{ ticket: { id: string }; questions: Array<{ id: string }> }>;
        total_questions: number;
      };
      expect(defaultBody.total_questions).toBe(2);
      const allOpenIds = defaultBody.groups.flatMap((g) => g.questions.map((q) => q.id));
      expect(allOpenIds.sort()).toEqual([qA2.question.id, qB1.question.id].sort());
      expect(allOpenIds).not.toContain(qA1.question.id);

      // --all: every question, including the answered one.
      const allResult = runSlop(["questions", "--all", "--json"], dir);
      expect(allResult.status, allResult.stderr).toBe(0);
      const allBody = JSON.parse(allResult.stdout) as {
        groups: Array<{
          ticket: { id: string };
          questions: Array<{ id: string; answer: unknown }>;
        }>;
      };
      const allIds = allBody.groups.flatMap((g) => g.questions.map((q) => q.id));
      expect(allIds.sort()).toEqual([qA1.question.id, qA2.question.id, qB1.question.id].sort());
      const answeredRow = allBody.groups
        .flatMap((g) => g.questions)
        .find((q) => q.id === qA1.question.id);
      expect(answeredRow?.answer).not.toBeNull();

      // --ticket scopes to one ticket.
      const scopedResult = runSlop(["questions", "--ticket", a.id, "--json"], dir);
      expect(scopedResult.status, scopedResult.stderr).toBe(0);
      const scopedBody = JSON.parse(scopedResult.stdout) as {
        groups: Array<{ ticket: { id: string }; questions: Array<{ id: string }> }>;
      };
      expect(scopedBody.groups.map((g) => g.ticket.id)).toEqual([a.id]);
      expect(scopedBody.groups[0]?.questions.map((q) => q.id)).toEqual([qA2.question.id]);
    });
  });

  // -------------------------------------------------------------------------
  // awaiting_input in status/list/show
  // -------------------------------------------------------------------------

  describe("awaiting_input surfaced in status/list/show", () => {
    it("slop status gains an Awaiting input section with question count and oldest-question age", async () => {
      const dir = await makeScratchRepo("slop-g4-status-");
      const ticket = newTicket(dir, "Status awaiting-input test");
      const asked = ask(dir, ticket.id, "Status: ok?");

      const result = runSlop(["status", "--json"], dir);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        awaiting_input: Array<{
          id: string;
          open_question_count: number;
          oldest_question_at: string;
        }>;
      };
      const row = body.awaiting_input.find((r) => r.id === ticket.id);
      expect(row).toBeDefined();
      expect(row?.open_question_count).toBe(1);
      expect(row?.oldest_question_at).toBe(asked.question.asked_at);

      const humanResult = runSlop(["status"], dir);
      expect(humanResult.status, humanResult.stderr).toBe(0);
      expect(humanResult.stdout).toContain("Awaiting input (1)");
    });

    it("slop list badges awaiting_input tickets and --awaiting-input filters to just them", async () => {
      const dir = await makeScratchRepo("slop-g4-list-");
      const waiting = newTicket(dir, "Waiting on a human");
      const notWaiting = newTicket(dir, "Not waiting");
      ask(dir, waiting.id, "List: ok?");

      const all = JSON.parse(runSlop(["list", "--json"], dir).stdout) as {
        tickets: Array<{ id: string; awaiting_input: boolean }>;
      };
      const waitingRow = all.tickets.find((t) => t.id === waiting.id);
      const notWaitingRow = all.tickets.find((t) => t.id === notWaiting.id);
      expect(waitingRow?.awaiting_input).toBe(true);
      expect(notWaitingRow?.awaiting_input).toBe(false);

      const filtered = JSON.parse(runSlop(["list", "--awaiting-input", "--json"], dir).stdout) as {
        tickets: Array<{ id: string }>;
      };
      expect(filtered.tickets.map((t) => t.id)).toEqual([waiting.id]);
    });

    it("slop show surfaces open questions prominently in both text and --json output", async () => {
      const dir = await makeScratchRepo("slop-g4-show-text-");
      const ticket = newTicket(dir, "Show text test");
      ask(dir, ticket.id, "Show: which way?", "--option", "left", "--option", "right");

      const textResult = runSlop(["show", ticket.id], dir);
      expect(textResult.status, textResult.stderr).toBe(0);
      expect(textResult.stdout).toContain("AWAITING INPUT");
      expect(textResult.stdout).toContain("Show: which way?");
      expect(textResult.stdout).toContain("left, right");
    });
  });

  // -------------------------------------------------------------------------
  // ready exclusion + --include-awaiting
  // -------------------------------------------------------------------------

  describe("slop ready excludes awaiting_input tickets by default", () => {
    it("an otherwise-ready ticket with an open question is excluded from ready, but included with --include-awaiting", async () => {
      const dir = await makeScratchRepo("slop-g4-ready-");
      const ticket = newTicket(dir, "Ready but awaiting input");
      ask(dir, ticket.id, "Ready: proceed?");

      const defaultResult = runSlop(["ready", "--json"], dir);
      expect(defaultResult.status, defaultResult.stderr).toBe(0);
      const defaultBody = JSON.parse(defaultResult.stdout) as { ready: Array<{ id: string }> };
      expect(defaultBody.ready.map((r) => r.id)).not.toContain(ticket.id);

      const includeResult = runSlop(["ready", "--include-awaiting", "--json"], dir);
      expect(includeResult.status, includeResult.stderr).toBe(0);
      const includeBody = JSON.parse(includeResult.stdout) as { ready: Array<{ id: string }> };
      expect(includeBody.ready.map((r) => r.id)).toContain(ticket.id);
    });
  });

  // -------------------------------------------------------------------------
  // unanswered questions survive stop/start — overlay derives from events,
  // never from session/ticket-file state.
  // -------------------------------------------------------------------------

  describe("awaiting_input survives stop/start (event-derived, not session state)", () => {
    it("a question asked mid-session stays open across stop and a fresh start", async () => {
      const dir = await makeScratchRepo("slop-g4-stop-start-");
      const ticket = newTicket(dir, "Survives stop start");

      expect(runSlop(["start", ticket.id], dir).status).toBe(0);
      const asked = ask(dir, ticket.id, "Mid-session: which config?");
      expect(show(dir, ticket.id).awaiting_input.open).toBe(true);

      const stopped = runSlop(["stop", ticket.id, "--note", "handing off, still deciding"], dir);
      expect(stopped.status, stopped.stderr).toBe(0);
      // Overlay is a pure event fold — stopping the session neither
      // touches nor is required for the question to still read as open.
      expect(show(dir, ticket.id).awaiting_input.open).toBe(true);

      const restarted = runSlop(["start", ticket.id], dir);
      expect(restarted.status, restarted.stderr).toBe(0);
      const stillOpen = show(dir, ticket.id);
      expect(stillOpen.awaiting_input.open).toBe(true);
      expect(stillOpen.awaiting_input.questions[0]?.id).toBe(asked.question.id);

      // Answering it in the new session closes it out normally.
      const answered = runSlop(["answer", asked.question.id, "Use config B", "--json"], dir);
      expect(answered.status, answered.stderr).toBe(0);
      expect(show(dir, ticket.id).awaiting_input.open).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // web: /api/questions route + ticket-detail overlay
  // -------------------------------------------------------------------------

  describe("web: /api/questions and the ticket-detail awaiting_input overlay", () => {
    function runSlopSrc(args: string[], cwd: string) {
      return spawnSync("bun", [cliEntry, ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, SLOP_ACTOR: "g4-web-test" },
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
          env: { ...process.env, SLOP_ACTOR: "g4-web-test" },
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          proc.kill();
          reject(
            new Error(`timed out waiting for slop web to print a listen URL.\nstderr: ${stderr}`),
          );
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
          reject(
            new Error(`slop web exited early (code ${code}) before printing a URL.\n${stderr}`),
          );
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

    it("/api/questions lists an unanswered question grouped by ticket; the ticket-detail overlay flags awaiting_input", async () => {
      const root = await mkdtemp(join(tmpdir(), "slop-g4-web-"));
      scratchDirs.push(root);
      const init = runSlopSrc(
        ["init", "--yes", "--project", "g4-web-fixture", "--user", "ryan"],
        root,
      );
      expect(init.status, init.stderr).toBe(0);

      const created = runSlopSrc(["new", "Web questions fixture", "--json"], root);
      expect(created.status, created.stderr).toBe(0);
      const ticket = JSON.parse(created.stdout) as { id: string; name: string };

      const asked = runSlopSrc(
        [
          "ask",
          ticket.id,
          "Web: which environment?",
          "--option",
          "staging",
          "--option",
          "prod",
          "--json",
        ],
        root,
      );
      expect(asked.status, asked.stderr).toBe(0);
      const question = (JSON.parse(asked.stdout) as AskJson).question;

      server = await startWebServer(root);

      const questionsRes = await fetch(new URL("/api/questions", server.baseUrl));
      expect(questionsRes.status).toBe(200);
      const questionsBody = (await questionsRes.json()) as {
        groups: Array<{
          ticket: { id: string; name: string };
          questions: Array<{ id: string; text: string; options: string[]; answer: unknown }>;
        }>;
        total_questions: number;
      };
      expect(questionsBody.total_questions).toBe(1);
      const group = questionsBody.groups.find((g) => g.ticket.id === ticket.id);
      expect(group).toBeDefined();
      expect(group?.questions[0]?.text).toBe("Web: which environment?");
      expect(group?.questions[0]?.options).toEqual(["staging", "prod"]);
      expect(group?.questions[0]?.answer).toBeNull();

      const detailRes = await fetch(new URL(`/api/tickets/${ticket.id}`, server.baseUrl));
      expect(detailRes.status).toBe(200);
      const detailBody = (await detailRes.json()) as {
        ticket: {
          overlay: {
            awaiting_input: boolean;
            awaiting_input_reason: { open_question_count: number } | null;
          };
        };
        events: Array<{ verb: string; payload: Record<string, unknown> }>;
      };
      expect(detailBody.ticket.overlay.awaiting_input).toBe(true);
      expect(detailBody.ticket.overlay.awaiting_input_reason?.open_question_count).toBe(1);
      expect(detailBody.events.some((e) => e.verb === "question.asked")).toBe(true);

      // Answer it, then confirm both routes reflect the closed question —
      // the ticket-detail server is stateless per-request, so no restart
      // is needed for the change to show up.
      const answered = runSlopSrc(["answer", question.id, "Use staging", "--json"], root);
      expect(answered.status, answered.stderr).toBe(0);

      const questionsAfter = await fetch(new URL("/api/questions", server.baseUrl));
      const questionsAfterBody = (await questionsAfter.json()) as { total_questions: number };
      expect(questionsAfterBody.total_questions).toBe(0);

      const detailAfter = await fetch(new URL(`/api/tickets/${ticket.id}`, server.baseUrl));
      const detailAfterBody = (await detailAfter.json()) as {
        ticket: { overlay: { awaiting_input: boolean } };
      };
      expect(detailAfterBody.ticket.overlay.awaiting_input).toBe(false);
    });
  });
});
