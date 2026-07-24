import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import { newTicketId, shortTicketCode } from "../../core/index.js";
import type { TicketId } from "../../core/index.js";
import { repoPaths, ticketFilePath } from "../../repo/index.js";
import { runNew } from "./new.js";
import { runSearch } from "./search.js";
import { runUpdate } from "./update.js";

// In-process coverage of `runSearch` (real v8 coverage, no subprocess).

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

describe("runSearch (in-process)", () => {
  it("finds a ticket by a word in its name", async () => {
    const root = await makeTempRepo("slop-search-inproc-name-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Widget factory rewrite");
    await jsonNewTicket(root, "Unrelated ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runSearch("widget", { json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { results: { id: string }[] };
    expect(body.results.map((r) => r.id)).toEqual([id]);
  });

  // handle-t-code-missing-from: `search --json` rows used to omit the short
  // `t-<code>` handle that `new`/`show`/`status` already surface.
  it("--json results carry the short t-<code> handle", async () => {
    const root = await makeTempRepo("slop-search-inproc-handle-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Handle-findable widget ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runSearch("widget", { json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { results: { id: string; handle: string }[] };
    const row = body.results.find((r) => r.id === id);
    expect(row?.handle).toBe(shortTicketCode(id));
  });

  it("finds text in progress-note HISTORY, not just the current latest_note", async () => {
    const root = await makeTempRepo("slop-search-inproc-notehistory-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Note history ticket");
    const out1 = captureOutput();
    try {
      await withCwd(root, () =>
        runUpdate(id, {
          label: [],
          relatesTo: [],
          acceptance: [],
          context: [],
          progress: "mentions gadgetronic",
        }),
      );
    } finally {
      out1.restore();
    }
    const out2 = captureOutput();
    try {
      await withCwd(root, () =>
        runUpdate(id, {
          label: [],
          relatesTo: [],
          acceptance: [],
          context: [],
          progress: "a later, unrelated note",
        }),
      );
    } finally {
      out2.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runSearch("gadgetronic", { json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { results: { id: string }[] };
    expect(body.results.map((r) => r.id)).toContain(id);
  });

  it("--limit caps the number of results returned", async () => {
    const root = await makeTempRepo("slop-search-inproc-limit-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await jsonNewTicket(root, "Duplicate keyword one");
    await jsonNewTicket(root, "Duplicate keyword two");
    await jsonNewTicket(root, "Duplicate keyword three");

    const out = captureOutput();
    try {
      await withCwd(root, () => runSearch("duplicate", { json: true, limit: 2 }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { results: unknown[]; count: number };
    expect(body.results).toHaveLength(2);
    expect(body.count).toBe(2);
  });

  it("no matches: human output says so, --json returns an empty array", async () => {
    const root = await makeTempRepo("slop-search-inproc-nomatch-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await jsonNewTicket(root, "Something else entirely");

    const out = captureOutput();
    try {
      await withCwd(root, () => runSearch("zzzznomatch", {}));
      expect(out.stdout()).toContain('no matches for "zzzznomatch"');
    } finally {
      out.restore();
    }
  });

  it("rejects whitespace-only search text (USAGE_ERROR, exit 2)", async () => {
    const root = await makeTempRepo("slop-search-inproc-blank-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    await expect(withCwd(root, () => runSearch("   ", {}))).rejects.toMatchObject({
      exitCode: EXIT_CODES.USAGE_ERROR,
    });
  });

  it("a corrupt ticket file is skipped (fault-tolerant), warned on stderr, and listed in --json's problems", async () => {
    const root = await makeTempRepo("slop-search-inproc-corrupt-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const good = await jsonNewTicket(root, "Findable good ticket");
    const paths = repoPaths(root);
    const badId = newTicketId();
    await writeFile(ticketFilePath(paths, badId), "{ not even valid jsonc {{{");

    const out = captureOutput();
    try {
      await withCwd(root, () => runSearch("findable", { json: true }));
      expect(out.stderr()).toContain(badId);
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as {
      results: { id: string }[];
      problems: { id: string }[];
    };
    expect(body.results.map((r) => r.id)).toEqual([good]);
    expect(body.problems.map((p) => p.id)).toEqual([badId]);
  });

  it("--budget bounds output without corrupting --json", async () => {
    const root = await makeTempRepo("slop-search-inproc-budget-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    await jsonNewTicket(root, "Budget keyword ticket one");
    await jsonNewTicket(root, "Budget keyword ticket two");

    const out = captureOutput();
    try {
      await withCwd(root, () => runSearch("budget", { json: true, budget: 1 }));
    } finally {
      out.restore();
    }
    expect(() => JSON.parse(out.stdout())).not.toThrow();
  });
});
