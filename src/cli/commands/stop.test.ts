import { describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import { END_SUMMARY_MAX_LENGTH } from "../../core/index.js";
import type { TicketId } from "../../core/index.js";
import { readTicket, repoPaths } from "../../repo/index.js";
import { runNew } from "./new.js";
import { runReview } from "./review.js";
import { runStart } from "./start.js";
import { runStop } from "./stop.js";

// ---------------------------------------------------------------------------
// In-process coverage of `runStop` (real v8 coverage, no subprocess).
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

describe("runStop (in-process)", () => {
  it("stops an in_progress session, returning the ticket to open with a handoff note", async () => {
    const root = await makeTempRepo("slop-stop-inproc-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "In-progress ticket to stop");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runStop(id, { note: "handing off, see notes" }));
      expect(out.stdout()).toContain("handoff note: handing off, see notes");
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    const ticket = await readTicket(paths, id);
    expect(ticket.state).toBe("open");
    expect(ticket.active_session).toBeNull();
  });

  // closing-loop-commands-lack-json
  it("--json returns a stable, machine-readable shape and keeps stdout clean JSON", async () => {
    const root = await makeTempRepo("slop-stop-inproc-json-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "JSON stop ticket");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runStop(id, { note: "handoff via json", json: true }));
      const body = JSON.parse(out.stdout()) as {
        ticket: { id: string; slug: string; handle: string; name: string; state: string };
        session: { id: string; note: string | null };
      };
      // json-shapes-are-inconsistent-across: ticket and session are nested, so
      // `ticket.id` means the same thing here as it does in `start --json`.
      expect(body.ticket.id).toBe(id);
      expect(body.ticket.state).toBe("open");
      expect(body.ticket.handle).toMatch(/^t-/);
      expect(body.session.note).toBe("handoff via json");
      expect(body.session.id).toMatch(/^session_/);
    } finally {
      out.restore();
    }
  });

  it("ticket_01KYAPN9NXY6RPSV6WGR42CJHJ: warns on stderr (but still succeeds) when the acting actor differs from who started the session", async () => {
    const root = await makeTempRepo("slop-stop-inproc-ownership-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Ownership-mismatch stop ticket");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {})); // started as "ryan" (config user:)
    } finally {
      startOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runStop(id, { note: "someone else's handoff" }), {
        SLOP_ACTOR: "someone-else",
      });
      expect(out.stderr()).toContain("someone-else");
      expect(out.stderr()).toContain("ryan");
      expect(out.stderr()).toMatch(/session ownership/i);
      // Never a block — the stop itself still succeeded.
      expect(out.stdout()).toContain("stopped");
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).state).toBe("open");
  });

  it("warns on stderr when --note is omitted, but still succeeds", async () => {
    const root = await makeTempRepo("slop-stop-inproc-nonote-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "No-note stop ticket");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runStop(id, {}));
      expect(out.stderr()).toMatch(/no --note handoff given/);
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).state).toBe("open");
  });

  // nags-print-before-validation-review: `{}` (no --note) is the exact
  // shape the no-`--note` nag used to fire for UNCONDITIONALLY, before
  // `assertStoppable` ever ran — this asserts stderr stays empty on the
  // failure path.
  it("refuses to stop a ticket with no active session (CONFLICT-shaped assertStoppable failure), printing no no-note nag", async () => {
    const root = await makeTempRepo("slop-stop-inproc-noactive-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Never started ticket");

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runStop(id, {}))).rejects.toThrow();
      expect(out.stderr()).toBe("");
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).state).toBe("open");
  });

  it("ticket_01KYAPKRY7XZJ8D8E5V6X5M2QC: refuses a review-state ticket (CONFLICT) with zero side effects", async () => {
    const root = await makeTempRepo("slop-stop-inproc-review-no-mutate-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Review-state ticket, stop must refuse");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }
    const reviewOut = captureOutput();
    try {
      await withCwd(root, () => runReview(id, {}));
    } finally {
      reviewOut.restore();
    }

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runStop(id, {}))).rejects.toMatchObject({
        exitCode: EXIT_CODES.CONFLICT,
      });
      // nags-print-before-validation-review: no --note was given either —
      // the no-`--note` nag must not print alongside this CONFLICT.
      expect(out.stderr()).toBe("");
    } finally {
      out.restore();
    }

    // The ticket/session state truly is untouched — still review, same
    // active session, exactly as `review` left it.
    const paths = repoPaths(root);
    const ticket = await readTicket(paths, id);
    expect(ticket.state).toBe("review");
  });

  // nags-print-before-validation-review: the ticket's own motivating
  // example — `slop stop no-such-ticket` (no --note) used to print the
  // no-`--note` nag and THEN fail NOT_FOUND, asserting a stop that never
  // happened.
  it("throws NOT_FOUND for an unresolvable ref, printing no no-note nag", async () => {
    const root = await makeTempRepo("slop-stop-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runStop("no-such-ticket", {}))).rejects.toMatchObject({
        exitCode: EXIT_CODES.NOT_FOUND,
      });
      expect(out.stderr()).toBe("");
    } finally {
      out.restore();
    }
  });

  it("rejects a --note over the max length with USAGE_ERROR (exit 2), never touching the session/ticket (regression: ticket housekeeping-gitignore-lock-stale)", async () => {
    const root = await makeTempRepo("slop-stop-inproc-toolong-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "In-progress ticket, absurdly long note");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }

    const tooLong = "x".repeat(END_SUMMARY_MAX_LENGTH + 1);
    await expect(withCwd(root, () => runStop(id, { note: tooLong }))).rejects.toMatchObject({
      exitCode: EXIT_CODES.USAGE_ERROR,
    });

    const paths = repoPaths(root);
    const ticket = await readTicket(paths, id);
    expect(ticket.state).toBe("in_progress"); // untouched — rejected before any write
  });
});
