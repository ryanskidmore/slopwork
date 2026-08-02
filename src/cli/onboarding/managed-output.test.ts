import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { configSchema } from "../../core/index.js";
import { parseConfigYamlText } from "../config-yaml.js";
import type { OnboardingContext } from "./render.js";
import { renderAgentsMd, renderSkillMd } from "./render.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

function repoOnboardingContext(): OnboardingContext {
  const configText = readFileSync(join(REPO_ROOT, ".slop", "config.yaml"), "utf8");
  const config = configSchema.parse(parseConfigYamlText(configText));
  const jiraUrl = config.remotes.jira;
  return {
    project: config.project,
    ...(jiraUrl ? { jiraUrl } : {}),
  };
}

describe("checked-in managed onboarding", () => {
  const context = repoOnboardingContext();

  it("keeps .slop/AGENTS.md byte-identical to the canonical renderer", () => {
    const actual = readFileSync(join(REPO_ROOT, ".slop", "AGENTS.md"), "utf8");
    expect(actual).toBe(renderAgentsMd(context));
  });

  it("keeps .claude/skills/slopwork/SKILL.md byte-identical to the canonical renderer", () => {
    const actual = readFileSync(
      join(REPO_ROOT, ".claude", "skills", "slopwork", "SKILL.md"),
      "utf8",
    );
    expect(actual).toBe(renderSkillMd(context));
  });
});
