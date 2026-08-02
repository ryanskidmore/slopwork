/**
 * Registers the full v0 command surface (design.md §4.2 — all 22
 * commands) onto the root program, grouped in `--help` output the way
 * §4.2 groups them.
 *
 * A1 registers every command now, with its real description, arguments,
 * and flags, so `slop --help` is complete and correct from day one.
 * Later work items replace each command's `.action()` body — the
 * registration below is not theirs to redo.
 */
import type { Command } from "commander";
import { registerAnswerCommand } from "./answer.js";
import { registerAskCommand } from "./ask.js";
import { registerContextCommand } from "./context.js";
import { registerDoneCommand } from "./done.js";
import { registerDraftCommand } from "./draft.js";
import { registerDropCommand } from "./drop.js";
import { registerEditCommand } from "./edit.js";
import { registerEventsCommand } from "./events.js";
import { registerInitCommand } from "./init.js";
import { registerInstructionsCommand } from "./instructions.js";
import { registerListCommand } from "./list.js";
import { registerNewCommand } from "./new.js";
import { registerPlanCommand } from "./plan.js";
import { registerQuestionsCommand } from "./questions.js";
import { registerReadyCommand } from "./ready.js";
import { registerReindexCommand } from "./reindex.js";
import { registerReviewCommand } from "./review.js";
import { registerSearchCommand } from "./search.js";
import { registerShowCommand } from "./show.js";
import { registerSplitCommand } from "./split.js";
import { registerStartCommand } from "./start.js";
import { registerStatusCommand } from "./status.js";
import { registerStopCommand } from "./stop.js";
import { registerUndraftCommand } from "./undraft.js";
import { registerUpdateCommand } from "./update.js";
import { registerWebCommand } from "./web.js";

export function registerCommands(program: Command): void {
  program.commandsGroup("Setup & maintenance:");
  registerInitCommand(program);
  registerInstructionsCommand(program);
  registerReindexCommand(program);

  program.commandsGroup("Creating & shaping:");
  registerNewCommand(program);
  registerSplitCommand(program);
  registerDraftCommand(program);
  registerUndraftCommand(program);
  registerEditCommand(program);
  registerUpdateCommand(program);

  program.commandsGroup("The agent loop:");
  registerReadyCommand(program);
  registerStartCommand(program);
  registerContextCommand(program);
  registerPlanCommand(program);
  registerAskCommand(program);
  registerAnswerCommand(program);
  registerReviewCommand(program);
  registerStopCommand(program);
  registerDoneCommand(program);
  registerDropCommand(program);

  program.commandsGroup("Inspecting:");
  registerStatusCommand(program);
  registerShowCommand(program);
  registerListCommand(program);
  registerSearchCommand(program);
  registerQuestionsCommand(program);
  registerEventsCommand(program);
  registerWebCommand(program);
}
