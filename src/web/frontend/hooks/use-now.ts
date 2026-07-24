import { useEffect, useState } from "react";

/** A wall-clock timestamp that re-renders every `intervalMs` (default 30s)
 * — so "3m ago" / staleness badges quietly advance without a manual
 * refresh, without polling the API. Respects `prefers-reduced-motion`
 * only in the sense that this drives text updates, never animation; no
 * special-casing needed there. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
