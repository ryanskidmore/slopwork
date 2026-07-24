/**
 * Pure diff between two {@link PlanVersion}s (C2 acceptance criterion:
 * "plan v2 diffable from v1"). No I/O, no clock — a plain structural
 * comparison so it's trivially unit-testable and reusable from both the
 * `slop plan` CLI output and the context-pack renderer (`plan-render.ts`).
 *
 * **Matching rule (documented, not fuzzy):** a step in `after` is matched
 * to a step in `before` iff their `text` is character-for-character
 * identical. Duplicate step text within one version is matched in order —
 * greedily, against the earliest not-yet-claimed `before` step with equal
 * text — so two steps that happen to read the same are paired
 * deterministically without any edit-distance/similarity heuristic.
 * `src/sessions/plan.ts`'s `buildPlanSteps` (carrying checked state forward
 * across a revision) uses the exact same rule, so the two stay consistent:
 * whatever this module reports as "kept", `buildPlanSteps` already carried
 * checked state forward for.
 */
import type { PlanStep, PlanVersion } from "../core/entities/session.js";

export interface PlanDiffAdded {
  kind: "added";
  text: string;
  afterIndex: number;
}

export interface PlanDiffRemoved {
  kind: "removed";
  text: string;
  beforeIndex: number;
}

export interface PlanDiffKept {
  kind: "kept";
  text: string;
  beforeIndex: number;
  afterIndex: number;
  /** `true` iff this step's position changed between versions. */
  moved: boolean;
  checkedBefore: boolean;
  checkedAfter: boolean;
  checkedChanged: boolean;
}

export type PlanDiffEntry = PlanDiffAdded | PlanDiffRemoved | PlanDiffKept;

export interface PlanDiff {
  fromVersion: number;
  toVersion: number;
  entries: PlanDiffEntry[];
}

/**
 * Diff `before` -> `after`. Entry order: every `after` step first (in its
 * own order — "added" and "kept" interleaved as they appear in the new
 * version), then any unmatched `before` steps ("removed"), in their
 * original order. Removed entries are appended rather than interleaved
 * into their old position — there is no single "correct" position to
 * interleave a removed line into a list that no longer contains it, so
 * this doesn't pretend to guess one.
 */
export function diffPlanVersions(before: PlanVersion, after: PlanVersion): PlanDiff {
  const claimed = Array.from({ length: before.steps.length }, () => false);
  const entries: PlanDiffEntry[] = [];

  after.steps.forEach((afterStep, afterIndex) => {
    const beforeIndex = before.steps.findIndex(
      (beforeStep, i) => !claimed[i] && beforeStep.text === afterStep.text,
    );
    if (beforeIndex === -1) {
      entries.push({ kind: "added", text: afterStep.text, afterIndex });
      return;
    }
    claimed[beforeIndex] = true;
    const beforeStep = before.steps[beforeIndex] as PlanStep;
    entries.push({
      kind: "kept",
      text: afterStep.text,
      beforeIndex,
      afterIndex,
      moved: beforeIndex !== afterIndex,
      checkedBefore: beforeStep.checked,
      checkedAfter: afterStep.checked,
      checkedChanged: beforeStep.checked !== afterStep.checked,
    });
  });

  before.steps.forEach((beforeStep, beforeIndex) => {
    if (!claimed[beforeIndex]) {
      entries.push({ kind: "removed", text: beforeStep.text, beforeIndex });
    }
  });

  return { fromVersion: before.version, toVersion: after.version, entries };
}

/** One-line human summary of a {@link PlanDiff}, e.g. `"+1 added, 1
 * check-state changed"` — used for compact rendering (plan-render.ts) and
 * the `slop plan` revision confirmation line. */
export function summarizePlanDiff(diff: PlanDiff): string {
  const added = diff.entries.filter((e) => e.kind === "added").length;
  const removed = diff.entries.filter((e) => e.kind === "removed").length;
  const moved = diff.entries.filter((e) => e.kind === "kept" && e.moved).length;
  const checkedChanged = diff.entries.filter((e) => e.kind === "kept" && e.checkedChanged).length;

  const parts: string[] = [];
  if (added > 0) parts.push(`+${added} added`);
  if (removed > 0) parts.push(`-${removed} removed`);
  if (moved > 0) parts.push(`${moved} reordered`);
  if (checkedChanged > 0) parts.push(`${checkedChanged} check-state changed`);
  return parts.length > 0 ? parts.join(", ") : "no step changes";
}

/** One line per {@link PlanDiffEntry}, git-diff-flavoured: `+` added, `-`
 * removed, `~` kept but checked-state changed, `→` kept but reordered, `=`
 * kept unchanged. A step can be both reordered and checked-state-changed
 * at once — `~` wins in that case since the check-state change is the more
 * salient fact for a human reading `slop plan`'s output. */
export function renderPlanDiffLines(diff: PlanDiff): string[] {
  return diff.entries.map((e) => {
    if (e.kind === "added") return `  + ${e.text}`;
    if (e.kind === "removed") return `  - ${e.text}`;
    const checkbox = e.checkedAfter ? "x" : " ";
    const marker = e.checkedChanged ? "~" : e.moved ? "→" : "=";
    const moveNote = e.moved
      ? ` (v${diff.fromVersion}#${e.beforeIndex + 1} -> v${diff.toVersion}#${e.afterIndex + 1})`
      : "";
    const checkNote = e.checkedChanged ? ` (checked: ${e.checkedBefore} -> ${e.checkedAfter})` : "";
    return `  ${marker} [${checkbox}] ${e.text}${moveNote}${checkNote}`;
  });
}
