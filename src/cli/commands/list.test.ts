import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/index.js";
import { repoPaths } from "../../repo/index.js";
import { runAsk } from "./ask.js";
import { runList } from "./list.js";
import { runNew } from "./new.js";

// In-process coverage of `runList` (t-km7mb) — real v8 coverage, no
// subprocess. Acceptance-level (spawned-binary) coverage of the same
// command already lives in tests/acceptance/G3.test.ts; this file's job is
// just to exercise `runList` directly so `src/cli/commands/list.ts` isn't
// 0%-covered.

interface NewTicketJson {
  id: string;
  slug: string;
}

async function jsonNewTicket(
  root: string,
  name: string,
  extra: Partial<{
    label: string[];
    priority: number;
    ownerRaw: string;
    parent: string;
    draft: boolean;
  }> = {},
): Promise<NewTicketJson> {
  const out = captureOutput();
  try {
    await withCwd(root, () =>
      runNew(name, {
        blocks: [],
        relatesTo: [],
        label: extra.label ?? [],
        acceptance: [],
        context: [],
        priority: extra.priority,
        owner: extra.ownerRaw,
        parent: extra.parent,
        draft: extra.draft,
        json: true,
      }),
    );
    return JSON.parse(out.stdout()) as NewTicketJson;
  } finally {
    out.restore();
  }
}

function defaultListOpts(): Parameters<typeof runList>[1] {
  return { state: [], label: [] };
}

