import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import type { TreeNodeDTO, TreeResponseDTO } from "../../api/types.js";
import { EmptyState } from "../components/empty-state.js";
import { LabelChips, OverlayBadges, PriorityBadge, StateBadge } from "../components/state-badge.js";
import { TicketLink } from "../components/ticket-link.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { fetchTree } from "../lib/api.js";

function TreeNode({ node }: { node: TreeNodeDTO }) {
  return (
    <li>
      <div className="flex flex-wrap items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent/60">
        <StateBadge state={node.ticket.state} />
        <PriorityBadge priority={node.ticket.priority} />
        <TicketLink ticket={node.ticket} />
        <span className="font-mono text-xs text-muted-foreground">{node.ticket.slug}</span>
        <OverlayBadges overlay={node.ticket.overlay} />
        <LabelChips labels={node.ticket.labels} />
        {node.external_parent && <ExternalParentBadge parent={node.external_parent} />}
      </div>
      {node.children.length > 0 && (
        <ul className="ml-5 border-l border-border pl-3">
          {node.children.map((child) => (
            <TreeNode key={child.ticket.id} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ExternalParentBadge({ parent }: { parent: NonNullable<TreeNodeDTO["external_parent"]> }) {
  // `parent.safe_url` is already scheme-checked server-side (src/web/url-safety.ts's
  // safeUrl, via src/web/api/shared.ts's externalParentDto) — null means "unsafe or
  // unconfigured", never a value this component needs to re-validate.
  if (parent.safe_url) {
    return (
      <a
        href={parent.safe_url}
        target="_blank"
        rel="noopener noreferrer"
        title="External parent in Jira"
        className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
      >
        ↑ {parent.ref}
      </a>
    );
  }
  return (
    <span
      title="External parent (no remote URL configured)"
      className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
    >
      ↑ {parent.ref}
    </span>
  );
}

export function TreePage() {
  const [data, setData] = useState<TreeResponseDTO | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTree().then((res) => {
      if (!cancelled) setData(res);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Tree</h1>
        {data && (
          <p className="text-sm text-muted-foreground">
            {data.roots.length} root{data.roots.length === 1 ? "" : "s"} of {data.total} ticket
            {data.total === 1 ? "" : "s"} total. External parents show as an "↑" badge, not a node
            you can open.
          </p>
        )}
      </div>

      {!data && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-7 w-1/2" />
          <Skeleton className="h-7 w-3/5" />
        </div>
      )}

      {data && data.roots.length === 0 && (
        <EmptyState
          icon={GitBranch}
          title="No tickets yet"
          description='Create one with `slop new "..."` from the CLI — this viewer is read-only.'
        />
      )}

      {data && data.roots.length > 0 && (
        <ul className="flex flex-col gap-1">
          {data.roots.map((root) => (
            <TreeNode key={root.ticket.id} node={root} />
          ))}
        </ul>
      )}
    </div>
  );
}
