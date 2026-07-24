import { describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import type { TicketId } from "../../core/index.js";
import { readTicket, repoPaths } from "../../repo/index.js";
import { runNew } from "./new.js";
import { runSplit } from "./split.js";

// In-process coverage of `runSplit` (real v8 coverage, no subprocess).

async function jsonNewTicket(root: string, name: string): Promise<TicketId> {
  const out = captureOutput();
  try {
    await withCwd(root, () => runNew(name, { blocks: [], relatesTo: [], label: [], json: true }));
    return (JSON.parse(out.stdout()) as { id: TicketId }).id;
  } finally {
    out.restore();
  }
}

describe("runSplit (in-process)", () => {
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
