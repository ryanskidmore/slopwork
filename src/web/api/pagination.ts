/**
 * Shared bounding helpers for every `GET /api/*` collection endpoint that
 * `GET /api/tickets` (tickets.ts) didn't already cover: the review/stale/
 * questions panels, a ticket's events/sessions timeline, and the tree
 * endpoint's node/depth budget.
 *
 * `parsePage`/`paginate` deliberately mirror `tickets.ts`'s own inline
 * `parsePagination`/slice-and-count arithmetic exactly — same `page`
 * (1-based, default 1) / `limit` (default/max per caller) query params,
 * same positive-integer validation, same 400 `ApiErrorDTO` wording, same
 * `previous_page`/`next_page` null-at-the-edges convention — rather than
 * inventing a second pagination style for the rest of the API. The one
 * difference from `TicketListPaginationDTO` is `total` instead of a
 * `total`/`filtered_total` pair: none of these collections have a separate
 * filter axis, so there is only one count to report (see `PaginationDTO`).
 */
import { apiErrorResponse } from "./shared.js";
import type { PaginationDTO } from "./types.js";

export const DEFAULT_COLLECTION_PAGE_SIZE = 50;
export const MAX_COLLECTION_PAGE_SIZE = 100;

export interface PageInput {
  page: number;
  limit: number;
}

function parsePositiveInteger(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * `page`/`limit` query-param parsing, factored out of `tickets.ts`'s
 * `parsePagination` so review/stale/questions/ticket-detail all share one
 * implementation instead of re-deriving it. `pageParam`/`limitParam` let a
 * caller with more than one bounded collection on the same request (a
 * ticket's events AND sessions) namespace each one's params independently.
 */
export function parsePage(
  url: URL,
  options: {
    pageParam?: string;
    limitParam?: string;
    defaultLimit?: number;
    maxLimit?: number;
  } = {},
): PageInput | Response {
  const pageParam = options.pageParam ?? "page";
  const limitParam = options.limitParam ?? "limit";
  const defaultLimit = options.defaultLimit ?? DEFAULT_COLLECTION_PAGE_SIZE;
  const maxLimit = options.maxLimit ?? MAX_COLLECTION_PAGE_SIZE;

  const page = parsePositiveInteger(url.searchParams.get(pageParam), 1);
  if (page === null) {
    return apiErrorResponse(`query parameter "${pageParam}" must be a positive integer`, 400);
  }
  const limit = parsePositiveInteger(url.searchParams.get(limitParam), defaultLimit);
  if (limit === null) {
    return apiErrorResponse(`query parameter "${limitParam}" must be a positive integer`, 400);
  }
  if (limit > maxLimit) {
    return apiErrorResponse(`query parameter "${limitParam}" must be at most ${maxLimit}`, 400);
  }
  return { page, limit };
}

/**
 * Slice an already-filtered, already STABLY sorted array into one page —
 * the exact page-start/has-next arithmetic `tickets.ts`'s
 * `handleTicketList` uses. Every caller is responsible for its own stable
 * sort (an explicit id/tiebreak after whatever primary key it uses)
 * *before* calling this: paginating over an unstably-sorted array can
 * duplicate or drop rows across pages.
 */
export function paginate<T>(
  sorted: readonly T[],
  input: PageInput,
): { items: T[]; pagination: PaginationDTO } {
  const total = sorted.length;
  const totalPages = Math.ceil(total / input.limit);
  const start = Math.min(total, (input.page - 1) * input.limit);
  const items = sorted.slice(start, start + input.limit);
  const hasNext = start + items.length < total;
  return {
    items: [...items],
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      total_pages: totalPages,
      previous_page: input.page > 1 ? input.page - 1 : null,
      next_page: hasNext ? input.page + 1 : null,
    },
  };
}

/**
 * A single bounded positive-integer query param with no page/"more" concept
 * of its own — the tree endpoint's `limit` (max nodes returned) and `depth`
 * (max depth walked) budgets, which bound a NESTED structure rather than a
 * flat list page.
 */
export function parseBoundedPositiveInteger(
  url: URL,
  name: string,
  fallback: number,
  maximum: number,
): number | Response {
  const value = parsePositiveInteger(url.searchParams.get(name), fallback);
  if (value === null) {
    return apiErrorResponse(`query parameter "${name}" must be a positive integer`, 400);
  }
  if (value > maximum) {
    return apiErrorResponse(`query parameter "${name}" must be at most ${maximum}`, 400);
  }
  return value;
}
