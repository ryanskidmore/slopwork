/**
 * `slop init` — design.md §3, §4.2, §5.1; work item D1.
 *
 * Creates `.slop/`'s full §3 layout, autodetects `config.yaml`'s fields,
 * writes agent onboarding (`.slop/AGENTS.md`, and
 * `.claude/skills/slopwork/SKILL.md` when a Claude Code setup is
 * detected — all rendered from the single canonical source in
 * src/cli/onboarding/), maintains clearly-labelled, idempotent managed
 * sections of `.gitignore` (D14/D16) and `.gitattributes` (t-mgx82: GitHub/
 * GitLab generated-file markers + scoped LF enforcement for the db), and
 * (Fix 4, adversarial review / E2 Defect 2) lays down a tracked `.gitkeep`
 * placeholder in each of `db/tickets/`, `db/sessions/`, `db/events/` so the
 * directory skeleton is always complete and committable, even before any
 * entity of that kind exists — see `writeDbDirPlaceholders`'s doc below.
 *
 * Safety contract this file must uphold end to end: re-running `init`
 * against an already-initialized repo never touches `config.yaml` or any
 * `db/` content — only the generated docs (AGENTS.md/SKILL.md, always
 * fully regenerated — they're pure derivations of config + the canonical
 * source, never hand-edited) and the managed `.gitignore`/`.gitattributes`
 * sections are refreshed. And no code path here may block on stdin unless
 * it already checked {@link isInteractive} — an agent driving this
 * unattended must never hang.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Command } from "commander";
import {
  type Config,
  DEFAULT_REVIEW_STALE_AFTER,
  DEFAULT_STALE_AFTER,
  configSchema,
  resolveActorName,
} from "../../core/index.js";
import { type RepoPaths, atomicWriteFile, ensureDbDirs, findRepoRoot } from "../../repo/index.js";
import { detectClaudeCode } from "../init/claude-detect.js";
import { computeGitattributesLines, upsertGitattributesSection } from "../init/gitattributes.js";
import { computeGitignoreLines, upsertGitignoreSection } from "../init/gitignore.js";
import {
  getGitRemoteUrl,
  getGitTopLevel,
  getGitUserName,
  normalizeGitRemoteToHttps,
} from "../init/git.js";
import { isInteractive, promptLine, promptYesNo } from "../init/prompt.js";
import type { OnboardingContext } from "../onboarding/render.js";
import { renderAgentsMd, renderSkillMd } from "../onboarding/render.js";
import { parseConfigYamlText, stringifyConfigYaml } from "../../core/config-yaml.js";
import { SlopError } from "../errors.js";

interface InitOptions {
  jira?: string;
  project?: string;
  user?: string;
  yes?: boolean;
  linkClaudeMd?: boolean;
}

const CLAUDE_MD_MARKER_START = "<!-- slopwork:start -->";
const CLAUDE_MD_MARKER_END = "<!-- slopwork:end -->";

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

/**
 * Where does `.slop/` belong? Reuses A3's `findRepoRoot` walk-up first —
 * if a `.slop/` already exists anywhere above `cwd`, THAT is the repo
 * `init` operates on (matching git's own "one .git per repo" convention;
 * never create a second, nested `.slop/`). Otherwise, prefer the git
 * repo's top level over bare `cwd` so `.slop/` and `.gitignore` land
 * alongside `.git/` even when `init` is run from a subdirectory; falls
 * back to `cwd` outright when there's no git repo at all (slopwork does
 * not require git).
 */
function determineRoot(cwd: string): { root: string; alreadyInitialized: boolean } {
  const existingRoot = findRepoRoot(cwd);
  if (existingRoot) return { root: existingRoot, alreadyInitialized: true };
  const gitRoot = getGitTopLevel(cwd);
  return { root: gitRoot ?? cwd, alreadyInitialized: false };
}

