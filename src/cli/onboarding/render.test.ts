import { describe, expect, it } from "vitest";
import {
  EDGE_CASES,
  HOUSE_RULES,
  LOOP_STEPS,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  WHEN_TO_ACT,
} from "./content.js";
import {
  type OnboardingContext,
  renderAgentsMd,
  renderInstructions,
  renderOnboardingBody,
  renderSkillFrontmatter,
  renderSkillMd,
} from "./render.js";

const ctx: OnboardingContext = { project: "widgets", jiraUrl: "https://acme.atlassian.net" };

describe("D1 onboarding content: one source, three renderings", () => {
  it("renderInstructions/renderAgentsMd/renderSkillMd all embed the exact same body", () => {
    const body = renderOnboardingBody(ctx);
    expect(renderInstructions(ctx)).toBe(body);
    expect(renderAgentsMd(ctx)).toBe(body);
    expect(renderSkillMd(ctx)).toBe(renderSkillFrontmatter() + body);
  });

  // This is the clause most likely to rot into three hand-maintained
  // copies (D1 brief). Rather than hardcoding a duplicate string in this
  // test and hoping nobody forgets to update it too, every assertion
  // below reads straight from content.ts's live arrays: add a new house
  // rule / loop step / table row / edge case there and this test keeps
  // passing (and proves the new entry reached all three renderings)
  // without anyone touching this file.
  it.each(HOUSE_RULES)("every house rule appears in all three renderings: %s", (rule) => {
    for (const rendered of [renderInstructions(ctx), renderAgentsMd(ctx), renderSkillMd(ctx)]) {
      expect(rendered).toContain(rule);
    }
  });

  it.each(LOOP_STEPS)("every loop step appears in all three renderings: %s", (step) => {
    for (const rendered of [renderInstructions(ctx), renderAgentsMd(ctx), renderSkillMd(ctx)]) {
      expect(rendered).toContain(step);
    }
  });

  it.each(EDGE_CASES)("every edge case appears in all three renderings: %s", (edgeCase) => {
    for (const rendered of [renderInstructions(ctx), renderAgentsMd(ctx), renderSkillMd(ctx)]) {
      expect(rendered).toContain(edgeCase);
    }
  });

  it.each(WHEN_TO_ACT.map((row) => [row.situation, row.action] as const))(
    "every when-to-act row appears in all three renderings: %s",
    (situation, action) => {
      for (const rendered of [renderInstructions(ctx), renderAgentsMd(ctx), renderSkillMd(ctx)]) {
        expect(rendered).toContain(situation);
        expect(rendered).toContain(action);
      }
    },
  );

  it("interpolates the project name into every rendering", () => {
    for (const rendered of [renderInstructions(ctx), renderAgentsMd(ctx), renderSkillMd(ctx)]) {
      expect(rendered).toContain("widgets");
    }
  });

  it("interpolates the jira URL into every rendering when configured", () => {
    for (const rendered of [renderInstructions(ctx), renderAgentsMd(ctx), renderSkillMd(ctx)]) {
      expect(rendered).toContain("https://acme.atlassian.net");
    }
  });

  it("omits any jira mention when not configured", () => {
    const noJira: OnboardingContext = { project: "widgets" };
    expect(renderOnboardingBody(noJira)).not.toMatch(/Jira: /);
  });

  it("only SKILL.md carries frontmatter", () => {
    expect(renderInstructions(ctx).startsWith("---")).toBe(false);
    expect(renderAgentsMd(ctx).startsWith("---")).toBe(false);
    expect(renderSkillMd(ctx).startsWith("---")).toBe(true);
  });

  it("SKILL.md frontmatter carries the exact name/description Claude Code discovers the skill by", () => {
    const frontmatter = renderSkillFrontmatter();
    expect(frontmatter).toMatch(/^---\nname: slopworks\ndescription: >\n/);
    expect(frontmatter.trim().endsWith("---")).toBe(true);
    // The folded (`>`) scalar's lines, rejoined, reproduce the exact
    // canonical description with no words dropped or duplicated by the
    // wrapping — the wrap is presentation-only.
    const foldedBody = frontmatter
      .split("\n")
      .filter((line) => line.startsWith("  "))
      .map((line) => line.trim())
      .join(" ");
    expect(foldedBody).toBe(SKILL_DESCRIPTION);
    expect(SKILL_NAME).toBe("slopworks");
  });

  it("neither `update`'s nor `show`'s corrected claims mention a nonexistent flag", () => {
    // Regression guard for the two corrections against draft-v0-SKILL.md
    // called out in content.ts: `update` has no `--blocks` flag, and
    // `show` has neither `--json` nor `--budget`.
    const body = renderOnboardingBody(ctx);
    expect(body).not.toMatch(/update <current> --state open.*--blocks/s);
    expect(body).not.toMatch(/--json --budget N.*on `ready`\/`show`/s);
  });
});
