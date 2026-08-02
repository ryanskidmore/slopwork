import { afterEach, describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import type { TicketId } from "../../core/index.js";
import { shortTicketCode } from "../../core/index.js";
import { runAsk } from "./ask.js";
import { runDone } from "./done.js";
import { runDrop } from "./drop.js";
import { runNew } from "./new.js";
import { runReady } from "./ready.js";
import { runReview } from "./review.js";
import { runStart } from "./start.js";
import { runStop } from "./stop.js";

const originalFakeNow = process.env.SLOP_FAKE_NOW;
afterEach(() => {
  if (originalFakeNow === undefined) delete process.env.SLOP_FAKE_NOW;
  else process.env.SLOP_FAKE_NOW = originalFakeNow;
});

// In-process coverage of `runReady` (real v8 coverage, no subprocess).

async function jsonNewTicket(
  root: string,
  name: string,
  extra: { blocks?: string[]; label?: string[]; parent?: string } = {},
): Promise<TicketId> {
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
        ...extra,
      }),
    );
    return (JSON.parse(out.stdout()) as { id: TicketId }).id;
  } finally {
    out.restore();
  }
}

async function runQuietly(root: string, command: () => Promise<void>): Promise<void> {
  const out = captureOutput();
  try {
    await withCwd(root, command);
  } finally {
    out.restore();
  }
}

