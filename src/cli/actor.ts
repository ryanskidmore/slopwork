/**
 * Actor identity resolution (D17) + `.slop/config.yaml` loading — shared
 * plumbing every mutating command needs, not just `new`/`update` (B1).
 * C1 (`start`) and every later mutating command should import
 * {@link resolveActor} rather than re-deriving D17's order themselves.
 *
 * D17, verbatim: "Actor identity resolution order: `--as` flag →
 * `SLOP_ACTOR` env → `user:` in config.yaml → `git config user.name`."
 * The *shape* of that order already lives in
 * core/entities/actor.ts's `resolveActorName` (A2, pure, no I/O) — this
 * module is the I/O half: gathering the four candidate strings (env read,
 * config file read, a `git config` subprocess) and handing them to that
 * pure function, plus deciding the resolved actor's `kind`.
 *
 * design.md §4.2 only shows `--as` on `slop start`; `new`/`update` (and
 * anything else that doesn't register a `--as` flag) simply never pass
 * `asFlag`, which is exactly the "next rung" case `resolveActorName`
 * already handles — this module does not itself decide which commands get
 * a `--as` option, that stays a per-command choice made where the command
 * is registered.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Actor, ActorKind, Config } from "../core/index.js";
import { configSchema, resolveActorName } from "../core/index.js";
import type { RepoPaths } from "../repo/paths.js";
import { detectHarness, sniffHarnessKind } from "../sessions/harness.js";
import { parseConfigYamlText } from "./config-yaml.js";
import { SlopError } from "./errors.js";

/**
 * `git config user.name`, resolved against `cwd` (repo-local falling back
 * to global, per git's own resolution) — `null` on any failure (not a git
 * repo, no such key set, `git` missing from `$PATH`, ...). Deliberately a
 * small self-contained re-implementation rather than importing
 * `src/cli/init/git.ts`'s `getGitUserName`: that module is D1's (off
 * limits to this work item — see the B1 brief's ground rules), and this is
 * a four-line `execFileSync` call, cheap enough that duplicating it here
 * is safer than taking on a cross-lane import into a file another work
 * item owns and may still be reshaping.
 */
export function gitUserName(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const out = execFileSync("git", ["config", "user.name"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Read + parse + validate `.slop/config.yaml`, the same
 * read-JSONC-then-validate shape `src/cli/commands/instructions.ts` (D1)
 * already uses — duplicated rather than imported for the same
 * cross-lane-ownership reason as {@link gitUserName} above (that command
 * module is D1's, mid-flight). `parseConfigYamlText`/`configSchema`
 * themselves are safe, stable, already-shipped primitives (A2's schema,
 * the hand-rolled restricted YAML reader) — only the *file this lives in*
 * is the thing being kept out of D1's way.
 *
 * Every mutating command needs this for D17 (`user:`); `show` needs it for
 * `remotes.jira` browse-URL rendering. Throws a {@link SlopError} with an
 * actionable "run `slop init`" message if config.yaml is missing,
 * unparseable, or fails schema validation — never returns a half-valid
 * config.
 */
export async function loadConfig(paths: RepoPaths): Promise<Config> {
  const configPath = join(paths.slopDir, "config.yaml");
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (err) {
    throw new SlopError(
      `could not read .slop/config.yaml (${(err as Error).message}) — run \`slop init\`.`,
    );
  }

  let raw: unknown;
  try {
    raw = parseConfigYamlText(text);
  } catch (err) {
    throw new SlopError(`.slop/config.yaml could not be parsed: ${(err as Error).message}`);
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new SlopError(
      ".slop/config.yaml does not match the expected shape: " +
        result.error.issues.map((i) => i.message).join("; "),
    );
  }
  return result.data;
}

/**
 * Cheap, env-only signal for whether this process is running *as* (or
 * under the direct control of) a coding-agent harness, reused here purely
 * to pick an {@link Actor}'s `kind` (`"human"` vs `"agent"`) — NOT a
 * general harness-kind detector.
 *
 * **Formalised by C1** (this was a provisional standalone heuristic before
 * C1 landed real `HarnessKind` sniffing, spikes/findings.md §1-§2): now a
 * thin wrapper over `src/sessions/harness.ts`'s {@link sniffHarnessKind},
 * the single canonical sniff C1/C4 both build on, rather than a second,
 * independently-maintained copy of the same three env checks. Behavior for
 * every existing caller is unchanged — this is still exactly "is *some*
 * agent harness driving this process" (kind !== "other"), just no longer
 * its own implementation of that question.
 */
export function isAgentHarnessEnv(env: NodeJS.ProcessEnv): boolean {
  return sniffHarnessKind(env) !== "other";
}

/**
 * `kind` resolution, formalised the same way: run the SAME `HarnessKind`
 * detection `slop start` uses (`detectHarness`, D17 precedence — `
 * --harness` override, if the calling command registered one, always
 * wins over sniffing), and derive `"agent"`/`"human"` from its result
 * (`"other"` = human at the CLI, since a plain shell invocation with no
 * detectable harness is the human-driven case). This is the exact
 * question a bare `Actor.kind` needs — `harnessFlag` only matters for
 * commands that register `--harness` (today, just `slop start`); every
 * other caller omits it and falls straight through to sniffing, same as
 * before.
 */
function actorKind(env: NodeJS.ProcessEnv, harnessFlag?: string | null): ActorKind {
  return detectHarness({ harnessFlag, env }).kind === "other" ? "human" : "agent";
}

export interface ResolveActorOptions {
  /** `--as <name>` flag value, only present on commands that register it (design.md §4.2 shows it on `slop start`). */
  asFlag?: string | null;
  /**
   * `--harness <kind>` flag value, only present on commands that register
   * one (today, just `slop start`, C1) — feeds `kind` resolution through
   * the same D17 override the harness itself uses, so `--as ryan --harness
   * codex` resolves `kind: "agent"` even though `--as` overrides the
   * *name*. Omit entirely on a command with no `--harness` flag; `kind`
   * then falls back to plain env sniffing, same as before C1.
   */
  harnessFlag?: string | null;
  /** Already-loaded config.yaml, or `null` if none could be loaded (a command that can proceed without one, e.g. before `slop init`). */
  config: Config | null;
  /** Directory to run `git config` in — normally the repo root. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * D17 end-to-end: gather the four candidates in order, resolve a name via
 * `resolveActorName` (A2), and pick a `kind`. Throws a {@link SlopError}
 * (USAGE_ERROR) if nothing resolves at all — every mutation needs a real
 * actor for its event's audit trail (design.md §4.1 item 4), so silently
 * defaulting to some "unknown" placeholder would quietly break that
 * guarantee rather than surface the fixable problem (set `SLOP_ACTOR`,
 * `user:` in config.yaml, or `git config user.name`) to the caller.
 */
export function resolveActor(options: ResolveActorOptions): Actor {
  const env = options.env ?? process.env;
  const name = resolveActorName({
    asFlag: options.asFlag,
    slopActorEnv: env.SLOP_ACTOR,
    configUser: options.config?.user,
    gitUserName: gitUserName(options.cwd, env),
  });
  if (name === null) {
    throw new SlopError(
      "could not determine who is acting: pass --as <name>, set SLOP_ACTOR, set `user:` in " +
        ".slop/config.yaml, or configure `git config user.name` (design.md D17)",
    );
  }
  return { name, kind: actorKind(env, options.harnessFlag) };
}
