import { describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { fixedClock } from "../../core/clock.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import { newSessionId, newTicketId, ticketSchema } from "../../core/index.js";
import type { Ticket, TicketId } from "../../core/index.js";
import { readTicket, repoPaths } from "../../repo/index.js";
import { buildDroppedTicket, runDrop } from "./drop.js";
import { runNew } from "./new.js";
import { runStart } from "./start.js";

const actor = { name: "ryan", kind: "human" } as const;

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: "a-ticket",
    spec: { summary: "Do the thing" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: actor },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

describe("buildDroppedTicket", () => {
  const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

  it("moves state to dropped, sets latest_note from --reason, clears active_session", () => {
    const ticket = makeTicket({ state: "in_progress", active_session: newSessionId() });
    const dropped = buildDroppedTicket(ticket, "no longer needed", clock);
    expect(dropped.state).toBe("dropped");
    expect(dropped.latest_note).toBe("no longer needed");
    expect(dropped.active_session).toBeNull();
  });

  it("clears review when dropping a review-state ticket", () => {
    const ticket = makeTicket({
      state: "review",
      review: { requested_at: "2026-07-23T09:00:00.000Z", by: actor },
      active_session: newSessionId(),
    });
    const dropped = buildDroppedTicket(ticket, "wontdo", clock);
    expect(dropped.state).toBe("dropped");
    expect(dropped.review).toBeUndefined();
  });

  it("active_session stays null (harmless no-op) when dropping an open/draft ticket with nothing active", () => {
    const ticket = makeTicket({ state: "open", active_session: null });
    const dropped = buildDroppedTicket(ticket, "duplicate of another ticket", clock);
    expect(dropped.active_session).toBeNull();
  });

  it("bumps last_activity_at/updated_at", () => {
    const ticket = makeTicket({ last_activity_at: "2020-01-01T00:00:00.000Z" });
    const dropped = buildDroppedTicket(ticket, "reason", clock);
    expect(dropped.last_activity_at).toBe("2026-07-23T12:00:00.000Z");
    expect(dropped.updated_at).toBe("2026-07-23T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// In-process coverage of `runDrop` (real v8 coverage, no subprocess).
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

describe("runDrop (in-process)", () => {
  it("drops an open ticket with no active session (no session finalize needed)", async () => {
    const root = await makeTempRepo("slop-drop-inproc-open-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Open ticket to drop");

    const out = captureOutput();
    try {
      await withCwd(root, () => runDrop(id, { reason: "duplicate of another ticket" }));
      expect(out.stdout()).toContain(`dropped ${id}`);
      expect(out.stdout()).toContain("reason: duplicate of another ticket");
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    const ticket = await readTicket(paths, id);
    expect(ticket.state).toBe("dropped");
    expect(ticket.latest_note).toBe("duplicate of another ticket");
  });

  it("drops an in_progress ticket, finalizing its active session", async () => {
    const root = await makeTempRepo("slop-drop-inproc-inprogress-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "In-progress ticket to drop");

    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runDrop(id, { reason: "no longer needed" }));
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    const ticket = await readTicket(paths, id);
    expect(ticket.state).toBe("dropped");
    expect(ticket.active_session).toBeNull();
  });

  it("ticket_01KYAPN9NXY6RPSV6WGR42CJHJ: warns on stderr (but still succeeds) when the acting actor differs from who started the session", async () => {
    const root = await makeTempRepo("slop-drop-inproc-ownership-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Ownership-mismatch drop ticket");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {})); // started as "ryan" (config user:)
    } finally {
      startOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runDrop(id, { reason: "someone else's call" }), {
        SLOP_ACTOR: "someone-else",
      });
      expect(out.stderr()).toContain("someone-else");
      expect(out.stderr()).toContain("ryan");
      expect(out.stderr()).toMatch(/session ownership/i);
      // Never a block — drop still succeeded.
      expect(out.stdout()).toContain(`dropped ${id}`);
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).state).toBe("dropped");
  });

  it("no ownership warning when dropping an open ticket with no active session — nothing to compare against", async () => {
    const root = await makeTempRepo("slop-drop-inproc-ownership-noactive-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "No-session drop ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runDrop(id, { reason: "duplicate" }), {
        SLOP_ACTOR: "someone-else",
      });
      expect(out.stderr()).toBe("");
    } finally {
      out.restore();
    }
  });

  it("rejects an empty/whitespace-only --reason with USAGE_ERROR (exit 2), even though Commander alone would let it through", async () => {
    const root = await makeTempRepo("slop-drop-inproc-usage-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Ticket, blank reason");

    await expect(withCwd(root, () => runDrop(id, { reason: "   " }))).rejects.toMatchObject({
      exitCode: EXIT_CODES.USAGE_ERROR,
    });
  });

  it("refuses to drop an already-done ticket (CONFLICT, exit 6)", async () => {
    const root = await makeTempRepo("slop-drop-inproc-conflict-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Already-done ticket");
    const firstDrop = captureOutput();
    try {
      await withCwd(root, () => runDrop(id, { reason: "wontdo" }));
    } finally {
      firstDrop.restore();
    }

    await expect(withCwd(root, () => runDrop(id, { reason: "again" }))).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFLICT,
    });
  });

  it("throws NOT_FOUND for an unresolvable ref", async () => {
    const root = await makeTempRepo("slop-drop-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await expect(
      withCwd(root, () => runDrop("no-such-ticket", { reason: "x" })),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
  });
});
