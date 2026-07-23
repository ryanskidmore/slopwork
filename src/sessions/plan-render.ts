/**
 * Pure rendering of a session's plan (steps + checked state + version
 * history) to plain-text lines — the "step status in `show`" half of C2's
 * acceptance criterion, and the "diffability is actually observable"
 * half.
 *
 * Deliberately its own module, separate from `src/tickets/context.ts`
 * (whose `renderContextPack` is the one, small call site that uses this):
 * B3 is concurrently editing `src/cli/commands/show.ts`, so the rendering
 * logic itself lives here where it can be fully unit-tested in isolation,
 * and the integration into the shared pack renderer is a minimal,
 * reviewable diff (see that file for the one loop this hooks into).
 */
import type { PlanStep, PlanVersion, Session } from "../core/index.js";
import { diffPlanVersions, summarizePlanDiff } from "./plan-diff.js";

function renderStepLine(step: PlanStep, index: number): string {
  return `      ${index + 1}. [${step.checked ? "x" : " "}] ${step.text}`;
}

/** The latest version's checklist, with a header naming which version it
 * is out of how many, and a checked/total count. */
export function renderLatestPlanVersion(version: PlanVersion, totalVersions: number): string[] {
  const checkedCount = version.steps.filter((s) => s.checked).length;
  const lines: string[] = [
    `    plan: v${version.version} of ${totalVersions} ` +
      `(${checkedCount}/${version.steps.length} checked, set ${version.created_at})`,
  ];
  if (version.steps.length === 0) {
    lines.push("      (no steps)");
  } else {
    for (const [i, step] of version.steps.entries()) lines.push(renderStepLine(step, i));
  }
  return lines;
}

/** One summary line per consecutive version pair — this is what makes "plan
 * v2 diffable from v1" observable through `show`/`context`, not just true
 * of the underlying data. Empty when there's at most one version (nothing
 * to diff yet). */
export function renderPlanHistory(plan: readonly PlanVersion[]): string[] {
  if (plan.length < 2) return [];
  const lines: string[] = ["    plan history:"];
  for (let i = 1; i < plan.length; i++) {
    const before = plan[i - 1] as PlanVersion;
    const after = plan[i] as PlanVersion;
    const diff = diffPlanVersions(before, after);
    lines.push(`      v${before.version} -> v${after.version}: ${summarizePlanDiff(diff)}`);
  }
  return lines;
}

/**
 * Full plan block for one session: latest version's checklist + version
 * history summary. Returns `[]` when the session has no plan at all
 * (`session.plan.length === 0`) — sessions predating C2, or a session that
 * was never planned, add no noise to the pack rather than rendering an
 * empty "no plan" section for every one of them.
 */
export function renderSessionPlanSection(session: Session): string[] {
  if (session.plan.length === 0) return [];
  const latest = session.plan.at(-1) as PlanVersion;
  return [
    ...renderLatestPlanVersion(latest, session.plan.length),
    ...renderPlanHistory(session.plan),
  ];
}
