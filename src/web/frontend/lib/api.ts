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

export interface TreeBounds {
  limit?: number;
  depth?: number;
}

export function fetchBoundedTree(
  bounds: TreeBounds = {},
  options: ApiRequestOptions = {},
): Promise<TreeResponseDTO> {
  const params = new URLSearchParams();
  if (bounds.limit !== undefined) params.set("limit", String(bounds.limit));
  if (bounds.depth !== undefined) params.set("depth", String(bounds.depth));
  const query = params.toString();
  return getJson(`/api/tree${query ? `?${query}` : ""}`, options);
}

/** `page`/`limit` request params shared by every bounded collection fetch
 * below — the SPA-side counterpart of `pagination.ts`'s server-side
 * `parsePage`. */
export interface PageRequest {
  page?: number;
  limit?: number;
}

function pageParams(page: PageRequest, pageParam = "page", limitParam = "limit"): string {
  const params = new URLSearchParams();
  if (page.page !== undefined) params.set(pageParam, String(page.page));
  if (page.limit !== undefined) params.set(limitParam, String(page.limit));
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function fetchTicketDetail(
  ref: string,
  timelinePages: {
    eventsPage?: number;
    eventsLimit?: number;
    sessionsPage?: number;
    sessionsLimit?: number;
  } = {},
  options: ApiRequestOptions = {},
): Promise<TicketDetailDTO> {
  const params = new URLSearchParams();
  if (timelinePages.eventsPage !== undefined)
    params.set("events_page", String(timelinePages.eventsPage));
  if (timelinePages.eventsLimit !== undefined)
    params.set("events_limit", String(timelinePages.eventsLimit));
  if (timelinePages.sessionsPage !== undefined)
    params.set("sessions_page", String(timelinePages.sessionsPage));
  if (timelinePages.sessionsLimit !== undefined)
    params.set("sessions_limit", String(timelinePages.sessionsLimit));
  const query = params.toString();
  return getJson(`/api/tickets/${encodeURIComponent(ref)}${query ? `?${query}` : ""}`, options);
}

export function fetchReview(
  page: PageRequest = {},
  options: ApiRequestOptions = {},
): Promise<ReviewResponseDTO> {
  return getJson(`/api/review${pageParams(page)}`, options);
}

export function fetchStale(
  page: PageRequest = {},
  options: ApiRequestOptions = {},
): Promise<StaleResponseDTO> {
  return getJson(`/api/stale${pageParams(page)}`, options);
}

export function fetchQuestions(
  page: PageRequest = {},
  options: ApiRequestOptions = {},
): Promise<QuestionsResponseDTO> {
  return getJson(`/api/questions${pageParams(page)}`, options);
}
