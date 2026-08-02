import { TimerReset } from "lucide-react";
import { useCallback } from "react";
import type { StaleResponseDTO } from "../../api/types.js";
import { CollectionLoadMore } from "../components/collection-load-more.js";
import { EmptyState } from "../components/empty-state.js";
import { QueryErrorState } from "../components/query-error-state.js";
import { PriorityBadge, StateBadge } from "../components/state-badge.js";
import { TicketLink } from "../components/ticket-link.js";
import { Skeleton } from "../components/ui/skeleton.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { useNow } from "../hooks/use-now.js";
import { useApiQuery } from "../hooks/use-api-query.js";
import { useLoadMoreCollection } from "../hooks/use-load-more-collection.js";
import { fetchStale } from "../lib/api.js";
import { formatAbsolute, formatRelative } from "../lib/format.js";

function loadStale(signal: AbortSignal): Promise<StaleResponseDTO> {
  return fetchStale({}, { signal });
}

export function StalePage() {
  const { data, error, loading, retry } = useApiQuery<StaleResponseDTO>(loadStale);
  const loadMorePage = useCallback(
    (page: number, signal: AbortSignal) =>
      fetchStale({ page }, { signal }).then((response) => ({
        items: response.rows,
        pagination: response.pagination,
      })),
    [],
  );
  const collection = useLoadMoreCollection(
    data?.rows ?? [],
    data?.pagination ?? null,
    loadMorePage,
    "stale",
  );
  // See review-page.tsx's identical comment: `collection.pagination` (not
  // `data.pagination`) is the one source of truth, and is nullable.
  const total = collection.pagination?.total ?? 0;
  const now = useNow();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Stale / resumable</h1>
        {data && (
          <p className="text-sm text-muted-foreground">
            {total} ticket{total === 1 ? "" : "s"} idle past threshold (in_progress:{" "}
            {data.config.defaults.stale_after}, review: {data.config.defaults.review_stale_after}),
            longest-idle first.
          </p>
        )}
      </div>

      {loading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}

      {error && <QueryErrorState title="Stale queue unavailable" error={error} onRetry={retry} />}

      {data && total === 0 && (
        <EmptyState
          icon={TimerReset}
          title="Nothing stale right now"
          description="Everything in progress or in review is moving."
        />
      )}

      {data && total > 0 && (
        <div className="flex flex-col gap-3">
          <Table aria-busy={collection.pending}>
            <TableHeader>
              <TableRow>
                <TableHead>State</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Ticket</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Idle for</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {collection.items.map(({ ticket, since }) => (
                <TableRow key={ticket.id}>
                  <TableCell>
                    <StateBadge state={ticket.state} />
                  </TableCell>
                  <TableCell>
                    <PriorityBadge priority={ticket.priority} />
                  </TableCell>
                  <TableCell className="font-medium">
                    <TicketLink ticket={ticket} />
                  </TableCell>
                  <TableCell>
                    {ticket.owner?.name ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell title={formatAbsolute(since)}>{formatRelative(since, now)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <CollectionLoadMore
            pagination={collection.pagination}
            loaded={collection.items.length}
            pending={collection.pending}
            error={collection.error}
            onLoadMore={collection.loadMore}
            noun="tickets"
          />
        </div>
      )}
    </div>
  );
}
