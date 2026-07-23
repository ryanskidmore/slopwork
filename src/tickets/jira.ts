/**
 * Jira browse-URL rendering for an external `jira:PROJ-123` parent
 * (design.md §4.4 item 2 / D1) — `slop show` renders this exactly like
 * `slop web`'s tree/detail views do (`src/web/views/shared.ts`'s
 * `externalParentBadge`, same `<base>/browse/<key>` formula), just as
 * plain text instead of an HTML badge. Reimplemented locally rather than
 * imported from `src/web/` per the B1 brief's ground rules (that
 * directory is out of scope for this work item to touch or depend on).
 */
import type { Config } from "../core/index.js";
import { parseParentRef } from "../core/entities/ref.js";

export interface JiraRefInfo {
  system: string;
  key: string;
}

/** Split a `jira:PROJ-123`-shaped ref into its system/key halves, or
 * `null` if `ref` isn't external-shaped at all (defensive — callers only
 * ever pass an already-known-external ref, but this never throws). */
export function parseExternalRef(ref: string): JiraRefInfo | null {
  try {
    const parsed = parseParentRef(ref);
    return parsed.kind === "external" ? { system: parsed.system, key: parsed.key } : null;
  } catch {
    return null;
  }
}

/**
 * The Jira browse URL for `ref`, when `ref`'s system is literally `jira`
 * and `config.remotes.jira` is configured (non-blank) — `null` otherwise
 * (no remote configured, or the ref isn't a Jira ref at all), in which
 * case the caller should render the bare ref with no link.
 */
export function jiraBrowseUrl(config: Config, ref: string): string | null {
  const parsed = parseExternalRef(ref);
  if (parsed?.system !== "jira") return null;
  const base = config.remotes.jira;
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/browse/${encodeURIComponent(parsed.key)}`;
}