describe("runList (in-process)", () => {
  it("with no tickets: reports 0 of 0", async () => {
    const root = await makeTempRepo("slop-list-inproc-empty-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    const out = captureOutput();
    try {
      await withCwd(root, () => runList(undefined, defaultListOpts()));
    } finally {
      out.restore();
    }
    expect(out.stdout()).toContain("0 of 0 matching ticket(s)");
  });

  it("free-text filters against name/slug/spec.summary", async () => {
    const root = await makeTempRepo("slop-list-inproc-text-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const matching = await jsonNewTicket(root, "Widget overhaul");
    await jsonNewTicket(root, "Unrelated ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runList("widget", defaultListOpts()));
    } finally {
      out.restore();
    }
    expect(out.stdout()).toContain(matching.slug);
    expect(out.stdout()).not.toContain("unrelated-ticket");
  });

  it("--state (repeatable, OR) filters to any of the given states", async () => {
    const root = await makeTempRepo("slop-list-inproc-state-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const open = await jsonNewTicket(root, "Open ticket");
    const draft = await jsonNewTicket(root, "Draft ticket", { draft: true });

    const out = captureOutput();
    try {
      await withCwd(root, () => runList(undefined, { state: ["draft"], label: [], json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { tickets: { id: string }[] };
    expect(body.tickets.map((t) => t.id)).toEqual([draft.id]);
    expect(body.tickets.map((t) => t.id)).not.toContain(open.id);
  });

  it("rejects an unknown --state as a USAGE_ERROR", async () => {
    const root = await makeTempRepo("slop-list-inproc-badstate-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    await expect(
      withCwd(root, () => runList(undefined, { state: ["not-a-state"], label: [] })),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.USAGE_ERROR });
  });

  it("--label (repeatable, AND) requires every given label", async () => {
    const root = await makeTempRepo("slop-list-inproc-label-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const both = await jsonNewTicket(root, "Both labels", { label: ["area:auth", "team:infra"] });
    await jsonNewTicket(root, "One label", { label: ["area:auth"] });

    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runList(undefined, { state: [], label: ["area:auth", "team:infra"], json: true }),
      );
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { tickets: { id: string }[] };
    expect(body.tickets.map((t) => t.id)).toEqual([both.id]);
  });

  it("--owner/--priority filter exactly", async () => {
    const root = await makeTempRepo("slop-list-inproc-owner-priority-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const match = await jsonNewTicket(root, "Owned urgent", { ownerRaw: "priya", priority: 0 });
    await jsonNewTicket(root, "Owned low", { ownerRaw: "priya", priority: 3 });

    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runList(undefined, { state: [], label: [], owner: "priya", priority: 0, json: true }),
      );
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { tickets: { id: string }[] };
    expect(body.tickets.map((t) => t.id)).toEqual([match.id]);
  });

  it("--parent filters to DIRECT children only", async () => {
    const root = await makeTempRepo("slop-list-inproc-parent-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const parent = await jsonNewTicket(root, "Parent ticket");
    const child = await jsonNewTicket(root, "Child ticket", { parent: parent.id });
    const grandchild = await jsonNewTicket(root, "Grandchild ticket", { parent: child.id });

    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runList(undefined, { state: [], label: [], parent: parent.id, json: true }),
      );
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { tickets: { id: string }[] };
    expect(body.tickets.map((t) => t.id)).toEqual([child.id]);
    expect(body.tickets.map((t) => t.id)).not.toContain(grandchild.id);
  });

  it("--subtree filters to the whole descendant tree, INCLUSIVE of the root", async () => {
    const root = await makeTempRepo("slop-list-inproc-subtree-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const parent = await jsonNewTicket(root, "Subtree root");
    const child = await jsonNewTicket(root, "Subtree child", { parent: parent.id });
    const grandchild = await jsonNewTicket(root, "Subtree grandchild", { parent: child.id });
    await jsonNewTicket(root, "Unrelated ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runList(undefined, { state: [], label: [], subtree: parent.id, json: true }),
      );
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { tickets: { id: string }[] };
    const ids = body.tickets.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([parent.id, child.id, grandchild.id]));
    expect(ids).toHaveLength(3);
  });

  it("throws NOT_FOUND for an unresolvable --parent ref", async () => {
    const root = await makeTempRepo("slop-list-inproc-parent-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    await expect(
      withCwd(root, () => runList(undefined, { state: [], label: [], parent: "no-such-ticket" })),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
  });

  it("--limit/--offset page deterministically", async () => {
    const root = await makeTempRepo("slop-list-inproc-page-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await jsonNewTicket(root, "Page ticket A", { priority: 0 });
    await jsonNewTicket(root, "Page ticket B", { priority: 0 });
    await jsonNewTicket(root, "Page ticket C", { priority: 0 });

    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runList(undefined, { state: [], label: [], limit: 1, offset: 1, json: true }),
      );
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      tickets: unknown[];
      total: number;
      returned: number;
    };
    expect(body.total).toBe(3);
    expect(body.returned).toBe(1);
  });

  it("--awaiting-input filters to tickets with an unanswered question; every row still carries the badge", async () => {
    const root = await makeTempRepo("slop-list-inproc-awaiting-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const asked = await jsonNewTicket(root, "Awaiting-input ticket");
    const plain = await jsonNewTicket(root, "Plain ticket");

    const askOut = captureOutput();
    try {
      await withCwd(root, () => runAsk(asked.id, "Which way?", { option: [] }));
    } finally {
      askOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runList(undefined, { state: [], label: [], awaitingInput: true, json: true }),
      );
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      tickets: { id: string; awaiting_input: boolean }[];
    };
    expect(body.tickets.map((t) => t.id)).toEqual([asked.id]);
    expect(body.tickets[0]?.awaiting_input).toBe(true);

    const allOut = captureOutput();
    try {
      await withCwd(root, () => runList(undefined, { state: [], label: [], json: true }));
    } finally {
      allOut.restore();
    }
    const allBody = JSON.parse(allOut.stdout()) as {
      tickets: { id: string; awaiting_input: boolean }[];
    };
    const plainRow = allBody.tickets.find((t) => t.id === plain.id);
    expect(plainRow?.awaiting_input).toBe(false);
  });

  it("--json --budget elides tickets from the tail without corrupting the JSON", async () => {
    const root = await makeTempRepo("slop-list-inproc-budget-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    for (let i = 0; i < 6; i++) {
      await jsonNewTicket(root, `Budget ticket number ${i} with a long enough name to matter`);
    }

    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runList(undefined, { state: [], label: [], json: true, budget: 30 }),
      );
    } finally {
      out.restore();
    }
    expect(() => JSON.parse(out.stdout())).not.toThrow();
    const body = JSON.parse(out.stdout()) as { elided: string[]; total: number };
    expect(body.elided.length).toBeGreaterThan(0);
    expect(body.total).toBe(6);
  });

  it("a corrupt ticket file is skipped, warned about on stderr, and reported in --json's problems array", async () => {
    const root = await makeTempRepo("slop-list-inproc-corrupt-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const good = await jsonNewTicket(root, "Readable ticket");
    const paths = repoPaths(root);
    await writeFile(join(paths.ticketsDir, "ticket_01ARZ3NDEKTSV4RRFFQ69G5FAA.jsonc"), "{ bad {{{");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = captureOutput();
    try {
      await withCwd(root, () => runList(undefined, { state: [], label: [], json: true }));
      expect(stderrSpy).toHaveBeenCalled();
      expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("could not be read and were skipped");
    } finally {
      out.restore();
      stderrSpy.mockRestore();
    }
    const body = JSON.parse(out.stdout()) as {
      tickets: { id: string }[];
      problems: { id: string }[];
    };
    expect(body.tickets.map((t) => t.id)).toEqual([good.id]);
    expect(body.problems).toHaveLength(1);
  });
});
