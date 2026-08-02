import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaginationDTO } from "../../api/types.js";
import { DEFAULT_QUERY_TIMEOUT_MS } from "./use-api-query.js";

export interface LoadMorePage<T> {
  items: T[];
  pagination: PaginationDTO;
}

/**
 * "Load more" state for one page/limit-bounded collection (the review/
 * stale/questions panels; a ticket's events and sessions timelines) —
 * accumulates additional pages fetched on demand onto the initial page a
 * page's own `useApiQuery` already loaded, same resilient pending/error/
 * abort posture that hook gives the first page.
 */
export function useLoadMoreCollection<T>(
  initialItems: readonly T[],
  initialPagination: PaginationDTO | null,
  loadPage: (page: number, signal: AbortSignal) => Promise<LoadMorePage<T>>,
  resetKey: string,
) {
  const [additionalItems, setAdditionalItems] = useState<T[]>([]);
  const [pagination, setPagination] = useState<PaginationDTO | null>(initialPagination);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    controllerRef.current?.abort();
    setAdditionalItems([]);
    setPagination(initialPagination);
    setPending(false);
    setError(null);
  }, [initialPagination, resetKey]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const loadMore = useCallback(async () => {
    const nextPage = pagination?.next_page;
    if (!nextPage || pending) return;

    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setPending(true);
    setError(null);
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DEFAULT_QUERY_TIMEOUT_MS);

    try {
      const page = await loadPage(nextPage, controller.signal);
      if (controller.signal.aborted) return;
      setAdditionalItems((current) => [...current, ...page.items]);
      setPagination(page.pagination);
    } catch (err) {
      if (controller.signal.aborted && !timedOut) return;
      setError(
        timedOut
          ? new Error("The request took too long. Check the server and try again.")
          : err instanceof Error
            ? err
            : new Error(String(err)),
      );
    } finally {
      window.clearTimeout(timeout);
      if (controllerRef.current === controller) controllerRef.current = null;
      if (!controller.signal.aborted || timedOut) setPending(false);
    }
  }, [loadPage, pagination, pending]);

  const items = useMemo(
    () => [...initialItems, ...additionalItems],
    [initialItems, additionalItems],
  );
  return { items, pagination, pending, error, loadMore };
}
