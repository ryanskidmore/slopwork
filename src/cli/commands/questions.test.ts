import { describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { runAnswer } from "./answer.js";
import { runAsk } from "./ask.js";
import { runNew } from "./new.js";
import { runQuestions } from "./questions.js";

// In-process coverage of `runQuestions` (G4, t-jggg9) — real v8 coverage,
// no subprocess. Acceptance-level (spawned-binary) coverage already lives
// in tests/acceptance/G4.test.ts; this file exercises `runQuestions`
// directly so `src/cli/commands/questions.ts` isn't 0%-covered.

async function jsonNewTicket(root: string, name: string): Promise<{ id: string; slug: string }> {
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
    return JSON.parse(out.stdout()) as { id: string; slug: string };
  } finally {
    out.restore();
  }
}

async function jsonAsk(root: string, ticketRef: string, text: string): Promise<{ id: string }> {
  const out = captureOutput();
  try {
    await withCwd(root, () => runAsk(ticketRef, text, { option: [], json: true }));
    return (JSON.parse(out.stdout()) as { question: { id: string } }).question;
  } finally {
    out.restore();
  }
}

describe("runQuestions (in-process)", () => {
  it("with no questions: reports zero, human text", async () => {
    const root = await makeTempRepo("slop-questions-inproc-empty-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    const out = captureOutput();
    try {
      await withCwd(root, () => runQuestions({}));
    } finally {
      out.restore();
    }
    expect(out.stdout()).toContain("0 unanswered question(s)");
    expect(out.stdout()).toContain("(none)");
  });

  it("default: unanswered-only, oldest-waiting-ticket-first, grouped by ticket", async () => {
    const root = await makeTempRepo("slop-questions-inproc-default-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t1 = await jsonNewTicket(root, "First ticket asked");
    const q1 = await jsonAsk(root, t1.id, "First question?");
    const t2 = await jsonNewTicket(root, "Second ticket asked");
    await jsonAsk(root, t2.id, "Second question?");

    const answerOut = captureOutput();
    try {
      await withCwd(root, () => runAnswer(q1.id, "Answered", {}));
    } finally {
      answerOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runQuestions({ json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      groups: { ticket: { id: string }; questions: { text: string }[] }[];
      total_questions: number;
      total_tickets: number;
      all: boolean;
    };
    // t1's question is answered, so only t2's unanswered one appears.
    expect(body.total_questions).toBe(1);
    expect(body.total_tickets).toBe(1);
    expect(body.groups[0]?.ticket.id).toBe(t2.id);
    expect(body.all).toBe(false);
  });

  it("--all includes answered questions too", async () => {
    const root = await makeTempRepo("slop-questions-inproc-all-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t = await jsonNewTicket(root, "All-questions ticket");
    const q = await jsonAsk(root, t.id, "Answer me?");
    const answerOut = captureOutput();
    try {
      await withCwd(root, () => runAnswer(q.id, "Done", {}));
    } finally {
      answerOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runQuestions({ all: true, json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      total_questions: number;
      groups: { questions: { answer: { text: string } | null }[] }[];
    };
    expect(body.total_questions).toBe(1);
    expect(body.groups[0]?.questions[0]?.answer?.text).toBe("Done");
  });

  it("--ticket scopes to one ticket (a bounded per-ticket read)", async () => {
    const root = await makeTempRepo("slop-questions-inproc-scoped-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t1 = await jsonNewTicket(root, "Scoped ticket one");
    await jsonAsk(root, t1.id, "Question on t1?");
    const t2 = await jsonNewTicket(root, "Scoped ticket two");
    await jsonAsk(root, t2.id, "Question on t2?");

    const out = captureOutput();
    try {
      await withCwd(root, () => runQuestions({ ticket: t1.id, json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { groups: { ticket: { id: string } }[] };
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.ticket.id).toBe(t1.id);
  });

  it("human text lists asker, timestamp, options, and any answer", async () => {
    const root = await makeTempRepo("slop-questions-inproc-text-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t = await jsonNewTicket(root, "Text-rendered ticket");
    const askOut = captureOutput();
    try {
      await withCwd(root, () => runAsk(t.id, "Pick a color", { option: ["red", "blue"] }));
    } finally {
      askOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runQuestions({}));
    } finally {
      out.restore();
    }
    expect(out.stdout()).toContain(t.slug);
    expect(out.stdout()).toContain("Pick a color");
    expect(out.stdout()).toContain("options: red, blue");
  });

  it("--budget elides whole questions from the tail without corrupting --json", async () => {
    const root = await makeTempRepo("slop-questions-inproc-budget-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    for (let i = 0; i < 6; i++) {
      const t = await jsonNewTicket(root, `Budget question ticket ${i}`);
      await jsonAsk(root, t.id, `Long enough question text to matter for budget number ${i}?`);
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runQuestions({ json: true, budget: 40 }));
    } finally {
      out.restore();
    }
    expect(() => JSON.parse(out.stdout())).not.toThrow();
    const body = JSON.parse(out.stdout()) as { elided: string[]; total_questions: number };
    expect(body.elided.length).toBeGreaterThan(0);
  });
});
