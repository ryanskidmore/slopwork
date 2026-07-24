/** Client-side time/duration formatting — mirrors src/web/overlays.ts's
 * formatDurationShort/formatRelative exactly (same thresholds, same compact
 * shape) so a badge's "idle for 3h" reads identically whether it was
 * server-derived (the initial payload) or recomputed client-side (a live
 * tick — see hooks/use-now.ts). */
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function formatDurationShort(ms: number): string {
  if (ms < MINUTE) return "<1m";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.floor((ms % HOUR) / MINUTE);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

export function msSince(iso: string, nowMs: number): number {
  return Math.max(0, nowMs - Date.parse(iso));
}

export function formatRelative(iso: string, nowMs: number): string {
  const ms = msSince(iso, nowMs);
  if (ms < MINUTE) return "just now";
  return `${formatDurationShort(ms)} ago`;
}

/** Full, locale-aware absolute timestamp — used in `title=`/tooltips next to a relative label. */
export function formatAbsolute(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
