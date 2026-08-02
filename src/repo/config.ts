/**
 * Tolerant `.slop/config.yaml` `defaults.*` reader — the repo layer's own
 * config access, for `db-index.ts`'s `buildIndex` (C5: `stale_after`/
 * `review_stale_after` thresholds feed `stale_at`/`review_stale_at`).
 *
 * Deliberately NOT `cli/actor.ts`'s `loadConfig`: that function throws a
 * `SlopError` when config.yaml is missing/unparseable/invalid — correct
 * for a mutating command (you cannot resolve an actor without a real
 * config), wrong for `buildIndex`, which must keep working — falling back
 * to `core/entities/config.ts`'s own schema defaults (`DEFAULT_STALE_AFTER`
 * / `DEFAULT_REVIEW_STALE_AFTER`) — for any `.slop/db` the repo layer is
 * asked to index, including every test fixture that writes ticket files
 * directly via `ensureDbDirs` with no `config.yaml` at all (most of
 * A3/B3/B4's own unit tests), and a repo where config.yaml was briefly
 * hand-deleted or mid-edit. `buildIndex` must never throw over a missing
 * config file — every OTHER read path through `loadIndex` (ref resolution,
 * `ready`, `status`, ...) depends on it not to.
 *
 * Reuses `cli/config-yaml.ts`'s `parseConfigYamlText` (a pure, already
 * -tested text->object parser with no I/O of its own) rather than a second
 * implementation of the same restricted YAML subset — the same "reuse a
 * pure cli-owned helper from the repo layer" precedent `repo/paths.ts`/
 * `repo/lock.ts`/`repo/refs.ts` already set by importing `cli/errors.ts`'s
 * `SlopError`. See DECISIONS.md's C5 entry for the fuller rationale.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfigYamlText } from "../cli/config-yaml.js";
import type { BackendSelection, Config, ConfigDefaults } from "../core/index.js";
import { configDefaultsSchema, configSchema, normalizeBackendSelection } from "../core/index.js";
import { DEFAULT_LOCK_TIMEOUT } from "../core/entities/config.js";
import { parseDurationMs } from "../core/duration.js";
import type { RepoPaths } from "./paths.js";

/** `configDefaultsSchema.parse({})` — `DEFAULT_STALE_AFTER`/`DEFAULT_REVIEW_STALE_AFTER`, computed once. */
const SCHEMA_DEFAULTS: ConfigDefaults = configDefaultsSchema.parse({});

/**
 * Shared tolerant read: `.slop/config.yaml`, parsed and schema-validated,
 * or `null` on ANY failure (missing file, unreadable, unparseable YAML
 * text, schema mismatch). Both {@link loadConfigDefaultsTolerant} and
 * {@link loadBackendSelectionTolerant} are thin projections of this one
 * read, so there is exactly one "how do we tolerantly read config.yaml"
 * implementation rather than two independently-drifting copies.
 */
async function tryReadConfigTolerant(paths: RepoPaths): Promise<Config | null> {
  const configPath = join(paths.slopDir, "config.yaml");
  try {
    const text = await readFile(configPath, "utf8");
    const raw = parseConfigYamlText(text);
    const parsed = configSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  } catch {
    // Missing file, unreadable, or unparseable text — fall back below.
    // Deliberately swallowed: this function's whole contract is "never
    // throws," see module doc.
  }
  return null;
}

/**
 * `.slop/config.yaml`'s `defaults.stale_after`/`defaults.review_stale_after`
 * — read tolerantly. Never throws: any failure (missing file, unreadable,
 * unparseable text, schema mismatch) falls back to
 * {@link SCHEMA_DEFAULTS}, so `buildIndex` always has *a* pair of
 * thresholds to compute `stale_at`/`review_stale_at` against.
 */
export async function loadConfigDefaultsTolerant(paths: RepoPaths): Promise<ConfigDefaults> {
  const config = await tryReadConfigTolerant(paths);
  return config?.defaults ?? SCHEMA_DEFAULTS;
}

/** {@link loadBackendSelectionTolerant}'s return shape. */
export interface BackendConfigTolerant {
  /** Normalized `backend:` selection (docs/configuration.md) — `{kind: "flatfile"}` on any read failure. */
  backend: BackendSelection;
  /** `defaults.lock_timeout`, already parsed to milliseconds — {@link DEFAULT_LOCK_TIMEOUT}'s ms value on any read failure. */
  lockTimeoutMs: number;
}

const SCHEMA_DEFAULT_LOCK_TIMEOUT_MS = parseDurationMs(DEFAULT_LOCK_TIMEOUT);

/**
 * G2 (storage backend selection): `.slop/config.yaml`'s `backend:` and
 * `defaults.lock_timeout` — read tolerantly, same policy as
 * {@link loadConfigDefaultsTolerant} and for the same reason: backend
 * selection has to work for every command, including the read-only ones
 * that have never required a valid config.yaml to run (e.g. `slop status`
 * against a repo with no config.yaml at all is a long-standing, deliberate
 * behavior — see `cli/actor.ts`'s `loadConfig`, which DOES throw, being
 * reserved for commands that need a resolved actor). Never throws: any
 * failure falls back to the flatfile default with the hardcoded lock
 * timeout, exactly as if `backend:` and `defaults.lock_timeout` were both
 * absent.
 */
export async function loadBackendSelectionTolerant(
  paths: RepoPaths,
): Promise<BackendConfigTolerant> {
  const config = await tryReadConfigTolerant(paths);
  if (config === null) {
    return { backend: { kind: "flatfile" }, lockTimeoutMs: SCHEMA_DEFAULT_LOCK_TIMEOUT_MS };
  }
  return {
    backend: normalizeBackendSelection(config.backend),
    lockTimeoutMs: parseDurationMs(config.defaults.lock_timeout),
  };
}
