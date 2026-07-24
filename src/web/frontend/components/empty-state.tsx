import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Real empty states that tell the user what to do (quality-floor
 * requirement) — every list/panel/timeline in this app renders one of
 * these instead of a bare "no results" when it has nothing to show. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <Icon className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
