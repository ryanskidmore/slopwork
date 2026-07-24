import { describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import type { TicketId } from "../../core/index.js";
import { runNew } from "./new.js";
import { runPlan } from "./plan.js";
import { runStart } from "./start.js";

// In-process coverage of `runPlan` (real v8 coverage, no subprocess).

async function jsonNewTicket(root: string, name: string): Promise<TicketId> {
  const out = captureOutput();
  try {
    await withCwd(root, () => runNew(name, { blocks: [], relatesTo: [], label: [], json: true }));
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

describe("runPlan (in-process)", () => {
  it("sets an initial plan (v1) on the active session", async () => {
    const root = await makeTempRepo("slop-plan-inproc-set-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Planned ticket");
    await startTicket(root, id);

    const out = captureOutput();
    try {
      await withCwd(root, () => runPlan(id, ["step one", "step two"], {}));
      expect(out.stdout()).toContain("plan v1 set");
      expect(out.stdout()).toContain("step one");
    } finally {
      out.restore();
    }
  });

  it("revising the plan (a second call with steps) prints a diff against v1", async () => {
    const root = await makeTempRepo("slop-plan-inproc-revise-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Revised plan ticket");
    await startTicket(root, id);

    const out1 = captureOutput();
    try {
      await withCwd(root, () => runPlan(id, ["step one"], {}));
    } finally {
      out1.restore();
    }

    const out2 = captureOutput();
    try {
      await withCwd(root, () => runPlan(id, ["step one", "step two"], {}));
      expect(out2.stdout()).toContain("plan v2 revised");
      expect(out2.stdout()).toContain("diff v1 -> v2");
    } finally {
      out2.restore();
    }
  });

  it("--check N checks off a step without creating a new plan version", async () => {
    const root = await makeTempRepo("slop-plan-inproc-check-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Checked plan ticket");
    await startTicket(root, id);
    const setOut = captureOutput();
    try {
      await withCwd(root, () => runPlan(id, ["step one", "step two"], {}));
    } finally {
      setOut.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runPlan(id, [], { check: 1 }));
      expect(out.stdout()).toContain("step 1 checked");
      expect(out.stdout()).toContain("plan v1");
    } finally {
      out.restore();
    }
  });

  it("--uncheck N reverses a checked step", async () => {
    const root = await makeTempRepo("slop-plan-inproc-uncheck-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Unchecked plan ticket");
    await startTicket(root, id);
    const setup = captureOutput();
    try {
      await withCwd(root, () => runPlan(id, ["only step"], {}));
      await withCwd(root, () => runPlan(id, [], { check: 1 }));
    } finally {
      setup.restore();
    }

    const out = captureOutput();
    try {
      await withCwd(root, () => runPlan(id, [], { uncheck: 1 }));
      expect(out.stdout()).toContain("step 1 unchecked");
    } finally {
      out.restore();
    }
  });

  it("rejects both --check and --uncheck together (USAGE_ERROR, exit 2)", async () => {
    const root = await makeTempRepo("slop-plan-inproc-bothflags-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Both flags ticket");

    const out = captureOutput();
    try {
      await expect(
        withCwd(root, () => runPlan(id, [], { check: 1, uncheck: 1 })),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.USAGE_ERROR });
    } finally {
      out.restore();
    }
  });

  it("rejects steps alongside --check (USAGE_ERROR, exit 2)", async () => {
    const root = await makeTempRepo("slop-plan-inproc-stepsandcheck-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Steps and check ticket");

    const out = captureOutput();
    try {
      await expect(
        withCwd(root, () => runPlan(id, ["a step"], { check: 1 })),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.USAGE_ERROR });
    } finally {
      out.restore();
    }
  });

  it("rejects nothing given at all (no steps, no --check/--uncheck) — USAGE_ERROR", async () => {
    const root = await makeTempRepo("slop-plan-inproc-nothing-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Nothing given ticket");

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runPlan(id, [], {}))).rejects.toMatchObject({
        exitCode: EXIT_CODES.USAGE_ERROR,
      });
    } finally {
      out.restore();
    }
  });

  it("refuses to plan a ticket with no active session", async () => {
    const root = await makeTempRepo("slop-plan-inproc-noactive-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Never-started ticket");

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runPlan(id, ["a step"], {}))).rejects.toThrow();
    } finally {
      out.restore();
    }
  });

  it("throws NOT_FOUND for an unresolvable ref", async () => {
    const root = await makeTempRepo("slop-plan-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });

    const out = captureOutput();
    try {
      await expect(
        withCwd(root, () => runPlan("no-such-ticket", ["a step"], {})),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
    } finally {
      out.restore();
    }
  });
});
