/**
 * `--parent <ref>` resolution for `slop new` (B1) — a local ref (full id /
 * slug / short prefix, via `resolveTicketRef`) or an external ref like
 * `jira:PROJ-123` (D1: "External parents from day one"). Also computes the
 * resulting `root_id`/`path` (D6), since that computation is entirely
 * determined by which of the three cases above applies.
 */
import type { Ticket, TicketId } from "../core/index.js";
import { EXTERNAL_REF_PATTERN, checkJiraRefFormat } from "../core/entities/ref.js";
import type { RepoPaths } from "../repo/paths.js";
import { resolveTicketRef } from "../repo/refs.js";

export type ParentResolution =
  | { kind: "none" }
  | { kind: "external"; ref: string; warning?: string }
  | { kind: "local"; ticket: Ticket };

/**
 * Resolve `raw` (the `--parent` flag's value, or `undefined` if omitted).
 * An external-shaped ref (`<system>:<key>`, e.g. `jira:PROJ-123`) is never
 * looked up locally — it's accepted as-is, with `checkJiraRefFormat`'s
 * warn-only format check attached (design.md §8.2 item 5: "warn on format
 * mismatch, don't block" — a malformed `jira:` ref still returns a `kind:
 * "external"` result here, just with `warning` set; it is the caller's job
 * to print that warning and proceed regardless). Anything else is resolved
 * as a local ref via `resolveTicketRef` (full id / slug / short prefix,
 * per D12/D6/§8.1 item 5) — which throws NOT_FOUND / AMBIGUOUS_REF /
 * USAGE_ERROR exactly as any other local-ref lookup would.
 */
export async function resolveParentRef(
  paths: RepoPaths,
  raw: string | undefined,
): Promise<ParentResolution> {
  if (raw === undefined) return { kind: "none" };
  if (EXTERNAL_REF_PATTERN.test(raw)) {
    const check = checkJiraRefFormat(raw);
    return { kind: "external", ref: raw, warning: check.warning };
  }
  const ticket = await resolveTicketRef(paths, raw);
  return { kind: "local", ticket };
}

export interface Ancestry {
  /** The value to store on `ticket.parent` — `undefined` for no parent at all. */
  parent: string | undefined;
  rootId: TicketId;
  path: TicketId[];
}

/**
 * D6/D1: for a local parent, inherit `root_id`/`path` from it (this
 * ticket's path is the parent's path plus the parent itself). For an
 * external parent OR no parent at all, this ticket has no local ancestor
 * to inherit from, so it becomes its own local root with an empty path —
 * D1's "external parents terminate the local tree" restated as the
 * `root_id`/`path` computation. `selfId` is the new ticket's own freshly
 * -minted id (the caller mints it before calling this, since a "none"/
 * "external" result needs it for `root_id`).
 */
export function ancestryFor(resolution: ParentResolution, selfId: TicketId): Ancestry {
  if (resolution.kind === "local") {
    return {
      parent: resolution.ticket.id,
      rootId: resolution.ticket.root_id,
      path: [...resolution.ticket.path, resolution.ticket.id],
    };
  }
  if (resolution.kind === "external") {
    return { parent: resolution.ref, rootId: selfId, path: [] };
  }
  return { parent: undefined, rootId: selfId, path: [] };
}
