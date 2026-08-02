import { describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { type SessionId, type TicketId, EXIT_CODES } from "../../core/index.js";
import { queryEvents, repoPaths } from "../../repo/index.js";
import { runAsk } from "./ask.js";
import { runList } from "./list.js";
import { runNew } from "./new.js";
import { runStart } from "./start.js";

// In-process coverage of `runAsk` (G4, t-jggg9) — real v8 coverage, no
// subprocess. Acceptance-level (spawned-binary) coverage already lives in
// tests/acceptance/G4.test.ts; this file exercises `runAsk` directly so
// `src/cli/commands/ask.ts` isn't 0%-covered.

async function jsonNewTicket(root: string, name: string): Promise<{ id: TicketId; slug: string }> {
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
    return JSON.parse(out.stdout()) as { id: TicketId; slug: string };
  } finally {
    out.restore();
  }
}

async function jsonStartTicket(root: string, id: TicketId): Promise<SessionId> {
  const out = captureOutput();
  try {
    await withCwd(root, () => runStart(id, { harness: "codex", json: true }));
    return (JSON.parse(out.stdout()) as { session: { id: SessionId } }).session.id;
  } finally {
    out.restore();
  }
}

describe("runAsk (in-process)", () => {
  it("human text: prints the question id, the ticket, and the answer hint", async () => {
    const root = await makeTempRepo("slop-ask-inproc-text-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t = await jsonNewTicket(root, "Ask target ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runAsk(t.id, "Which approach should we take?", { option: [] }));
    } finally {
      out.restore();
    }
    expect(out.stdout()).toContain("asked event_");
    expect(out.stdout()).toContain(t.slug);
    expect(out.stdout()).toContain("Which approach should we take?");
    expect(out.stdout()).toContain("slop answer");
  });

  it("--json prints a machine-readable question result and --option is repeatable", async () => {
    const root = await makeTempRepo("slop-ask-inproc-json-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t = await jsonNewTicket(root, "Ask json ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runAsk(t.id, "Pick one", { option: ["a", "b", ""], json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      question: { id: string; ticket: { id: string }; text: string; options: string[] };
    };
    expect(body.question.ticket.id).toBe(t.id);
    expect(body.question.text).toBe("Pick one");
    // A blank option is dropped, not rejected (harmless no-op, matching
    // update --label's tolerance for a fully-redundant flag).
    expect(body.question.options).toEqual(["a", "b"]);
  });

  it("marks the ticket awaiting_input (visible via `slop list`)", async () => {
    const root = await makeTempRepo("slop-ask-inproc-awaiting-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t = await jsonNewTicket(root, "Ask awaiting-input ticket");

    const askOut = captureOutput();
    try {
      await withCwd(root, () => runAsk(t.id, "Still open?", { option: [] }));
    } finally {
      askOut.restore();
    }

    const listOut = captureOutput();
    try {
      await withCwd(root, () => runList(undefined, { state: [], label: [], json: true }));
    } finally {
      listOut.restore();
    }
    const body = JSON.parse(listOut.stdout()) as {
      tickets: { id: string; awaiting_input: boolean }[];
    };
    expect(body.tickets.find((row) => row.id === t.id)?.awaiting_input).toBe(true);
  });

  it("attributes the lock-free question event to the resolved ticket's active session", async () => {
    const root = await makeTempRepo("slop-ask-inproc-session-context-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t = await jsonNewTicket(root, "Active question ticket");
    const session = await jsonStartTicket(root, t.id);

    const out = captureOutput();
    try {
      await withCwd(root, () => runAsk(t.id, "Question in this session?", { option: [] }));
    } finally {
      out.restore();
    }

    const asked = (await queryEvents(repoPaths(root), { ticket: t.id })).find(
      (event) => event.verb === "question.asked",
    );
    expect(asked?.session).toBe(session);
  });

  it("rejects an empty question as a USAGE_ERROR", async () => {
    const root = await makeTempRepo("slop-ask-inproc-empty-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const t = await jsonNewTicket(root, "Ask empty-question ticket");

    await expect(withCwd(root, () => runAsk(t.id, "   ", { option: [] }))).rejects.toMatchObject({
      exitCode: EXIT_CODES.USAGE_ERROR,
    });
  });

  it("throws NOT_FOUND for an unresolvable ticket ref", async () => {
    const root = await makeTempRepo("slop-ask-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    await expect(
      withCwd(root, () => runAsk("no-such-ticket", "Question?", { option: [] })),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
  });
});
