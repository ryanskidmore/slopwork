import { ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import type { TreeNodeDTO, TreeResponseDTO } from "../../api/types.js";
import { EmptyState } from "../components/empty-state.js";
import { QueryErrorState } from "../components/query-error-state.js";
import { LabelChips, OverlayBadges, PriorityBadge, StateBadge } from "../components/state-badge.js";
import { TicketLink } from "../components/ticket-link.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.js";
import { useApiQuery } from "../hooks/use-api-query.js";
import { fetchTree } from "../lib/api.js";

export const TREE_EXPANSION_STORAGE_KEY = "slop-web-tree-expanded";

function loadTree(signal: AbortSignal): Promise<TreeResponseDTO> {
  return fetchTree({ signal });
}

function readExpanded(): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(TREE_EXPANSION_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === "string"))
      : null;
  } catch {
    return null;
  }
}

function writeExpanded(expanded: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(TREE_EXPANSION_STORAGE_KEY, JSON.stringify([...expanded].sort()));
  } catch {
    // Storage may be unavailable in privacy mode; the in-memory controls still work.
  }
}

function branchIds(nodes: readonly TreeNodeDTO[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.has_children ? [node.ticket.id] : []),
    ...branchIds(node.children),
  ]);
}

function defaultExpanded(nodes: readonly TreeNodeDTO[]): Set<string> {
  return new Set(nodes.filter((node) => node.has_children).map((node) => node.ticket.id));
}

function TreeNode({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: TreeNodeDTO;
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const hasChildren = node.has_children;
  const isExpanded = hasChildren && expanded.has(node.ticket.id);
  const toggleLabel = `${isExpanded ? "Collapse" : "Expand"} children of ${node.ticket.name}`;

  return (
    <li role="treeitem" aria-expanded={hasChildren ? isExpanded : undefined}>
      <div
        className="grid min-h-9 min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] items-start rounded-md py-1 pr-1.5 hover:bg-accent/60"
        style={{ paddingInlineStart: `${Math.min(depth, 6) * 12}px` }}
      >
        {hasChildren ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={toggleLabel}
                onClick={() => onToggle(node.ticket.id)}
              >
                {isExpanded ? (
                  <ChevronDown aria-hidden="true" />
                ) : (
                  <ChevronRight aria-hidden="true" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{toggleLabel}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="size-7" aria-hidden="true" />
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 pt-1">
          <StateBadge state={node.ticket.state} />
          <PriorityBadge priority={node.ticket.priority} />
          <span className="min-w-0 max-w-full [&_a]:min-w-0 [&_a]:break-words [&>span]:min-w-0 sm:overflow-hidden sm:[&_a]:block sm:[&_a]:truncate sm:[&_a]:break-normal">
            <TicketLink ticket={node.ticket} />
          </span>
          <span className="max-w-full break-all font-mono text-xs text-muted-foreground sm:truncate sm:break-normal">
            {node.ticket.slug}
          </span>
          <OverlayBadges overlay={node.ticket.overlay} />
          <LabelChips labels={node.ticket.labels} />
          {node.external_parent && <ExternalParentBadge parent={node.external_parent} />}
          {node.children_truncated && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                  +more
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Not every child of {node.ticket.name} is shown — the tree view is bounded.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      {isExpanded && (
        <ul role="group" className="border-l border-border/70">
          {node.children.map((child) => (
            <TreeNode
              key={child.ticket.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
            />
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
  const { data, error, loading, retry } = useApiQuery<TreeResponseDTO>(loadTree);
  const [expanded, setExpanded] = useState<Set<string> | null>(() => readExpanded());

  useEffect(() => {
    if (data && expanded === null) setExpanded(defaultExpanded(data.roots));
  }, [data, expanded]);

  useEffect(() => {
    if (expanded !== null) writeExpanded(expanded);
  }, [expanded]);

  const visibleExpanded = expanded ?? new Set<string>();
  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current ?? (data ? defaultExpanded(data.roots) : []));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const hasBranches = Boolean(data && branchIds(data.roots).length > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Tree</h1>
          {data && (
            <p className="text-sm text-muted-foreground">
              {data.roots.length} root{data.roots.length === 1 ? "" : "s"} of {data.total} ticket
              {data.total === 1 ? "" : "s"} total. External parents appear as linked badges.
            </p>
          )}
        </div>
        {hasBranches && (
          <div className="flex shrink-0 items-center gap-1" aria-label="Tree display controls">
            <TreeControl
              label="Expand all branches"
              icon={ChevronsDown}
              onClick={() => setExpanded(new Set(branchIds(data?.roots ?? [])))}
            />
            <TreeControl
              label="Collapse all branches"
              icon={ChevronsUp}
              onClick={() => setExpanded(new Set())}
            />
          </div>
        )}
      </div>

      {loading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-7 w-1/2" />
          <Skeleton className="h-7 w-3/5" />
        </div>
      )}

      {error && <QueryErrorState title="Ticket tree unavailable" error={error} onRetry={retry} />}

      {data && data.truncated && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Showing {data.returned} of {data.total} tickets — this view is bounded (max{" "}
          {data.bounds.max_nodes} nodes, {data.bounds.max_depth} levels deep). Narrow your search or
          use the ticket list for the full set.
        </p>
      )}

      {data && data.roots.length === 0 && (
        <EmptyState
          icon={GitBranch}
          title="No tickets yet"
          description='Create one with `slop new "..."` from the CLI — this viewer is read-only.'
        />
      )}

      {data && data.roots.length > 0 && (
        <ul role="tree" aria-label="Ticket hierarchy" className="flex min-w-0 flex-col gap-1">
          {data.roots.map((root) => (
            <TreeNode
              key={root.ticket.id}
              node={root}
              depth={0}
              expanded={visibleExpanded}
              onToggle={toggle}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TreeControl({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: typeof ChevronsDown;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon" aria-label={label} onClick={onClick}>
          <Icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
