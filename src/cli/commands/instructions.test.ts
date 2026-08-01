import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { runInstructions } from "./instructions.js";

// In-process coverage of `runInstructions` — `slop instructions` reads
// .slop/config.yaml fresh off disk every call and renders the same
// canonical onboarding content `slop init` bakes into AGENTS.md (see
// src/cli/onboarding/render.ts), with project/jira interpolated.

describe("runInstructions", () => {
  it("prints the onboarding rules, interpolating the configured project name", async () => {
    const root = await makeTempRepo("slop-instructions-");
    await bootstrapRepo(root, { project: "widget-factory", user: "ryan" });

    const out = captureOutput();
    try {
      await withCwd(root, () => runInstructions());
    } finally {
      out.restore();
    }
    expect(out.stdout()).toContain("widget-factory");
    expect(out.stdout().length).toBeGreaterThan(100);
  });

  it("interpolates remotes.jira when configured", async () => {
    const root = await makeTempRepo("slop-instructions-jira-");
    await bootstrapRepo(root, { project: "p", user: "u", jira: "https://example.atlassian.net" });

    const out = captureOutput();
    try {
      await withCwd(root, () => runInstructions());
    } finally {
      out.restore();
    }
    expect(out.stdout()).toContain("example.atlassian.net");
  });

  it("throws a SlopError when config.yaml is missing entirely", async () => {
    const root = await makeTempRepo("slop-instructions-noconfig-");
    // No bootstrapRepo call — no .slop/ at all, so requireRepoRoot itself
    // should reject before config.yaml is ever read.
    await expect(withCwd(root, () => runInstructions())).rejects.toThrow();
  });

  it("throws a SlopError when config.yaml fails schema validation", async () => {
    const root = await makeTempRepo("slop-instructions-badconfig-");
    const paths = await bootstrapRepo(root, { project: "p", user: "u" });
    await writeFile(
      join(paths.slopDir, "config.yaml"),
      "project: p\ndefaults:\n  stale_after: not-a-duration\n",
    );

    await expect(withCwd(root, () => runInstructions())).rejects.toThrow(
      /does not match the expected shape/,
    );
  });
});
