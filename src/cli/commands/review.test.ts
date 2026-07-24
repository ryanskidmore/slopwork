import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { fixedClock } from "../../core/clock.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import { newSessionId, newTicketId, ticketSchema } from "../../core/index.js";
import type { Ticket, TicketId } from "../../core/index.js";
import { readTicket, repoPaths } from "../../repo/index.js";
import { buildReviewedTicket, runReview } from "./review.js";
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
    state: "in_progress",
    active_session: newSessionId(),
    root_id: id,
    provenance: { method: "new", created_by: actor },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

describe("buildReviewedTicket", () => {
  const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

  it("moves state to review and sets review.requested_at/by", () => {
    const ticket = makeTicket();
    const reviewed = buildReviewedTicket(ticket, "https://example.com/pr/1", actor, clock);
    expect(reviewed.state).toBe("review");
    expect(reviewed.review).toEqual({
      mr: "https://example.com/pr/1",
      requested_at: "2026-07-23T12:00:00.000Z",
      by: actor,
    });
  });

  it("review.mr is undefined (not a URL) when no --mr was given — D15 required-with-warning", () => {
    const ticket = makeTicket();
    const reviewed = buildReviewedTicket(ticket, undefined, actor, clock);
    expect(reviewed.state).toBe("review");
    expect(reviewed.review?.mr).toBeUndefined();
  });

  it("bumps last_activity_at/updated_at", () => {
    const ticket = makeTicket({ last_activity_at: "2020-01-01T00:00:00.000Z" });
    const reviewed = buildReviewedTicket(ticket, undefined, actor, clock);
    expect(reviewed.last_activity_at).toBe("2026-07-23T12:00:00.000Z");
    expect(reviewed.updated_at).toBe("2026-07-23T12:00:00.000Z");
  });

  it("leaves active_session untouched — review does not end the session (DECISIONS.md's C3 entry)", () => {
    const ticket = makeTicket();
    const reviewed = buildReviewedTicket(ticket, undefined, actor, clock);
    expect(reviewed.active_session).toBe(ticket.active_session);
  });

  // Stored-XSS regression (ticket_01KY93E2FG20KF5RVW7HRK9M7X): before
  // mrUrlSchema gained its http(s)-only refine, `slop review --mr
  // javascript:alert(1)` passed straight through — bare `z.url()` accepts
  // it — and got persisted into `review.mr`, which `slop web`'s review
  // views then rendered into a live `href`. `buildReviewedTicket` re-parses
  // the candidate ticket through `ticketSchema` (which nests `mrUrlSchema`
  // for `review.mr`), so this is the same guard the CLI's own up-front
  // `--mr` validation in `runReview` uses — proving the fix closes the
  // vector at the CLI layer, not just in the web renderer.
  it("rejects an unsafe MR URL scheme (javascript:/data:/vbscript:)", () => {
    const ticket = makeTicket();
    expect(() => buildReviewedTicket(ticket, "javascript:alert(1)", actor, clock)).toThrow();
    expect(() => buildReviewedTicket(ticket, "data:text/html;base64,QQ==", actor, clock)).toThrow();
    expect(() => buildReviewedTicket(ticket, "vbscript:msgbox(1)", actor, clock)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// In-process coverage of `runReview` (real v8 coverage, no subprocess).
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

async function startTicket(root: string, id: TicketId): Promise<void> {
  const out = captureOutput();
  try {
    await withCwd(root, () => runStart(id, {}));
  } finally {
    out.restore();
  }
}

describe("runReview (in-process)", () => {
  it("moves an in_progress ticket to review with an --mr link", async () => {
    const root = await makeTempRepo("slop-review-inproc-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "In-progress ticket to review");
    await startTicket(root, id);

    // cli-harness.ts's withCwd deterministically scrubs every
    // harness-identity env var (harness `other`, matching CI), so a
    // captureTranscript call with no --transcript given would otherwise
    // ALWAYS produce a "could not locate a transcript" warning on stderr
    // here — pass a real --transcript file so this test's stderr-is-empty
    // assertion below stays a meaningful "the whole review call, including
    // transcript capture, succeeded cleanly" check rather than a vacuous
    // one that merely tolerates that warning.
    const transcriptFile = join(root, "transcript.jsonl");
    await writeFile(transcriptFile, '{"turn":"review"}\n', "utf8");

    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runReview(id, {
          mr: "https://example.com/org/repo/pull/1",
          transcript: transcriptFile,
        }),
      );
      expect(out.stdout()).toContain("moved to review");
      expect(out.stdout()).toContain("mr: https://example.com/org/repo/pull/1");
      expect(out.stderr()).toBe("");
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    const ticket = await readTicket(paths, id);
    expect(ticket.state).toBe("review");
    expect(ticket.review?.mr).toBe("https://example.com/org/repo/pull/1");
  });

  // closing-loop-commands-lack-json
  it("--json returns a stable, machine-readable shape and keeps stdout clean JSON", async () => {
    const root = await makeTempRepo("slop-review-inproc-json-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "JSON review ticket");
    await startTicket(root, id);

    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runReview(id, { mr: "https://example.com/org/repo/pull/5", json: true }),
      );
      const body = JSON.parse(out.stdout()) as {
        id: TicketId;
        slug: string;
        handle: string;
        name: string;
        state: string;
        review: { mr: string | null; requested_at: string; by: unknown } | null;
        transcript: string | null;
        already_in_review: boolean;
      };
      expect(body.id).toBe(id);
      expect(body.state).toBe("review");
      expect(body.review?.mr).toBe("https://example.com/org/repo/pull/5");
      expect(body.already_in_review).toBe(false);
      expect(body.handle).toMatch(/^t-/);
    } finally {
      out.restore();
    }
  });

  it("nags on stderr (but still succeeds) when --mr is omitted", async () => {
    const root = await makeTempRepo("slop-review-inproc-nomr-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "No-mr review ticket");
    await startTicket(root, id);

    const out = captureOutput();
    try {
      await withCwd(root, () => runReview(id, {}));
      expect(out.stderr()).toMatch(/no --mr given/);
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).state).toBe("review");
  });

  it("rejects a malformed --mr URL up front (USAGE_ERROR, exit 2), with zero side effects", async () => {
    const root = await makeTempRepo("slop-review-inproc-badmr-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Bad mr review ticket");
    await startTicket(root, id);

    await expect(
      withCwd(root, () => runReview(id, { mr: "javascript:alert(1)" })),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.USAGE_ERROR });

    const paths = repoPaths(root);
    // Zero side effects: the ticket is untouched (still in_progress).
    expect((await readTicket(paths, id)).state).toBe("in_progress");
  });

  it("ticket_01KYAPKRY7XZJ8D8E5V6X5M2QC: a SECOND bare review (no --mr) on an already-review-state ticket is rejected (CONFLICT) WITHOUT overwriting the transcript the FIRST review already captured", async () => {
    const root = await makeTempRepo("slop-review-inproc-double-no-mutate-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Double-review ticket, must not mutate transcript");
    await startTicket(root, id);

    const firstTranscript = join(root, "first-review-transcript.jsonl");
    await writeFile(firstTranscript, '{"round":"first"}\n', "utf8");
    const firstOut = captureOutput();
    try {
      await withCwd(root, () =>
        runReview(id, { mr: "https://example.com/org/repo/pull/1", transcript: firstTranscript }),
      );
    } finally {
      firstOut.restore();
    }

    const paths = repoPaths(root);
    const ticketAfterFirst = await readTicket(paths, id);
    const sessionId = ticketAfterFirst.active_session;
    if (sessionId === null)
      throw new Error("unreachable: review-state ticket has no active_session");
    const transcriptPath = join(paths.slopDir, "transcripts", `${sessionId}.jsonl`);
    const contentAfterFirst = await readFile(transcriptPath, "utf8");
    expect(contentAfterFirst).toBe('{"round":"first"}\n');

    // A SECOND, BARE review (no --mr) on the SAME (now review-state) ticket
    // — checkReviewEntry rejects a bare `review -> review` (D15: nothing to
    // update without a link to attach; review-no-mr-nag-advises made `--mr`
    // given legal here instead, covered by the next test). A real, findable
    // "transcript" that the OLD (pre-fix) code would have unconditionally
    // copied over the FIRST review's file before ever validating that this
    // second review call is illegal.
    const secondTranscript = join(root, "second-review-transcript.jsonl");
    await writeFile(secondTranscript, '{"round":"second-should-never-land"}\n', "utf8");
    const secondOut = captureOutput();
    try {
      await expect(
        withCwd(root, () => runReview(id, { transcript: secondTranscript })),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFLICT });
    } finally {
      secondOut.restore();
    }

    // The fix: the FIRST review's transcript bytes are untouched, and the
    // ticket's MR link is still the first round's — the doomed second
    // review changed nothing.
    const contentAfterSecond = await readFile(transcriptPath, "utf8");
    expect(contentAfterSecond).toBe('{"round":"first"}\n');
    const ticketAfterSecond = await readTicket(paths, id);
    expect(ticketAfterSecond.review?.mr).toBe("https://example.com/org/repo/pull/1");
  });

  // review-no-mr-nag-advises: the no-mr nag (above) advises "re-run once
  // the MR exists" — this proves that advice actually works: a SECOND
  // `review --mr` call on an already-review-state ticket attaches/replaces
  // the MR link instead of hitting checkReviewEntry's CONFLICT rejection.
  it("a SECOND review WITH --mr on an already-review-state ticket updates the MR link (idempotent attach/replace)", async () => {
    const root = await makeTempRepo("slop-review-inproc-mr-attach-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Review ticket getting its MR attached later");
    await startTicket(root, id);

    // First round: enters review with no --mr at all (the exact scenario
    // the nag fires for).
    const firstOut = captureOutput();
    try {
      await withCwd(root, () => runReview(id, {}));
      expect(firstOut.stderr()).toMatch(/no --mr given/);
    } finally {
      firstOut.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).review?.mr).toBeUndefined();

    // Second round: attach the MR now that it exists — exactly what the
    // nag advised, and now legal.
    const secondOut = captureOutput();
    try {
      await withCwd(root, () => runReview(id, { mr: "https://example.com/org/repo/pull/9" }));
      expect(secondOut.stdout()).toContain("MR link updated (already in review)");
      expect(secondOut.stderr()).not.toMatch(/no --mr given/);
    } finally {
      secondOut.restore();
    }

    const ticketAfterSecond = await readTicket(paths, id);
    expect(ticketAfterSecond.state).toBe("review");
    expect(ticketAfterSecond.review?.mr).toBe("https://example.com/org/repo/pull/9");

    // A THIRD call, replacing the link again, also succeeds (idempotent,
    // not one-shot).
    const thirdOut = captureOutput();
    try {
      await withCwd(root, () => runReview(id, { mr: "https://example.com/org/repo/pull/10" }));
    } finally {
      thirdOut.restore();
    }
    expect((await readTicket(paths, id)).review?.mr).toBe("https://example.com/org/repo/pull/10");
  });

  // nags-print-before-validation-review: `mr` is omitted on every call
  // below (the exact shape the no-`--mr` nag used to fire for
  // UNCONDITIONALLY, before validation ever ran) — each asserts `stderr`
  // is empty on the failure path, proving the nag no longer prints when
  // the command then fails.
  it("refuses to review an open (never-started) ticket (CONFLICT, exit 6), printing no no-mr nag", async () => {
    const root = await makeTempRepo("slop-review-inproc-conflict-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Open ticket, never started");

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runReview(id, {}))).rejects.toMatchObject({
        exitCode: EXIT_CODES.CONFLICT,
      });
      expect(out.stderr()).toBe("");
    } finally {
      out.restore();
    }
  });

  // nags-print-before-validation-review: the ticket's own motivating
  // example — `slop review no-such-ticket` (no --mr) used to print the
  // "entering review with no merge/pull request link attached" nag and
  // THEN fail NOT_FOUND, asserting a state change that never happened.
  it("throws NOT_FOUND for an unresolvable ref, printing no no-mr nag", async () => {
    const root = await makeTempRepo("slop-review-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runReview("no-such-ticket", {}))).rejects.toMatchObject({
        exitCode: EXIT_CODES.NOT_FOUND,
      });
      expect(out.stderr()).toBe("");
    } finally {
      out.restore();
    }
  });
});
