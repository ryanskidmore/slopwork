/**
 * G2: backend selection. `openStorage` is the ONE place that turns
 * `.slop/config.yaml`'s `backend:` key (docs/configuration.md) into a live
 * {@link StorageBackend} — every command, and the web data source, call
 * this instead of constructing a driver directly.
 *
 * Deliberately self-sufficient: it reads and validates `.slop/config.yaml`
 * itself (via `repo/config.ts`'s tolerant reader — see
 * {@link ../repo/config.js!loadBackendSelectionTolerant}), rather than
 * requiring every caller to have already loaded a `Config` object first.
 * This matters because several commands (`status`, `search`, `ready`,
 * `events`, `context`, `instructions`, `show`) have never required a valid
 * (or even present) config.yaml to run — only mutating commands resolve
 * an actor via `cli/actor.ts`'s `loadConfig`, which DOES throw on a bad
 * config. Backend selection must not newly require what those read-only
 * commands never required before, so it never throws: any config.yaml
 * problem (missing, unparseable, schema-invalid) silently falls back to
 * the flatfile default, identically to how the rest of this repo's
 * "tolerant" readers behave (`repo/config.ts`'s `loadConfigDefaultsTolerant`,
 * `repo/db-index.ts`'s auto-heal). The small redundancy this creates in
 * mutating commands (which separately call `loadConfig` for actor
 * resolution, and so read config.yaml a second time here) is a single tiny
 * file read per invocation — not a hot path — traded for every command
 * having one uniform, unconditional call site: `await
 * openStorage(paths)`, no branching on whether a `Config` happens to
 * already be in hand.
 */
import type { RepoPaths } from "../repo/paths.js";
import { loadBackendSelectionTolerant } from "../repo/config.js";
import type { StorageBackend } from "./backend.js";
import { FlatfileBackend } from "./flatfile.js";
import { RemoteBackend } from "./remote.js";

/**
 * Construct the {@link StorageBackend} `.slop/config.yaml` selects for the
 * repo at `paths`. Never throws — an unreadable/invalid config.yaml
 * degrades to the flatfile default (see module doc), exactly like every
 * other tolerant config read in this codebase.
 */
export async function openStorage(paths: RepoPaths): Promise<StorageBackend> {
  const { backend, lockTimeoutMs } = await loadBackendSelectionTolerant(paths);
  if (backend.kind === "remote") {
    return new RemoteBackend({ url: backend.url });
  }
  return new FlatfileBackend(paths, { lockTimeoutMs });
}
