import { ListChecks, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { TicketListResponseDTO } from "../../api/types.js";
import { OverlayBadges, PriorityBadge, StateBadge } from "../components/state-badge.js";
import { TicketLink } from "../components/ticket-link.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { Skeleton } from "../components/ui/skeleton.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { EmptyState } from "../components/empty-state.js";
import { useNow } from "../hooks/use-now.js";
import { fetchTicketList } from "../lib/api.js";
import { formatAbsolute, formatRelative } from "../lib/format.js";

const STATE_LABELS: Record<string, string> = {
  draft: "Draft",
  open: "Open",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
  dropped: "Dropped",
};

export function TicketsPage() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<TicketListResponseDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  const state = params.get("state") ?? "";
  const label = params.get("label") ?? "";
  const priority = params.get("priority") ?? "";
  const owner = params.get("owner") ?? "";
  const q = params.get("q") ?? "";

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchTicketList({ state, label, priority, owner, q })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [state, label, priority, owner, q]);

  const now = useNow();

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const hasFilters = Boolean(state || label || priority || owner || q);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Tickets</h1>
        {data && (
          <p className="text-sm text-muted-foreground">
            {data.tickets.length} of {data.total} ticket{data.total === 1 ? "" : "s"}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect
          label="State"
          value={state}
          onChange={(v) => setFilter("state", v)}
          options={(data?.facets.states ?? []).map((s) => ({
            value: s,
            label: STATE_LABELS[s] ?? s,
          }))}
        />
        <FilterSelect
          label="Label"
          value={label}
          onChange={(v) => setFilter("label", v)}
          options={(data?.facets.labels ?? []).map((l) => ({ value: l, label: l }))}
        />
        <FilterSelect
          label="Priority"
          value={priority}
          onChange={(v) => setFilter("priority", v)}
          options={["0", "1", "2", "3"].map((p) => ({ value: p, label: `P${p}` }))}
        />
        <FilterSelect
          label="Owner"
          value={owner}
          onChange={(v) => setFilter("owner", v)}
          options={(data?.facets.owners ?? []).map((o) => ({ value: o, label: o }))}
        />
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Search</span>
          <Input
            value={q}
            onChange={(e) => setFilter("q", e.target.value)}
            placeholder="name, slug, summary…"
            className="w-56"
          />
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => setParams({}, { replace: true })}>
            <X className="size-3.5" /> Clear filters
          </Button>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Failed to load tickets: {error}
        </p>
      )}

      {!data && !error && <TicketsSkeleton />}

      {data && data.tickets.length === 0 && (
        <EmptyState
          icon={ListChecks}
          title={hasFilters ? "No tickets match these filters" : "No tickets yet"}
          description={
            hasFilters
              ? "Try clearing a filter or broadening your search."
              : 'Create one with `slop new "..."` from the CLI — this viewer is read-only.'
          }
          action={
            hasFilters ? (
              <Button variant="outline" size="sm" onClick={() => setParams({}, { replace: true })}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      )}

      {data && data.tickets.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>State</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Labels</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Last activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.tickets.map((ticket) => (
              <TableRow key={ticket.id}>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    <StateBadge state={ticket.state} />
                    <OverlayBadges overlay={ticket.overlay} />
                  </div>
                </TableCell>
                <TableCell>
                  <PriorityBadge priority={ticket.priority} />
                </TableCell>
                <TableCell className="font-medium">
                  <TicketLink ticket={ticket} />
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {ticket.slug}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {ticket.labels.map((l) => (
                      <span
                        key={l}
                        className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                      >
                        {l}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-sm">
                  {ticket.owner?.name ?? <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell
                  className="text-sm text-muted-foreground"
                  title={formatAbsolute(ticket.last_activity_at)}
                >
                  {formatRelative(ticket.last_activity_at, now)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Select value={value || "__all__"} onValueChange={(v) => onChange(v === "__all__" ? "" : v)}>
        <SelectTrigger size="sm" className="w-36">
          <SelectValue placeholder="All" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">All</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const SKELETON_ROW_IDS = ["a", "b", "c", "d", "e", "f"];

function TicketsSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {SKELETON_ROW_IDS.map((id) => (
        <Skeleton key={id} className="h-9 w-full" />
      ))}
    </div>
  );
}
