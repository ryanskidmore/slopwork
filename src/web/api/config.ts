/**
 * `GET /api/config` — the same config projection embedded in every other
 * response, exposed standalone so the SPA's app shell (topbar project
 * name, config-fault-tolerance warning banner) can load it once up front
 * without waiting on a page-specific fetch.
 */
import type { BunRequest } from "bun";
import type { EventReadProblem } from "../../storage/backend.js";
import type { WebDataSource } from "../data-source.js";
import { configDto, jsonResponse } from "./shared.js";

/**
 * `dataSource.getConfig()` reads `.slop/config.yaml` directly and never
 * throws (web-corrupt-or-missing-config) — it works regardless of which
 * `backend:` the same config selects, since backend selection itself comes
 * FROM this file. `listEvents()` has no such guarantee: a `backend: remote`
 * config (RemoteBackend, storage/remote.ts) fails every method, including
 * this one, by design (there is no real remote implementation yet). This
 * is the one endpoint that must still 200 in that configuration (a remote
 * backend is far from implemented, but reporting its own config back is not
 * one of the things it needs the backend for) — a failed event read just
 * means no event-integrity problems to surface, not a broken response.
 */
async function eventProblemsTolerant(
  dataSource: WebDataSource,
): Promise<readonly EventReadProblem[]> {
  try {
    return (await dataSource.listEvents()).problems;
  } catch {
    return [];
  }
}

export async function handleConfig(_req: BunRequest, dataSource: WebDataSource): Promise<Response> {
  const [{ config, warning }, eventProblems] = await Promise.all([
    dataSource.getConfig(),
    eventProblemsTolerant(dataSource),
  ]);
  return jsonResponse(configDto(config, warning, eventProblems));
}
