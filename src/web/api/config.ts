/**
 * `GET /api/config` — the same config projection embedded in every other
 * response, exposed standalone so the SPA's app shell (topbar project
 * name, config-fault-tolerance warning banner) can load it once up front
 * without waiting on a page-specific fetch.
 */
import type { BunRequest } from "bun";
import type { WebDataSource } from "../data-source.js";
import { configDto, jsonResponse } from "./shared.js";

export async function handleConfig(_req: BunRequest, dataSource: WebDataSource): Promise<Response> {
  const [{ config, warning }, eventResult] = await Promise.all([
    dataSource.getConfig(),
    dataSource.listEvents(),
  ]);
  return jsonResponse(configDto(config, warning, eventResult.problems));
}