describe("runReady (in-process)", () => {
  it("lists open, unblocked tickets", async () => {
    const root = await makeTempRepo("slop-ready-inproc-basic-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Ready ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runReady({ json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { ready: { id: string }[] };
    expect(body.ready.map((r) => r.id)).toContain(id);
  });

  it("lists the deepest actionable leaf, not its direct or transitive umbrella ancestors", async () => {
    const root = await makeTempRepo("slop-ready-inproc-leaf-tree-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const umbrella = await jsonNewTicket(root, "Umbrella");
    const child = await jsonNewTicket(root, "Child", { parent: umbrella });
    const grandchild = await jsonNewTicket(root, "Grandchild", { parent: child });

    const out = captureOutput();
    try {
      await withCwd(root, () => runReady({ json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { ready: { id: string; why: string }[] };
    expect(body.ready.map((row) => row.id)).toEqual([grandchild]);
    expect(body.ready[0]?.why).toContain("no nonterminal descendants");
  });

  it("allows an umbrella once all of its descendants are done or dropped", async () => {
    const root = await makeTempRepo("slop-ready-inproc-terminal-children-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const umbrella = await jsonNewTicket(root, "Terminal children umbrella");
    const doneChild = await jsonNewTicket(root, "Done child", { parent: umbrella });
    const droppedChild = await jsonNewTicket(root, "Dropped child", { parent: umbrella });

    await runQuietly(root, () => runStart(doneChild, {}));
    await runQuietly(root, () => runDone([doneChild], { note: "verified" }));
    await runQuietly(root, () => runDrop([droppedChild], { reason: "not needed" }));

    const out = captureOutput();
    try {
      await withCwd(root, () => runReady({ json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { ready: { id: string }[] };
    expect(body.ready.map((row) => row.id)).toEqual([umbrella]);
  });

  it("does not promote an umbrella when its remaining child is blocked or awaiting input", async () => {
    const root = await makeTempRepo("slop-ready-inproc-unpickable-children-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const blockedUmbrella = await jsonNewTicket(root, "Blocked child umbrella");
    const blockedChild = await jsonNewTicket(root, "Blocked child", { parent: blockedUmbrella });
    const blocker = await jsonNewTicket(root, "Child blocker", { blocks: [blockedChild] });
    const awaitingUmbrella = await jsonNewTicket(root, "Awaiting child umbrella");
    const awaitingChild = await jsonNewTicket(root, "Awaiting child", {
      parent: awaitingUmbrella,
    });
    await runQuietly(root, () => runAsk(awaitingChild, "Which path?", { option: [] }));

    const out = captureOutput();
    try {
      await withCwd(root, () => runReady({ json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { ready: { id: string }[] };
    expect(body.ready.map((row) => row.id)).toEqual([blocker]);

    const included = captureOutput();
    try {
      await withCwd(root, () => runReady({ json: true, includeAwaiting: true }));
    } finally {
      included.restore();
    }
    const includedBody = JSON.parse(included.stdout()) as { ready: { id: string }[] };
    expect(includedBody.ready.map((row) => row.id)).toEqual([blocker, awaitingChild]);
    expect(includedBody.ready.map((row) => row.id)).not.toContain(blockedUmbrella);
    expect(includedBody.ready.map((row) => row.id)).not.toContain(awaitingUmbrella);
  });

  it("omits a stopped resumable umbrella while its child remains nonterminal", async () => {
    const root = await makeTempRepo("slop-ready-inproc-resumable-umbrella-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const umbrella = await jsonNewTicket(root, "Stopped umbrella");
    const child = await jsonNewTicket(root, "Remaining child", { parent: umbrella });
    await runQuietly(root, () => runStart(umbrella, {}));
    await runQuietly(root, () => runStop(umbrella, { note: "child remains" }));

    const out = captureOutput();
    try {
      await withCwd(root, () => runReady({ json: true, resumable: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      ready: { id: string }[];
      resumable: { id: string }[];
    };
    expect(body.ready.map((row) => row.id)).toEqual([child]);
    expect(body.resumable.map((row) => row.id)).not.toContain(umbrella);
  });

  // handle-t-code-missing-from: `ready --json` rows used to omit the short
  // `t-<code>` handle that `new`/`show`/`status` already surface, so an
  // agent picking work from `ready` had no short ref to reuse for `slop
  // start`.
  it("--json rows carry the short t-<code> handle", async () => {
    const root = await makeTempRepo("slop-ready-inproc-handle-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Ready ticket with a handle");

    const out = captureOutput();
    try {
      await withCwd(root, () => runReady({ json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { ready: { id: string; handle: string }[] };
    const row = body.ready.find((r) => r.id === id);
    expect(row?.handle).toBe(shortTicketCode(id));
  });

  it("a blocked ticket does not appear until its blocker is done", async () => {
    const root = await makeTempRepo("slop-ready-inproc-blocked-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const dependent = await jsonNewTicket(root, "Blocked ticket");
    await jsonNewTicket(root, "Blocker ticket", { blocks: [dependent] });

    const out = captureOutput();
    try {
      await withCwd(root, () => runReady({ json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { ready: { id: string }[] };
    expect(body.ready.map((r) => r.id)).not.toContain(dependent);
  });

  it("--label filters to matching tickets only", async () => {
    const root = await makeTempRepo("slop-ready-inproc-label-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const labeled = await jsonNewTicket(root, "Labeled ticket", { label: ["team:infra"] });
    await jsonNewTicket(root, "Unlabeled ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runReady({ json: true, label: ["team:infra"] }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { ready: { id: string }[] };
    expect(body.ready.map((r) => r.id)).toEqual([labeled]);
  });

  it("--resumable includes an in_progress ticket whose session has gone stale (C5), with a `why`", async () => {
    const root = await makeTempRepo("slop-ready-inproc-resumable-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Resumable ticket");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }

    const withoutFlag = captureOutput();
    try {
      await withCwd(root, () => runReady({ json: true }));
      const body = JSON.parse(withoutFlag.stdout()) as { resumable: unknown[] };
      expect(body.resumable).toEqual([]);
    } finally {
      withoutFlag.restore();
    }

    // Default stale_after is 60m — pin "now" far enough past session
    // start that the still-active session reads as stale (C5).
    process.env.SLOP_FAKE_NOW = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
    const out = captureOutput();
    try {
      await withCwd(root, () => runReady({ json: true, resumable: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      resumable_requested: boolean;
      resumable: { id: string; why: string }[];
    };
    expect(body.resumable_requested).toBe(true);
    expect(body.resumable.map((r) => r.id)).toContain(id);
  });

  it("a resumable review-state ticket carries its mr link", async () => {
    const root = await makeTempRepo("slop-ready-inproc-resumable-review-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Resumable review ticket");
    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }
    const reviewOut = captureOutput();
    try {
      await withCwd(root, () => runReview(id, { mr: "https://example.com/pr/1" }));
    } finally {
      reviewOut.restore();
    }

    // Default review_stale_after is 24h — pin "now" far enough past the
    // review request that the still-active session reads as review-stale.
    process.env.SLOP_FAKE_NOW = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const out = captureOutput();
    try {
      await withCwd(root, () => runReady({ json: true, resumable: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { resumable: { id: string; mr?: string | null }[] };
    const row = body.resumable.find((r) => r.id === id);
    expect(row?.mr).toBe("https://example.com/pr/1");
  });

  it("human output prints a hint when nothing is ready", async () => {
    const root = await makeTempRepo("slop-ready-inproc-hint-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    const out = captureOutput();
    try {
      await withCwd(root, () => runReady({}));
      expect(out.stdout()).toContain("nothing ready right now");
    } finally {
      out.restore();
    }
  });

  it("--budget bounds output without corrupting --json", async () => {
    const root = await makeTempRepo("slop-ready-inproc-budget-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await jsonNewTicket(root, "Budgeted ready ticket 1");
    await jsonNewTicket(root, "Budgeted ready ticket 2");

    const out = captureOutput();
    try {
      await withCwd(root, () => runReady({ json: true, budget: 1 }));
    } finally {
      out.restore();
    }
    expect(() => JSON.parse(out.stdout())).not.toThrow();
  });
});
