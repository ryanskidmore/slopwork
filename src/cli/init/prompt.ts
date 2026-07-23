/**
 * TTY-safe interactive prompting for `slop init` (D1: "prompt for
 * `remotes.jira` interactively only when stdin is a TTY... An agent
 * running `slop init` unattended must never block on a prompt").
 *
 * {@link isInteractive} is the gate every prompting call site must check
 * BEFORE constructing a readline interface — never rely on a prompt
 * itself timing out or erroring gracefully on a non-TTY stdin, since a
 * pipe that's simply never closed (the common shape of a harness driving
 * this CLI programmatically) would leave `readline`'s `question()`
 * pending forever.
 */
import { createInterface } from "node:readline/promises";

export interface TtyLike {
  isTTY?: boolean;
}

/**
 * `true` only when both stdin and stdout are real terminals. Takes the
 * streams as parameters (defaulting to the real `process.stdin`/`stdout`)
 * so callers can test the decision itself without faking global process
 * state.
 */
export function isInteractive(
  stdin: TtyLike = process.stdin,
  stdout: TtyLike = process.stdout,
): boolean {
  return Boolean(stdin.isTTY) && Boolean(stdout.isTTY);
}

/** Ask a free-text question. Caller must have already checked {@link isInteractive}. */
export async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** Ask a yes/no question with a default for a bare Enter. Caller must have already checked {@link isInteractive}. */
export async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const raw = (await promptLine(`${question} ${suffix} `)).toLowerCase();
  if (raw.length === 0) return defaultYes;
  return raw.startsWith("y");
}
