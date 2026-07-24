/**
 * The state/overlay vocabulary — used identically in the ticket list, tree,
 * review/stale panels, and ticket detail (design direction: "State is the
 * design system... one semantic color+shape language, used identically in
 * every view"). Six fixed ticket-state colors (index.css's `--state-*`
 * tokens) plus two lower-chroma OVERLAY badges (`blocked`/`stale`) that are
 * deliberately shaped differently (an icon + outline treatment, not a
 * solid fill) so they read as "attention, layered on top" rather than
 * competing with the primary state pill for the same visual channel.
 */
import { Ban, Clock } from "lucide-react";
import type { OverlayDTO, TicketState } from "../../api/types.js";
import { formatDurationShort } from "../lib/format.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.js";

const STATE_LABELS: Record<TicketState, string> = {
  draft: "Draft",
  open: "Open",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
  dropped: "Dropped",
};

// Written as literal, per-state class strings (not a template literal) so
// Tailwind's build-time class scanner (scripts/build-frontend.ts's
// bun-plugin-tailwind step) sees every `bg-state-*`/`text-state-*-foreground`
// utility it needs to generate — a dynamically-interpolated class name
// (`` `bg-state-${state}` ``) would never appear in the source text the
// scanner reads, and Tailwind v4 has no runtime class generation.
const STATE_CLASSES: Record<TicketState, string> = {
  draft: "bg-state-draft text-state-draft-foreground",
  open: "bg-state-open text-state-open-foreground",
  in_progress: "bg-state-in_progress text-state-in_progress-foreground",
  review: "bg-state-review text-state-review-foreground",
  done: "bg-state-done text-state-done-foreground",
  dropped: "bg-state-dropped text-state-dropped-foreground",
};

export function StateBadge({ state, className }: { state: TicketState; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium leading-none whitespace-nowrap ${STATE_CLASSES[state]} ${className ?? ""}`}
    >
      {STATE_LABELS[state]}
    </span>
  );
}

const PRIORITY_LABELS = ["P0", "P1", "P2", "P3"];
const PRIORITY_TITLES = ["urgent", "high", "normal", "low"];
// Same literal-class-string reasoning as STATE_CLASSES above.
const PRIORITY_CLASSES = [
  "text-priority-0",
  "text-priority-1",
  "text-priority-2",
  "text-priority-3",
];

export function PriorityBadge({ priority }: { priority: number }) {
  const index = Math.min(3, Math.max(0, priority));
  const label = PRIORITY_LABELS[index] ?? `P${priority}`;
  const title = PRIORITY_TITLES[index] ?? "";
  return (
    <span
      className={`${PRIORITY_CLASSES[index]} font-mono text-xs font-semibold`}
      title={title ? `Priority: ${title}` : undefined}
    >
      {label}
    </span>
  );
}

export function BlockedBadge({ reason }: { reason?: string }) {
  const badge = (
    <span className="inline-flex items-center gap-1 rounded-md border border-overlay-blocked/50 px-1.5 py-0.5 text-xs font-medium text-overlay-blocked">
      <Ban className="size-3" aria-hidden="true" />
      Blocked
    </span>
  );
  if (!reason) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

export function StaleBadge({ reason }: { reason?: string }) {
  const badge = (
    <span className="inline-flex items-center gap-1 rounded-md border border-overlay-stale/60 px-1.5 py-0.5 text-xs font-medium text-overlay-stale">
      <Clock className="size-3" aria-hidden="true" />
      Stale
    </span>
  );
  if (!reason) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

export function overlayReasonText(overlay: OverlayDTO): string | undefined {
  if (!overlay.stale_reason) return undefined;
  const r = overlay.stale_reason;
  return r.state === "review"
    ? `Awaiting review since ${r.since} (idle ${formatDurationShort(r.idle_ms)}, threshold ${r.threshold})`
    : `No activity since ${r.since} (idle ${formatDurationShort(r.idle_ms)}, threshold ${r.threshold})`;
}

export function OverlayBadges({ overlay }: { overlay: OverlayDTO }) {
  if (!overlay.blocked && !overlay.stale) return null;
  return (
    <>
      {overlay.blocked && (
        <BlockedBadge
          reason={
            overlay.blocked_by.length > 0
              ? `Blocked by ${overlay.blocked_by.map((b) => b.name).join(", ")}`
              : undefined
          }
        />
      )}
      {overlay.stale && <StaleBadge reason={overlayReasonText(overlay)} />}
    </>
  );
}

export function LabelChips({ labels }: { labels: readonly string[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {labels.map((label) => (
        <span
          key={label}
          className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          {label}
        </span>
      ))}
    </span>
  );
}
