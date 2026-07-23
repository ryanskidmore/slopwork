import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfigDefaultsTolerant } from "./config.js";
import { ensureDbDirs } from "./paths.js";
import type { RepoPaths } from "./paths.js";

let scratch: string;
let paths: RepoPaths;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-repo-config-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("loadConfigDefaultsTolerant", () => {
  it("falls back to schema defaults (60m/24h) when config.yaml is entirely absent", async () => {
    const defaults = await loadConfigDefaultsTolerant(paths);
    expect(defaults).toEqual({ stale_after: "60m", review_stale_after: "24h" });
  });

  it("reads the real configured thresholds when config.yaml exists", async () => {
    await writeFile(
      join(paths.slopDir, "config.yaml"),
      "project: test\ndefaults:\n  stale_after: 30m\n  review_stale_after: 12h\n",
      "utf8",
    );
    const defaults = await loadConfigDefaultsTolerant(paths);
    expect(defaults).toEqual({ stale_after: "30m", review_stale_after: "12h" });
  });

  it("falls back to schema defaults when config.yaml is unparseable", async () => {
    await writeFile(join(paths.slopDir, "config.yaml"), "not: valid: yaml: at: all: :::", "utf8");
    const defaults = await loadConfigDefaultsTolerant(paths);
    expect(defaults).toEqual({ stale_after: "60m", review_stale_after: "24h" });
  });

  it("falls back to schema defaults when config.yaml fails schema validation", async () => {
    // Missing required `project` field.
    await writeFile(join(paths.slopDir, "config.yaml"), "defaults:\n  stale_after: 5m\n", "utf8");
    const defaults = await loadConfigDefaultsTolerant(paths);
    expect(defaults).toEqual({ stale_after: "60m", review_stale_after: "24h" });
  });
});
