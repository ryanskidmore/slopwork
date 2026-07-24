import { describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/index.js";
import { repoPaths, resolveTicketRef, updateTicket, withLock } from "../../repo/index.js";
import { SlopError } from "../errors.js";
import { parseBudgetFlag, runContext } from "./context.js";
import { runNew } from "./new.js";
import { runStart } from "./start.js";

// cli-input-validation-reject-truncated-numerics-fix-actor-fai:
//
// `Number.parseInt` silently truncates leading-numeric garbage — this used
// to make `--budget 100abc` parse as `100` instead of being rejected.
// These tests prove `parseBudgetFlag` now requires the full trimmed value
// to be a plain non-negative integer, rejecting anything else with a
// SlopError carrying EXIT_CODES.USAGE_ERROR (exit 2).

describe("parseBudgetFlag", () => {
  it("accepts a plain non-negative integer", () => {
    expect(parseBudgetFlag("100")).toBe(100);
  });

  it("accepts zero", () => {
    expect(parseBudgetFlag("0")).toBe(0);
  });

  it("accepts an integer with surrounding whitespace", () => {
    expect(parseBudgetFlag(" 250 ")).toBe(250);
  });

  it("rejects trailing garbage instead of truncating it (--budget 100abc)", () => {
    expect(() => parseBudgetFlag("100abc")).toThrow(SlopError);
    try {
      parseBudgetFlag("100abc");
      throw new Error("expected parseBudgetFlag to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SlopError);
      expect((err as SlopError).exitCode).toBe(EXIT_CODES.USAGE_ERROR);
      expect((err as SlopError).message).toContain("--budget");
      expect((err as SlopError).message).toContain("100abc");
    }
  });

  it("rejects a decimal instead of truncating it", () => {
    expect(() => parseBudgetFlag("1.9")).toThrow(SlopError);
  });

  it("still rejects a negative integer (existing non-negative bound preserved)", () => {
    expect(() => parseBudgetFlag("-5")).toThrow(SlopError);
  });

  it("rejects a value that is entirely non-numeric", () => {
    expect(() => parseBudgetFlag("notanumber")).toThrow(SlopError);
  });
});

// ---------------------------------------------------------------------------
// In-process coverage of `runContext` (real v8 coverage, no subprocess).
// ---------------------------------------------------------------------------

async function jsonNewTicket(root: string, name: string): Promise<string> {
  const out = captureOutput();
  try {
    await withCwd(root, () => runNew(name, { blocks: [], relatesTo: [], label: [], json: true }));
    return (JSON.parse(out.stdout()) as { id: string }).id;
  } finally {
    out.restore();
  }
}

describe("runContext (in-process)", () => {
  it("prints the context pack (human text) for a ticket with no sessions yet", async () => {
    const root = await makeTempRepo("slop-context-inproc-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "A ticket to inspect");

    const out = captureOutput();
    try {
      await withCwd(root, () => runContext(id, {}));
    } finally {
      out.restore();
    }
    expect(out.stdout()).toContain(id);
    expect(out.stdout()).toContain("A ticket to inspect");
  });

  it("--json prints a machine-readable context pack", async () => {
    const root = await makeTempRepo("slop-context-inproc-json-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Json context ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runContext(id, { json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { ticket: { id: string } };
    expect(body.ticket.id).toBe(id);
  });

  it("--budget bounds the rendered pack without corrupting --json", async () => {
    const root = await makeTempRepo("slop-context-inproc-budget-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Budget-bounded context ticket");

    const out = captureOutput();
    try {
      await withCwd(root, () => runContext(id, { json: true, budget: 10 }));
    } finally {
      out.restore();
    }
    expect(() => JSON.parse(out.stdout())).not.toThrow();
  });

  it("reflects an active session and its plan once one exists", async () => {
    const root = await makeTempRepo("slop-context-inproc-session-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "In-progress context ticket");

    const startOut = captureOutput();
    try {
      await withCwd(root, () => runStart(id, {}));
    } finally {
      startOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runContext(id, { json: true }));
    } finally {
      out.restore();
    }
    const body = JSON.parse(out.stdout()) as { ticket: { state: string } };
    expect(body.ticket.state).toBe("in_progress");
  });

  it("throws NOT_FOUND for an unresolvable ref", async () => {
    const root = await makeTempRepo("slop-context-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    await expect(withCwd(root, () => runContext("no-such-ticket", {}))).rejects.toMatchObject({
      exitCode: EXIT_CODES.NOT_FOUND,
    });
  });

  it("never writes anything — a mutation applied between reads is still visible next call (read-only, no state change)", async () => {
    const root = await makeTempRepo("slop-context-inproc-readonly-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Readonly context ticket");
    const paths = repoPaths(root);

    const out1 = captureOutput();
    try {
      await withCwd(root, () => runContext(id, { json: true }));
    } finally {
      out1.restore();
    }
    const before = JSON.parse(out1.stdout()) as { ticket: { name: string } };
    expect(before.ticket.name).toBe("Readonly context ticket");

    await withLock(paths.lockFile, async () => {
      const ticket = await resolveTicketRef(paths, id);
      const renamed = { ...ticket, name: "Renamed externally" };
      await updateTicket(
        paths,
        ticket.id,
        [{ path: ["name"], value: "Renamed externally" }],
        renamed,
        { actor: { name: "ryan", kind: "human" }, session: null },
        { verb: "ticket.updated", payload: {} },
      );
    });

    const out2 = captureOutput();
    try {
      await withCwd(root, () => runContext(id, { json: true }));
    } finally {
      out2.restore();
    }
    const after = JSON.parse(out2.stdout()) as { ticket: { name: string } };
    expect(after.ticket.name).toBe("Renamed externally");
  });
});
