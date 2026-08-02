import { describe, expect, it, vi } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import type { SessionId, TicketId } from "../../core/index.js";
import { queryEvents, readTicket, repoPaths } from "../../repo/index.js";
import { FlatfileBackend } from "../../storage/flatfile.js";
import { runNew } from "./new.js";
import { runSplit } from "./split.js";
import { runStart } from "./start.js";

// In-process coverage of `runSplit` (real v8 coverage, no subprocess).

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

async function jsonStartTicket(root: string, id: TicketId): Promise<SessionId> {
  const out = captureOutput();
  try {
    await withCwd(root, () => runStart(id, { harness: "codex", json: true }));
    return (JSON.parse(out.stdout()) as { session: { id: SessionId } }).session.id;
  } finally {
    out.restore();
  }
}

describe("runSplit (in-process)", () => {
  it("uses one transaction-local ticket scan for every child and advances colliding slugs in memory", async () => {
    const root = await makeTempRepo("slop-split-inproc-snapshot-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const targetId = await jsonNewTicket(root, "Snapshot split target");
    const listSpy = vi.spyOn(FlatfileBackend.prototype, "listTickets");

    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runSplit(targetId, ["Repeated child", "Repeated child", "Third child"], { json: true }),
      );
      const body = JSON.parse(out.stdout()) as { children: { slug: string }[] };
      expect(body.children.map(({ slug }) => slug)).toEqual([
        "repeated-child",
        "repeated-child-2",
        "third-child",
      ]);
      expect(listSpy).toHaveBeenCalledTimes(1);
    } finally {
      out.restore();
      listSpy.mockRestore();
    }
  });

  it("creates one child ticket per name given, each with discovered_from set to the target", async () => {
    const root = await makeTempRepo("slop-split-inproc-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const targetId = await jsonNewTicket(root, "Ticket to split");

    const out = captureOutput();
    try {
      await withCwd(root, () => runSplit(targetId, ["sub one", "sub two"], {}));
      expect(out.stdout()).toContain(`split ${targetId}`);
      expect(out.stdout()).toContain("into 2 sub-ticket(s)");
    } finally {
      out.restore();
    }
  });

  it("--json returns the target plus each new child's id/slug/name/state/priority/parent", async () => {
    const root = await makeTempRepo("slop-split-inproc-json-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const targetId = await jsonNewTicket(root, "Json split target");

    const out = captureOutput();
    try {
      await withCwd(root, () => runSplit(targetId, ["child a", "child b"], { json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      target: { id: string };
      children: { id: string; name: string; parent: string | null }[];
    };
    expect(body.target.id).toBe(targetId);
    expect(body.children).toHaveLength(2);
    expect(body.children.map((c) => c.name)).toEqual(["child a", "child b"]);
    expect(body.children.every((c) => c.parent === targetId)).toBe(true);
  });

  it("each child's parent points back to the target, and the target's own last_activity_at is bumped", async () => {
    const root = await makeTempRepo("slop-split-inproc-parentcheck-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const targetId = await jsonNewTicket(root, "Split parent check target");
    const paths = repoPaths(root);
    const before = await readTicket(paths, targetId);

    const out = captureOutput();
    try {
      await withCwd(root, () => runSplit(targetId, ["only child"], { json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { children: { id: TicketId }[] };
    const child = await readTicket(paths, body.children[0]!.id);
    expect(child.parent).toBe(targetId);
    expect(child.discovered_from).toContain(targetId);

    const after = await readTicket(paths, targetId);
    expect(after.last_activity_at).not.toBe(before.last_activity_at);
  });

  it("attributes the parent split and split-child creation events to the active parent session", async () => {
    const root = await makeTempRepo("slop-split-inproc-session-context-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const targetId = await jsonNewTicket(root, "Active split target");
    const session = await jsonStartTicket(root, targetId);

    const out = captureOutput();
    try {
      await withCwd(root, () => runSplit(targetId, ["session child"], { json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { children: { id: TicketId }[] };
    const childId = body.children[0]?.id;
    if (!childId) throw new Error("split produced no child");

    const paths = repoPaths(root);
    const splitEvent = (await queryEvents(paths, { ticket: targetId })).find(
      (event) => event.verb === "ticket.split",
    );
    const childCreated = (await queryEvents(paths, { ticket: childId })).find(
      (event) => event.verb === "ticket.created",
    );
    expect(splitEvent?.session).toBe(session);
    expect(childCreated?.session).toBe(session);
  });

  it("keeps split events null when the parent has no active session", async () => {
    const root = await makeTempRepo("slop-split-inproc-no-session-context-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const targetId = await jsonNewTicket(root, "Open split target");

    const out = captureOutput();
    try {
      await withCwd(root, () => runSplit(targetId, ["cold child"], { json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { children: { id: TicketId }[] };
    const childId = body.children[0]?.id;
    if (!childId) throw new Error("split produced no child");

    const paths = repoPaths(root);
    const splitEvent = (await queryEvents(paths, { ticket: targetId })).find(
      (event) => event.verb === "ticket.split",
    );
    const childCreated = (await queryEvents(paths, { ticket: childId })).find(
      (event) => event.verb === "ticket.created",
    );
    expect(splitEvent?.session).toBeNull();
    expect(childCreated?.session).toBeNull();
  });

  it("rejects a blank sub-ticket name up front (USAGE_ERROR, exit 2), before the lock is acquired", async () => {
    const root = await makeTempRepo("slop-split-inproc-blankname-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const targetId = await jsonNewTicket(root, "Blank name split target");

    await expect(
      withCwd(root, () => runSplit(targetId, ["good name", "   "], {})),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.USAGE_ERROR });

    // Nothing was created — the whole call short-circuited pre-lock.
    const paths = repoPaths(root);
    const target = await readTicket(paths, targetId);
    expect(target.name).toBe("Blank name split target");
  });

  it("rejects a name exceeding the max length (USAGE_ERROR, exit 2)", async () => {
    const root = await makeTempRepo("slop-split-inproc-longname-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const targetId = await jsonNewTicket(root, "Long name split target");

    await expect(
      withCwd(root, () => runSplit(targetId, ["x".repeat(301)], {})),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.USAGE_ERROR });
  });

  it("throws NOT_FOUND for an unresolvable target ref", async () => {
    const root = await makeTempRepo("slop-split-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    await expect(
      withCwd(root, () => runSplit("no-such-ticket", ["sub"], {})),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
  });
});