// ---------------------------------------------------------------------------
// config.yaml: load existing (untouched) or autodetect + write fresh
// ---------------------------------------------------------------------------

/**
 * Jira prompt (D1 brief, verbatim): "prompt for `remotes.jira`
 * interactively only when stdin is a TTY. In non-interactive contexts
 * (agents, CI, tests) it must not hang — skip the prompt and leave it
 * blank." "Leave it blank" here means the config.ts-documented "never
 * prompted" state (the key absent entirely) — distinct from a human
 * being asked and explicitly declining (empty string, see below) — so an
 * unattended `--yes` run and a genuinely non-interactive run both return
 * `undefined`, not `""`.
 */
async function resolveJira(opts: InitOptions): Promise<string | undefined> {
  if (opts.jira !== undefined) return opts.jira;
  if (opts.yes) return undefined;
  if (!isInteractive()) return undefined;
  // A bare Enter here yields "" — explicitly prompted-and-declined, per
  // config.ts's documented distinction from "never prompted".
  return promptLine("Jira base URL (e.g. https://yourorg.atlassian.net), or press Enter to skip: ");
}

async function loadOrCreateConfig(
  paths: RepoPaths,
  root: string,
  opts: InitOptions,
): Promise<{ config: Config; wasExisting: boolean }> {
  const configPath = join(paths.slopDir, "config.yaml");

  if (existsSync(configPath)) {
    const text = await readFile(configPath, "utf8");
    let raw: unknown;
    try {
      raw = parseConfigYamlText(text);
    } catch (err) {
      throw new SlopError(
        `.slop/config.yaml exists but could not be parsed (${(err as Error).message}) — ` +
          "fix or remove it before re-running `slop init`.",
      );
    }
    const result = configSchema.safeParse(raw);
    if (!result.success) {
      throw new SlopError(
        ".slop/config.yaml exists but does not match the expected shape " +
          `(${result.error.issues.map((i) => i.message).join("; ")}) — ` +
          "fix or remove it before re-running `slop init`.",
      );
    }
    return { config: result.data, wasExisting: true };
  }

  const project = opts.project?.trim() || basename(root);

  const gitUserName = getGitUserName(root);
  const user = resolveActorName({ asFlag: opts.user, gitUserName }) ?? undefined;

  const rawRemote = getGitRemoteUrl(root);
  const repo = (rawRemote && normalizeGitRemoteToHttps(rawRemote)) || undefined;

  const jira = await resolveJira(opts);

  const yamlText = stringifyConfigYaml({
    project,
    ...(user !== undefined ? { user } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(jira !== undefined ? { jira } : {}),
    staleAfter: DEFAULT_STALE_AFTER,
    reviewStaleAfter: DEFAULT_REVIEW_STALE_AFTER,
  });

  const config = configSchema.parse(parseConfigYamlText(yamlText));
  await atomicWriteFile(configPath, yamlText);
  return { config, wasExisting: false };
}

// ---------------------------------------------------------------------------
// Fix 4 (adversarial review / E2 Defect 2), part 2: tracked `.gitkeep`
// placeholders in each db entity directory
// ---------------------------------------------------------------------------

/**
 * Git does not track empty directories — a freshly-initialized repo's
 * `tickets/`/`sessions/`/`events/` (created bare by `ensureDbDirs`, above)
 * would otherwise stay entirely absent from git history until the first
 * entity of that kind is created, exactly the gap that let a fresh clone
 * crash on its first write before {@link atomicWriteFile}'s own
 * self-healing fix (`repo/atomic-write.ts`). Part 1 of that fix (the
 * self-heal) makes a missing directory harmless everywhere; THIS is part
 * 2, belt-and-suspenders at the source: every `slop init` now lays down an
 * empty, tracked `.gitkeep` in each of the three directories, so the full
 * db skeleton is always present and committable from the moment a repo is
 * initialized, before any ticket/session/event ever exists. Idempotent —
 * only writes when the file doesn't already exist, so re-running `init`
 * against an already-populated repo (which never needs this) doesn't
 * touch anything. Harmless to real entity reads: `entity-file.ts`'s
 * `listEntityIds` only recognizes `<kind>_<ULID>.jsonc` names, so
 * `.gitkeep` is invisible to every ticket/session/event listing.
 */
async function writeDbDirPlaceholders(paths: RepoPaths): Promise<void> {
  for (const dir of [paths.ticketsDir, paths.sessionsDir, paths.eventsDir]) {
    const gitkeepPath = join(dir, ".gitkeep");
    if (!existsSync(gitkeepPath)) {
      await atomicWriteFile(gitkeepPath, "");
    }
  }
}

// ---------------------------------------------------------------------------
// Generated docs: AGENTS.md + SKILL.md (always regenerated — pure
// derivations of config + the canonical onboarding source, never
// hand-edited, so overwriting them is never "destroying data").
// ---------------------------------------------------------------------------

function onboardingContext(config: Config): OnboardingContext {
  return { project: config.project, jiraUrl: config.remotes.jira || undefined };
}

async function writeAgentsMd(paths: RepoPaths, config: Config): Promise<void> {
  await atomicWriteFile(
    join(paths.slopDir, "AGENTS.md"),
    renderAgentsMd(onboardingContext(config)),
  );
}

/** Installs/refreshes the skill only when a Claude Code setup is detected (D1); returns whether it did. */
async function maybeInstallSkill(root: string, config: Config): Promise<boolean> {
  if (!detectClaudeCode(root)) return false;
  const skillDir = join(root, ".claude", "skills", "slopwork");
  await mkdir(skillDir, { recursive: true });
  await atomicWriteFile(join(skillDir, "SKILL.md"), renderSkillMd(onboardingContext(config)));
  return true;
}

// ---------------------------------------------------------------------------
// .gitignore (D14/D16)
// ---------------------------------------------------------------------------

async function updateGitignore(root: string): Promise<void> {
  const gitignorePath = join(root, ".gitignore");
  const existing = existsSync(gitignorePath) ? await readFile(gitignorePath, "utf8") : "";
  const { text, changed } = upsertGitignoreSection(existing, computeGitignoreLines());
  if (changed) {
    await atomicWriteFile(gitignorePath, text);
  }
}

// ---------------------------------------------------------------------------
// .gitattributes (t-mgx82)
// ---------------------------------------------------------------------------

async function updateGitattributes(root: string): Promise<void> {
  const gitattributesPath = join(root, ".gitattributes");
  const existing = existsSync(gitattributesPath) ? await readFile(gitattributesPath, "utf8") : "";
  const { text, changed } = upsertGitattributesSection(existing, computeGitattributesLines());
  if (changed) {
    await atomicWriteFile(gitattributesPath, text);
  }
}

// ---------------------------------------------------------------------------
// CLAUDE.md link offer (design.md §5.1)
// ---------------------------------------------------------------------------

function claudeMdPointerBlock(): string {
  return [
    CLAUDE_MD_MARKER_START,
    "## Slopwork",
    "",
    "This repo tracks work with Slopwork (`slop`). Read `.slop/AGENTS.md` (or run " +
      "`slop instructions`) before starting any ticket work.",
    CLAUDE_MD_MARKER_END,
  ].join("\n");
}

type ClaudeMdResult = "linked" | "already-linked" | "skipped" | "not-found";

/**
 * design.md §5.1: "`slop init` writes `.slop/AGENTS.md` (+ `CLAUDE.md`
 * link offer)". Never touches a CLAUDE.md that doesn't already exist
 * (this offers a pointer, it doesn't create the file), never rewrites it
 * without either an explicit `--link-claude-md` flag or an interactive
 * yes, and is idempotent (checks for its own marker first).
 */
async function maybeLinkClaudeMd(root: string, opts: InitOptions): Promise<ClaudeMdResult> {
  const claudeMdPath = join(root, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) return "not-found";

  const existing = await readFile(claudeMdPath, "utf8");
  if (existing.includes(CLAUDE_MD_MARKER_START)) return "already-linked";

  let shouldLink = opts.linkClaudeMd === true;
  if (!shouldLink && !opts.yes && isInteractive()) {
    shouldLink = await promptYesNo(
      "CLAUDE.md found — add a pointer to slopwork (.slop/AGENTS.md / `slop instructions`)?",
      false,
    );
  }
  if (!shouldLink) return "skipped";

  // Exactly one blank line before the appended block, regardless of
  // whether `existing` already ends with a trailing newline or not.
  const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  await atomicWriteFile(claudeMdPath, `${existing}${separator}${claudeMdPointerBlock()}\n`);
  return "linked";
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(args: {
  root: string;
  alreadyInitialized: boolean;
  wasExisting: boolean;
  skillInstalled: boolean;
  claudeMdResult: ClaudeMdResult;
}): void {
  const { root, alreadyInitialized, wasExisting, skillInstalled, claudeMdResult } = args;

  if (alreadyInitialized && wasExisting) {
    process.stdout.write(
      `slopwork is already initialized at ${root} — config.yaml and db/ left untouched; ` +
        `refreshed AGENTS.md${skillInstalled ? "/SKILL.md" : ""}, .gitignore, and .gitattributes.\n`,
    );
  } else {
    process.stdout.write(`Initialized slopwork at ${root}\n`);
  }

  process.stdout.write(
    `  .slop/config.yaml   ${wasExisting ? "(existing, untouched)" : "(created)"}\n`,
  );
  process.stdout.write("  .slop/AGENTS.md     (generated)\n");
  if (skillInstalled) {
    process.stdout.write(
      "  .claude/skills/slopwork/SKILL.md   (generated — Claude Code setup detected)\n",
    );
  }
  process.stdout.write("  .gitignore          (slopwork section up to date)\n");
  process.stdout.write("  .gitattributes      (slopwork section up to date)\n");

  if (claudeMdResult === "linked") {
    process.stdout.write("  CLAUDE.md           (added a pointer to slopwork)\n");
  } else if (claudeMdResult === "skipped") {
    process.stdout.write(
      "  CLAUDE.md found but not linked — re-run `slop init --link-claude-md` to add a pointer.\n",
    );
  }

  process.stdout.write(
    "\nWhat next:\n" +
      "  slop instructions        print this project's agent onboarding rules\n" +
      '  slop new "<name>"        file your first ticket\n' +
      "  slop ready                see what's ready to work on\n",
  );
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runInit(opts: InitOptions): Promise<void> {
  const { root, alreadyInitialized } = determineRoot(process.cwd());

  const paths = await ensureDbDirs(root);
  await writeDbDirPlaceholders(paths);

  const { config, wasExisting } = await loadOrCreateConfig(paths, root, opts);

  await writeAgentsMd(paths, config);
  const skillInstalled = await maybeInstallSkill(root, config);
  await updateGitignore(root);
  await updateGitattributes(root);
  const claudeMdResult = await maybeLinkClaudeMd(root, opts);

  report({ root, alreadyInitialized, wasExisting, skillInstalled, claudeMdResult });
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description(
      "Initialize .slop/ in this repo: config.yaml (with repo/jira autodetection), " +
        "db/ directories, AGENTS.md, and managed gitignore/gitattributes entries.",
    )
    .option("--jira <url>", 'set remotes.jira non-interactively (pass "" for explicitly blank)')
    .option("--project <name>", "override the autodetected project name")
    .option("--user <name>", "override the autodetected user (D17 config rung)")
    .option("--yes", "accept all detected defaults; never prompt")
    .option("--link-claude-md", "non-interactively add a slopwork pointer to an existing CLAUDE.md")
    .action(async (opts: InitOptions) => {
      await runInit(opts);
    });
}
