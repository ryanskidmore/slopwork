/**
 * Thin, typed fetch layer over `/api/*` (src/web/api/types.ts is the wire
 * contract both sides import). Every function here does a plain same-origin
 * GET — the SPA never does anything else (constraint 2: read-only, GET
 * only) — and throws an {@link ApiError} on a non-2xx response so callers
 * (react-router loaders, see pages/*) can rely on the router's own
 * error-boundary handling instead of every page hand-rolling try/catch.
 */
import type {
  ConfigDTO,
  QuestionsResponseDTO,
  ReviewResponseDTO,
  StaleResponseDTO,
  TicketDetailDTO,
  TicketListResponseDTO,
  TreeResponseDTO,
} from "../../api/types.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiRequestOptions {
  signal?: AbortSignal;
}

async function getJson<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const res = await fetch(path, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: options.signal,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body — fall back to the status line
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export function fetchConfig(options: ApiRequestOptions = {}): Promise<ConfigDTO> {
  return getJson("/api/config", options);
}

export interface TicketListFilters {
  state?: string;
  label?: string;
  priority?: string;
  owner?: string;
  q?: string;
  page?: number;
  limit?: number;
}

export function fetchTicketList(
  filters: TicketListFilters = {},
  options: ApiRequestOptions = {},
): Promise<TicketListResponseDTO> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return getJson(`/api/tickets${qs ? `?${qs}` : ""}`, options);
}

export function fetchTree(options: ApiRequestOptions = {}): Promise<TreeResponseDTO> {
  return getJson("/api/tree", options);
}

export function fetchTicketDetail(
  ref: string,
  options: ApiRequestOptions = {},
): Promise<TicketDetailDTO> {
  return getJson(`/api/tickets/${encodeURIComponent(ref)}`, options);
}

export function fetchReview(options: ApiRequestOptions = {}): Promise<ReviewResponseDTO> {
  return getJson("/api/review", options);
}

export function fetchStale(options: ApiRequestOptions = {}): Promise<StaleResponseDTO> {
  return getJson("/api/stale", options);
}

export function fetchQuestions(options: ApiRequestOptions = {}): Promise<QuestionsResponseDTO> {
  return getJson("/api/questions", options);
}
