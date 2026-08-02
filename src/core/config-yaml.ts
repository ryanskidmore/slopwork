/**
 * Canonical `.slop/config.yaml` codec.
 *
 * Parsing is intentionally separate from schema validation: this module
 * implements YAML 1.2 syntax and returns the resulting JavaScript value;
 * `configSchema` remains the authority for accepted keys, value types,
 * defaults, and normalisation. Keeping the codec runtime-neutral lets CLI,
 * storage selection, tests, and `slop web` use identical semantics without
 * depending on Bun globals.
 */
import { parse, stringify } from "yaml";

const YAML_OPTIONS = {
  version: "1.2" as const,
  schema: "core" as const,
  strict: true,
  uniqueKeys: true,
  prettyErrors: true,
  // Callers own diagnostics and strict/tolerant policy; parser warnings must
  // not become a second, caller-dependent output channel.
  logLevel: "error" as const,
};

/** Parse exactly one YAML 1.2 document into plain JavaScript values. */
export function parseConfigYamlText(text: string): unknown {
  return parse(text, YAML_OPTIONS);
}

/** Values `slop init` knows when it creates a new config file. */
export interface ConfigYamlInput {
  project: string;
  /** Omit entirely when detection found nothing (D17 falls back further at read time). */
  user?: string;
  /** Omit entirely when autodetection found no git remote. */
  repo?: string;
  /** `undefined` = never prompted; `""` = prompted and explicitly declined. */
  jira?: string;
  staleAfter: string;
  reviewStaleAfter: string;
}

/**
 * Render a fresh config using the same YAML implementation used to read it.
 * Object insertion order keeps the documented project/user/remotes/defaults
 * layout stable; the library owns scalar escaping and quoting. Existing
 * config files are never rewritten by `slop init`.
 */
export function stringifyConfigYaml(input: ConfigYamlInput): string {
  const remotes: Record<string, string> = {};
  if (input.repo !== undefined) remotes.repo = input.repo;
  if (input.jira !== undefined) remotes.jira = input.jira;

  return stringify(
    {
      project: input.project,
      ...(input.user !== undefined ? { user: input.user } : {}),
      remotes,
      defaults: {
        stale_after: input.staleAfter,
        review_stale_after: input.reviewStaleAfter,
      },
    },
    YAML_OPTIONS,
  );
}
