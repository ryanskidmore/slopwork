import type { Command } from "commander";
import { EXIT_CODES } from "../../core/index.js";
import type { SessionId } from "../../core/index.js";
import {
  readSession,
  readTicket,
  repoPaths,
  requireRepoRoot,
  resolveTicketRef,
  updateSession,
  withLock,
} from "../../repo/index.js";
import {
  diffPlanVersions,
  renderPlanDiffLines,
  summarizePlanDiff,
} from "../../sessions/plan-diff.js";
import {
  assertHasActiveSession,
  buildPlanStepToggle,
  buildPlanVersion,
} from "../../sessions/plan.js";
import { diffSessionPatch } from "../../sessions/patch.js";
import { renderLatestPlanVersion } from "../../sessions/plan-render.js";
import { loadConfig, resolveActor } from "../actor.js";
import { SlopError } from "../errors.js";
import { parseIntegerOption } from "./shared.js";

interface PlanCommandOptions {
  check?: number;
  uncheck?: number;
}

/**
 * Validate the mutually-exclusive shapes `slop plan` accepts (usage
 * mistakes, exit 2 — never a state/data problem):
 *   - step text XOR `--check`/`--uncheck` — never both, never neither.
 *   - `--check` XOR `--uncheck` — never both at once.
 */
function assertValidInvocation(steps: string[], opts: PlanCommandOptions): void {
  const hasSteps = steps.length > 0;
  const hasCheck = opts.check !== undefined;
  const hasUncheck = opts.uncheck !== undefined;

  if (hasCheck && hasUncheck) {
    throw new SlopError("pass either --check or --uncheck, not both", EXIT_CODES.USAGE_ERROR);
  }
  if (hasSteps && (hasCheck || hasUncheck)) {
    throw new SlopError(
      "pass either plan steps (to set/revise the plan) or --check/--uncheck (to toggle a step), not both",
      EXIT_CODES.USAGE_ERROR,
    );
  }
  if (!hasSteps && !hasCheck && !hasUncheck) {
    throw new SlopError(
      'nothing to do: pass plan steps (`slop plan <ref> "step 1" "step 2"`) or --check N / --uncheck N',
      EXIT_CODES.USAGE_ERROR,
    );
  }
}

export async function runPlan(
  ref: string,
  steps: string[],
  opts: PlanCommandOptions,
): Promise<void> {
  assertValidInvocation(steps, opts);

  const root = requireRepoRoot(process.cwd());
  const paths = repoPaths(root);
  const config = await loadConfig(paths);
  const actor = resolveActor({ config, cwd: root });

  const initialTicket = await resolveTicketRef(paths, ref);

  const result = await withLock(paths.lockFile, async () => {
    const current = await readTicket(paths, initialTicket.id);
    assertHasActiveSession(current);
    const sessionId = current.active_session as SessionId;
    const session = await readSession(paths, sessionId);

    if (steps.length > 0) {
      const { session: updated, isFirstVersion, version } = buildPlanVersion(session, steps);
      await updateSession(
        paths,
        session.id,
        diffSessionPatch(session, updated, ["plan"]),
        updated,
        { actor, session: session.id },
        {
          verb: isFirstVersion ? "plan.set" : "plan.revised",
          payload: { version: version.version, step_count: version.steps.length },
        },
      );
      return { kind: "set" as const, ticket: current, session: updated, version };
    }

    const checked = opts.check !== undefined;
    // assertValidInvocation already guarantees exactly one of these is set.
    const stepNumber = (opts.check ?? opts.uncheck) as number;
    const updated = buildPlanStepToggle(session, stepNumber, checked);
    await updateSession(
      paths,
      session.id,
      diffSessionPatch(session, updated, ["plan"]),
      updated,
      { actor, session: session.id },
      { verb: "plan.step_checked", payload: { step: stepNumber, checked } },
    );
    return { kind: "toggle" as const, ticket: current, session: updated, stepNumber, checked };
  });

  if (result.kind === "set") {
    const { ticket, session, version } = result;
    const label = version.version === 1 ? "set" : "revised";
    process.stdout.write(
      `plan v${version.version} ${label} for ${session.id} on ${ticket.id} (${ticket.slug})\n`,
    );
    process.stdout.write(`${renderLatestPlanVersion(version, session.plan.length).join("\n")}\n`);
    if (version.version > 1) {
      const before = session.plan[session.plan.length - 2];
      if (before) {
        const diff = diffPlanVersions(before, version);
        process.stdout.write(
          `\ndiff v${before.version} -> v${version.version} (${summarizePlanDiff(diff)}):\n`,
        );
        process.stdout.write(`${renderPlanDiffLines(diff).join("\n")}\n`);
      }
    }
    return;
  }

  const { ticket, session, stepNumber, checked } = result;
  const latest = session.plan[session.plan.length - 1];
  process.stdout.write(
    `step ${stepNumber} ${checked ? "checked" : "unchecked"} on ${session.id} (${ticket.slug}), ` +
      `plan v${latest?.version ?? "?"} (no new version — check-state is not versioned)\n`,
  );
  if (latest)
    process.stdout.write(`${renderLatestPlanVersion(latest, session.plan.length).join("\n")}\n`);
}

/** `slop plan` — design.md §2, §4.2, §4.1 item 3; work item C2.
 *
 * Either sets/revises the ticket's active session's step checklist
 * (`slop plan <ref> "step 1" "step 2"`, appending a new {@link
 * PlanVersion} every call — v1 is diffable from v2, etc.) or toggles one
 * step's checked state on the CURRENT version (`--check N` / `--uncheck
 * N`, **1-based** — §5's agent-loop examples read step numbers to a human
 * that way) without creating a new version.
 */
export function registerPlanCommand(program: Command): void {
  program
    .command("plan")
    .description(
      "Set/revise the active session's plan (new version each call), or check/uncheck a step " +
        "(1-based) on the current version.",
    )
    .argument("<ref>", "ticket whose session plan to change")
    .argument("[steps...]", 'plan steps, e.g. "step 1" "step 2"')
    .option(
      "--check <n>",
      "check off step N (1-based) on the current plan version",
      parseIntegerOption("--check"),
    )
    .option(
      "--uncheck <n>",
      "uncheck step N (1-based) on the current plan version",
      parseIntegerOption("--uncheck"),
    )
    .action(runPlan);
}
