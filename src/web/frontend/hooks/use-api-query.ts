import { useCallback, useEffect, useState } from "react";

export const DEFAULT_QUERY_TIMEOUT_MS = 15_000;

interface ApiQueryState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

export interface ApiQueryResult<T> extends ApiQueryState<T> {
  retry: () => void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Shared GET lifecycle for read-only web pages. A request is aborted when
 * the component unmounts, when a retry supersedes it, or when it exceeds the
 * timeout, so a failed or stalled endpoint always reaches a recoverable UI.
 */
export function useApiQuery<T>(
  query: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
): ApiQueryResult<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ApiQueryState<T>>({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let timedOut = false;
    setState({ data: null, error: null, loading: true });

    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    void query(controller.signal)
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          data: null,
          error: timedOut
            ? new Error("The request took too long. Check the server and try again.")
            : asError(error),
          loading: false,
        });
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt, query, timeoutMs]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, retry };
}
