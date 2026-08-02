import { ChevronLeft, ChevronRight, ListChecks, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { TicketListResponseDTO } from "../../api/types.js";
import { OverlayBadges, PriorityBadge, StateBadge } from "../components/state-badge.js";
import { TicketLink } from "../components/ticket-link.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
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

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const PAGE_SIZE_OPTIONS = [25, 50, 100];
const SEARCH_DEBOUNCE_MS = 250;

function positiveIntegerParam(value: string | null, fallback: number, max?: number): number {
  if (value === null || !/^[1-9]\d*$/.test(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (max !== undefined && parsed > max)) return fallback;
  return parsed;
}

export function TicketsPage() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<TicketListResponseDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestPending, setRequestPending] = useState(false);

  const state = params.get("state") ?? "";
  const label = params.get("label") ?? "";
  const priority = params.get("priority") ?? "";
  const owner = params.get("owner") ?? "";
  const q = params.get("q") ?? "";
  const page = positiveIntegerParam(params.get("page"), 1);
  const limit = positiveIntegerParam(params.get("limit"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const [searchInput, setSearchInput] = useState(q);
  const paramsKey = params.toString();

  useEffect(() => {
    setSearchInput(q);
  }, [q]);

  useEffect(() => {
    if (searchInput === q) return;
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(paramsKey);
      if (searchInput) next.set("q", searchInput);
      else next.delete("q");
      next.delete("page");
      setParams(next, { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [paramsKey, q, searchInput, setParams]);

  useEffect(() => {
    // A keystroke aborts the old query immediately; the debounced URL value
    // starts its replacement request only after it catches up with the input.
    if (searchInput !== q) return;
    const controller = new AbortController();
    setRequestPending(true);
    setError(null);
    fetchTicketList(
      { state, label, priority, owner, q, page, limit },
      { signal: controller.signal },
    )
      .then((res) => {
        if (!controller.signal.aborted) setData(res);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setRequestPending(false);
      });
    return () => {
      controller.abort();
    };
  }, [state, label, priority, owner, q, page, limit, searchInput]);

  const now = useNow();

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    setParams(next, { replace: true });
  };

  const setPage = (nextPage: number) => {
    const next = new URLSearchParams(params);
    if (nextPage === 1) next.delete("page");
    else next.set("page", String(nextPage));
    setParams(next, { replace: true });
  };

  const clearFilters = () => {
    const next = new URLSearchParams();
    if (limit !== DEFAULT_PAGE_SIZE) next.set("limit", String(limit));
    setSearchInput("");
    setParams(next, { replace: true });
  };

  const hasFilters = Boolean(state || label || priority || owner || q);
  const pending = requestPending || searchInput !== q;
  const filteredTotal = data?.pagination.filtered_total ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Tickets</h1>
        <div className="flex min-h-5 min-w-40 items-center justify-end text-sm text-muted-foreground">
          {pending ? (
            <span className="inline-flex items-center gap-1.5" aria-live="polite">
              <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" /> Updating
            </span>
          ) : data ? (
            <span>
              {hasFilters ? `${filteredTotal} matches of ${data.total}` : `${data.total} tickets`}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect
          id="ticket-state-filter"
          label="State"
          value={state}
          onChange={(v) => setFilter("state", v)}
          options={(data?.facets.states ?? []).map((s) => ({
            value: s,
            label: STATE_LABELS[s] ?? s,
          }))}
        />
        <FilterSelect
          id="ticket-label-filter"
          label="Label"
          value={label}
          onChange={(v) => setFilter("label", v)}
          options={(data?.facets.labels ?? []).map((l) => ({ value: l, label: l }))}
        />
        <FilterSelect
          id="ticket-priority-filter"
          label="Priority"
          value={priority}
          onChange={(v) => setFilter("priority", v)}
          options={["0", "1", "2", "3"].map((p) => ({ value: p, label: `P${p}` }))}
        />
        <FilterSelect
          id="ticket-owner-filter"
          label="Owner"
          value={owner}
          onChange={(v) => setFilter("owner", v)}
          options={(data?.facets.owners ?? []).map((o) => ({ value: o, label: o }))}
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor="ticket-search">Search</Label>
          <Input
            id="ticket-search"
            type="search"
            value={searchInput}
            onChange={(event) => {
              setError(null);
              setSearchInput(event.target.value);
            }}
            placeholder="name, slug, summary…"
            className="w-56"
          />
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
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
          title={
            filteredTotal > 0
              ? "No tickets on this page"
              : hasFilters
                ? "No tickets match these filters"
                : "No tickets yet"
          }
          description={
            filteredTotal > 0
              ? "The requested page is past the available results."
              : hasFilters
                ? "Try clearing a filter or broadening your search."
                : 'Create one with `slop new "..."` from the CLI — this viewer is read-only.'
          }
          action={
            filteredTotal > 0 ? (
              <Button variant="outline" size="sm" onClick={() => setPage(1)}>
                First page
              </Button>
            ) : hasFilters ? (
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      )}

      {data && data.tickets.length > 0 && (
        <Table
          aria-busy={pending}
          className={pending ? "opacity-60 transition-opacity" : undefined}
        >
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

      {data && filteredTotal > 0 && (
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="ticket-page-size">Rows per page</Label>
            <Select
              value={String(data.pagination.limit)}
              onValueChange={(value) => setFilter("limit", value)}
            >
              <SelectTrigger
                id="ticket-page-size"
                size="sm"
                className="w-20"
                aria-label="Rows per page"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...new Set([...PAGE_SIZE_OPTIONS, data.pagination.limit])]
                  .sort((a, b) => a - b)
                  .map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <p className="min-w-32 text-center text-xs text-muted-foreground">
            {data.tickets.length > 0
              ? `${(data.pagination.page - 1) * data.pagination.limit + 1}-${
                  (data.pagination.page - 1) * data.pagination.limit + data.tickets.length
                } of ${filteredTotal}`
              : `0 of ${filteredTotal}`}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous page"
              title="Previous page"
              disabled={data.pagination.previous_page === null || pending}
              onClick={() => setPage(data.pagination.previous_page ?? 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <span className="min-w-24 text-center text-sm tabular-nums">
              Page {data.pagination.page} of {Math.max(1, data.pagination.total_pages)}
            </span>
            <Button
              variant="outline"
              size="icon"
              aria-label="Next page"
              title="Next page"
              disabled={data.pagination.next_page === null || pending}
              onClick={() => setPage(data.pagination.next_page ?? data.pagination.page)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value || "__all__"} onValueChange={(v) => onChange(v === "__all__" ? "" : v)}>
        <SelectTrigger id={id} size="sm" className="w-36" aria-label={`${label} filter`}>
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
