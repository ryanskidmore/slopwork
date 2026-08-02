import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { configSchema } from "../../core/index.js";
import { parseConfigYamlText } from "../../core/config-yaml.js";
import { runInit } from "./init.js";

// In-process coverage of `runInit` — the CLI-facing wrapper around D1's
// full `slop init` flow (config.yaml autodetection, db/ skeleton +
// .gitkeep placeholders, AGENTS.md/SKILL.md generation, .gitignore/
// .gitattributes management (t-mgx82), the CLAUDE.md link offer). Driven
// directly against a fresh
// mkdtemp() root via withCwd (tests/support/cli-harness.ts) — every call
// below deterministically runs with CLAUDECODE unset (withCwd scrubs it,
// and every other harness-identity env var, for the duration of the call
// and restores it after — see cli-harness.ts's own doc), regardless of
// whatever this TEST PROCESS's own ambient environment happens to be, and
// stdin/stdout are never real TTYs under vitest, so `isInteractive()`
// (src/cli/init/prompt.ts) is always false here: no prompt can ever hang
// this suite. The "Claude Code skill install" describe block below is the
// one place that needs CLAUDECODE=1 back — it passes it as `withCwd`'s
// `envOverrides` rather than mutating `process.env` itself, so it composes
// with the scrub instead of racing it.

describe("runInit — fresh repo", () => {
  it("creates config.yaml, the db/ skeleton with .gitkeep placeholders, AGENTS.md, and a managed .gitignore section", async () => {
    const root = await makeTempRepo("slop-init-fresh-");
    const out = captureOutput();
    try {
      await withCwd(root, () => runInit({ yes: true, project: "fresh-project", user: "ryan" }));
    } finally {
      out.restore();
    }

    expect(out.stdout()).toContain(`Initialized slopwork at ${root}`);
    expect(out.stdout()).toContain(".slop/config.yaml   (created)");

    const configText = await readFile(join(root, ".slop", "config.yaml"), "utf8");
    const config = configSchema.parse(parseConfigYamlText(configText));
    expect(config.project).toBe("fresh-project");
    expect(config.user).toBe("ryan");

    for (const dir of ["tickets", "sessions", "events"]) {
      await expect(readFile(join(root, ".slop", "db", dir, ".gitkeep"), "utf8")).resolves.toBe("");
    }

    const agentsMd = await readFile(join(root, ".slop", "AGENTS.md"), "utf8");
    expect(agentsMd.length).toBeGreaterThan(0);

    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".slop/");

    const gitattributes = await readFile(join(root, ".gitattributes"), "utf8");
    expect(gitattributes).toContain(".slop/db/** linguist-generated gitlab-generated");
    expect(gitattributes).toContain(".slop/db/**/*.jsonc text eol=lf");
  });

  it("--jira sets remotes.jira non-interactively", async () => {
    const root = await makeTempRepo("slop-init-jira-");
    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runInit({ yes: true, project: "p", user: "u", jira: "https://example.atlassian.net" }),
      );
    } finally {
      out.restore();
    }
    const configText = await readFile(join(root, ".slop", "config.yaml"), "utf8");
    const config = configSchema.parse(parseConfigYamlText(configText));
    expect(config.remotes.jira).toBe("https://example.atlassian.net");
  });

  it("--project falls back to the directory basename when omitted", async () => {
    const root = await makeTempRepo("slop-init-noproject-");
    const out = captureOutput();
    try {
      await withCwd(root, () => runInit({ yes: true }));
    } finally {
      out.restore();
    }
    const configText = await readFile(join(root, ".slop", "config.yaml"), "utf8");
    const config = configSchema.parse(parseConfigYamlText(configText));
    expect(config.project.length).toBeGreaterThan(0);
  });
});

describe("runInit — re-running against an already-initialized repo", () => {
  it("leaves config.yaml untouched but refreshes AGENTS.md and .gitignore", async () => {
    const root = await makeTempRepo("slop-init-reinit-");
    const out1 = captureOutput();
    try {
      await withCwd(root, () => runInit({ yes: true, project: "original", user: "ryan" }));
    } finally {
      out1.restore();
    }
    const configPath = join(root, ".slop", "config.yaml");
    const before = await readFile(configPath, "utf8");

    const out2 = captureOutput();
    try {
      // A second call passes DIFFERENT flags — if they were honored, this
      // would prove config.yaml gets rewritten; the safety contract is
      // that it must NOT be.
      await withCwd(root, () => runInit({ yes: true, project: "should-be-ignored" }));
      expect(out2.stdout()).toContain("already initialized");
      expect(out2.stdout()).toContain(".slop/config.yaml   (existing, untouched)");
    } finally {
      out2.restore();
    }

    const after = await readFile(configPath, "utf8");
    expect(after).toBe(before);
    const config = configSchema.parse(parseConfigYamlText(after));
    expect(config.project).toBe("original");
  });

  it("re-running init is byte-identical for .gitattributes (t-mgx82: no churn)", async () => {
    const root = await makeTempRepo("slop-init-gitattributes-idempotent-");
    const out1 = captureOutput();
    try {
      await withCwd(root, () => runInit({ yes: true, project: "p", user: "u" }));
    } finally {
      out1.restore();
    }
    const gitattributesPath = join(root, ".gitattributes");
    const first = await readFile(gitattributesPath, "utf8");

    const out2 = captureOutput();
    try {
      await withCwd(root, () => runInit({ yes: true }));
    } finally {
      out2.restore();
    }
    const second = await readFile(gitattributesPath, "utf8");
    expect(second).toBe(first);
    expect(second.match(/linguist-generated/g)).toHaveLength(1);
    expect(second.match(/eol=lf/g)).toHaveLength(1);
  });

  it("appends the managed section to an existing .gitattributes without touching user content", async () => {
    const root = await makeTempRepo("slop-init-gitattributes-append-");
    const userContent = "*.png binary\n*.psd -text -diff\n";
    await writeFile(join(root, ".gitattributes"), userContent);

    const out = captureOutput();
    try {
      await withCwd(root, () => runInit({ yes: true, project: "p", user: "u" }));
    } finally {
      out.restore();
    }

    const gitattributes = await readFile(join(root, ".gitattributes"), "utf8");
    expect(gitattributes).toContain(userContent.trim());
    expect(gitattributes).toContain(".slop/db/** linguist-generated gitlab-generated");
    expect(gitattributes).toContain(".slop/db/**/*.jsonc text eol=lf");
    expect(gitattributes.startsWith(userContent.trimEnd())).toBe(true);
  });

  it("throws a SlopError when an existing config.yaml fails schema validation", async () => {
    const root = await makeTempRepo("slop-init-badconfig-");
    const out = captureOutput();
    try {
      await withCwd(root, () => runInit({ yes: true, project: "p", user: "u" }));
    } finally {
      out.restore();
    }
    await writeFile(join(root, ".slop", "config.yaml"), "project: \nstate: not-a-real-key\n");

    const out2 = captureOutput();
    try {
      await expect(withCwd(root, () => runInit({ yes: true }))).rejects.toThrow(
        /does not match the expected shape/,
      );
    } finally {
      out2.restore();
    }
  });
});

