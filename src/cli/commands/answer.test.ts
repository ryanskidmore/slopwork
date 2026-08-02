import { describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/index.js";
import { runAnswer } from "./answer.js";
import { runAsk } from "./ask.js";
import { runNew } from "./new.js";

// In-process coverage of `runAnswer` (G4, t-jggg9) — real v8 coverage, no
// subprocess. Acceptance-level (spawned-binary) coverage already lives in
// tests/acceptance/G4.test.ts; this file exercises `runAnswer` directly so
// `src/cli/commands/answer.ts` isn't 0%-covered.

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

describe("runAnswer (in-process)", () => {
  it("human text: prints the question, its ticket, and the answer", async () => {
    const root = await makeTempRepo("slop-answer-inproc-text-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t = await jsonNewTicket(root, "Answer target ticket");
    const q = await jsonAsk(root, t.id, "Which color?");

    const out = captureOutput();
    try {
      await withCwd(root, () => runAnswer(q.id, "Blue", {}));
    } finally {
      out.restore();
    }
    expect(out.stdout()).toContain(`answered ${q.id}`);
    expect(out.stdout()).toContain(t.slug);
    expect(out.stdout()).toContain("Which color?");
    expect(out.stdout()).toContain("Blue");
  });

  it("--json prints {question_id, ticket, answer}", async () => {
    const root = await makeTempRepo("slop-answer-inproc-json-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t = await jsonNewTicket(root, "Answer json ticket");
    const q = await jsonAsk(root, t.id, "Ship it?");

    const out = captureOutput();
    try {
      await withCwd(root, () => runAnswer(q.id, "Yes", { json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      question_id: string;
      ticket: { id: string };
      answer: { text: string };
    };
    expect(body.question_id).toBe(q.id);
    expect(body.ticket.id).toBe(t.id);
    expect(body.answer.text).toBe("Yes");
  });

  it("resolves a unique short prefix of the question id, same as any other ref in this CLI", async () => {
    const root = await makeTempRepo("slop-answer-inproc-prefix-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t = await jsonNewTicket(root, "Answer prefix ticket");
    const q = await jsonAsk(root, t.id, "Prefix question?");
    const prefix = q.id.slice(0, "event_".length + 10);

    const out = captureOutput();
    try {
      await withCwd(root, () => runAnswer(prefix, "Prefix answer", { json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { question_id: string };
    expect(body.question_id).toBe(q.id);
  });

  it("answering an already-answered question is a CONFLICT (exit 6), never a second event", async () => {
    const root = await makeTempRepo("slop-answer-inproc-conflict-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t = await jsonNewTicket(root, "Answer conflict ticket");
    const q = await jsonAsk(root, t.id, "Answer me once?");

    const first = captureOutput();
    try {
      await withCwd(root, () => runAnswer(q.id, "First answer", {}));
    } finally {
      first.restore();
    }

    await expect(withCwd(root, () => runAnswer(q.id, "Second answer", {}))).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFLICT,
    });
  });

  it("rejects an empty answer as a USAGE_ERROR", async () => {
    const root = await makeTempRepo("slop-answer-inproc-empty-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t = await jsonNewTicket(root, "Answer empty-text ticket");
    const q = await jsonAsk(root, t.id, "Empty answer?");

    await expect(withCwd(root, () => runAnswer(q.id, "   ", {}))).rejects.toMatchObject({
      exitCode: EXIT_CODES.USAGE_ERROR,
    });
  });

  it("throws NOT_FOUND for an unresolvable question ref", async () => {
    const root = await makeTempRepo("slop-answer-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    await expect(
      withCwd(root, () => runAnswer("event_01ABCDEFGHIJKLMNOPQRSTUVWX", "Answer", {})),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
  });

  it("an ambiguous short prefix matching more than one question is AMBIGUOUS_REF (exit 5)", async () => {
    const root = await makeTempRepo("slop-answer-inproc-ambiguous-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t = await jsonNewTicket(root, "Answer ambiguous ticket");
    await jsonAsk(root, t.id, "First of two");
    await jsonAsk(root, t.id, "Second of two");

    // "event_" alone is a prefix of every question id in this fixture.
    await expect(withCwd(root, () => runAnswer("event_", "Answer", {}))).rejects.toMatchObject({
      exitCode: EXIT_CODES.AMBIGUOUS_REF,
    });
  });
});
