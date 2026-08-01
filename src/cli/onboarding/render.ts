/**
 * Renders `content.ts`'s single canonical source three ways (work item
 * D1): `slop instructions`, `.slop/AGENTS.md`, and
 * `.claude/skills/slopwork/SKILL.md`. All three call
 * {@link renderOnboardingBody} for their body text — the only difference
 * between them is SKILL.md's YAML frontmatter wrapper. That is what makes
 * the "genuinely derive from the same source" acceptance clause true by
 * construction rather than by discipline: add an entry to `content.ts`'s
 * arrays and all three outputs pick it up on their next render, with
 * nothing else to touch.
 */
import {
  EDGE_CASES,
  HOUSE_RULES,
  LOOP_STEPS,
  REF_RESOLUTION,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  WHEN_TO_ACT,
} from "./content.js";

/** Project-specific values interpolated into the rendered body (D1 brief: "project name, jira URL if configured"). */
export interface OnboardingContext {
  /** `config.yaml`'s `project` (design.md §3). */
  project: string;
  /** `config.yaml`'s `remotes.jira`, only when configured and non-blank. */
  jiraUrl?: string;
}

function wrapText(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.map((line) => `${indent}${line}`).join("\n");
}

function projectLine(ctx: OnboardingContext): string {
  const jiraNote = ctx.jiraUrl ? ` — Jira: ${ctx.jiraUrl}` : "";
  return `Project: **${ctx.project}**${jiraNote}`;
}

function whenToActTable(): string {
  const header = "| Situation | Do this |\n|---|---|";
  const rows = WHEN_TO_ACT.map((row) => `| ${row.situation} | ${row.action} |`);
  return [header, ...rows].join("\n");
}

/**
 * The markdown body shared, verbatim, by every onboarding surface. This
 * is "the one source" D1 requires — see content.ts's module doc.
 */
export function renderOnboardingBody(ctx: OnboardingContext): string {
  const loop = LOOP_STEPS.map((step, i) => `${i + 1}. ${step}`).join("\n");
  const rules = HOUSE_RULES.map((rule, i) => `${i + 1}. ${rule}`).join("\n");
  const edgeCases = EDGE_CASES.map((edgeCase) => `- ${edgeCase}`).join("\n");

  return `# Slopwork

${projectLine(ctx)}

Slopwork (\`slop\`) tracks work as a dependency graph of tickets. You read it to know what to do, you write to it as you work, and humans audit your trail (sessions, plans, progress, MRs). Run \`slop instructions\` anytime for this project's local copy of these rules.

## When to act, at a glance

${whenToActTable()}

## The loop (default for every ticket)

${loop}

## Rules

${rules}

## Reference resolution

${REF_RESOLUTION}

## Edge cases

${edgeCases}
`;
}

/** `slop instructions` — printed to stdout (src/cli/commands/instructions.ts). */
export function renderInstructions(ctx: OnboardingContext): string {
  return renderOnboardingBody(ctx);
}

/** `.slop/AGENTS.md` — written by `slop init`, committed (design.md §3). */
export function renderAgentsMd(ctx: OnboardingContext): string {
  return renderOnboardingBody(ctx);
}

/**
 * SKILL.md's YAML frontmatter. Claude Code discovers/triggers the skill
 * from `name`/`description` here (the pre-v0 draft's own frontmatter
 * shape) — this is the one piece of the three renderings that only
 * SKILL.md carries, since it's meaningless to `slop instructions`'
 * stdout output or to AGENTS.md.
 */
export function renderSkillFrontmatter(): string {
  const wrapped = wrapText(SKILL_DESCRIPTION, 78, "  ");
  return `---
name: ${SKILL_NAME}
description: >
${wrapped}
---

`;
}

/** `.claude/skills/slopwork/SKILL.md` — installed by `slop init` only when a Claude Code setup is detected. */
export function renderSkillMd(ctx: OnboardingContext): string {
  return renderSkillFrontmatter() + renderOnboardingBody(ctx);
}