describe("runInit — Claude Code skill install", () => {
  it("installs .claude/skills/slopwork/SKILL.md when CLAUDECODE=1", async () => {
    const root = await makeTempRepo("slop-init-claude-env-");
    const out = captureOutput();
    try {
      await withCwd(root, () => runInit({ yes: true, project: "p", user: "u" }), {
        CLAUDECODE: "1",
      });
      expect(out.stdout()).toContain("SKILL.md   (generated");
    } finally {
      out.restore();
    }
    const skill = await readFile(join(root, ".claude", "skills", "slopwork", "SKILL.md"), "utf8");
    expect(skill.length).toBeGreaterThan(0);
  });

  it("does not install the skill when no Claude Code signal is present", async () => {
    const root = await makeTempRepo("slop-init-noclaude-");
    const out = captureOutput();
    try {
      // No envOverrides — withCwd's own scrub already guarantees
      // CLAUDECODE is unset here, deterministically, regardless of this
      // test process's own ambient environment.
      await withCwd(root, () => runInit({ yes: true, project: "p", user: "u" }));
      expect(out.stdout()).not.toContain("SKILL.md");
    } finally {
      out.restore();
    }
    await expect(
      readFile(join(root, ".claude", "skills", "slopwork", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
  });
});

describe("runInit — CLAUDE.md link offer", () => {
  it("--link-claude-md appends a slopwork pointer to an existing CLAUDE.md", async () => {
    const root = await makeTempRepo("slop-init-claudemd-link-");
    await writeFile(join(root, "CLAUDE.md"), "# My project\n\nSome existing notes.\n");
    const out = captureOutput();
    try {
      await withCwd(root, () =>
        runInit({ yes: true, project: "p", user: "u", linkClaudeMd: true }),
      );
      expect(out.stdout()).toContain("CLAUDE.md           (added a pointer to slopwork)");
    } finally {
      out.restore();
    }
    const claudeMd = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("slopwork:start");
    expect(claudeMd).toContain("Some existing notes.");
  });

  it("without --link-claude-md (non-interactive): leaves CLAUDE.md untouched and nudges to re-run with the flag", async () => {
    const root = await makeTempRepo("slop-init-claudemd-skip-");
    await writeFile(join(root, "CLAUDE.md"), "# My project\n");
    const out = captureOutput();
    try {
      await withCwd(root, () => runInit({ yes: true, project: "p", user: "u" }));
      expect(out.stdout()).toContain("re-run `slop init --link-claude-md`");
    } finally {
      out.restore();
    }
    const claudeMd = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(claudeMd).toBe("# My project\n");
  });

  it("re-running --link-claude-md a second time is idempotent (already-linked, no duplicate marker)", async () => {
    const root = await makeTempRepo("slop-init-claudemd-idempotent-");
    await writeFile(join(root, "CLAUDE.md"), "# My project\n");
    const out1 = captureOutput();
    try {
      await withCwd(root, () =>
        runInit({ yes: true, project: "p", user: "u", linkClaudeMd: true }),
      );
    } finally {
      out1.restore();
    }
    const out2 = captureOutput();
    try {
      await withCwd(root, () =>
        runInit({ yes: true, project: "p", user: "u", linkClaudeMd: true }),
      );
      expect(out2.stdout()).not.toContain("added a pointer");
    } finally {
      out2.restore();
    }
    const claudeMd = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(claudeMd.match(/slopwork:start/g)).toHaveLength(1);
  });

  it("no CLAUDE.md present: says nothing about it (not-found is silent, not an error)", async () => {
    const root = await makeTempRepo("slop-init-noclaudemd-");
    const out = captureOutput();
    try {
      await withCwd(root, () => runInit({ yes: true, project: "p", user: "u" }));
      expect(out.stdout()).not.toContain("CLAUDE.md");
    } finally {
      out.restore();
    }
  });
});
