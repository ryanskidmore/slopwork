import { GitPullRequestArrow } from "lucide-react";
import { useCallback } from "react";
import type { ReviewResponseDTO } from "../../api/types.js";
import { CollectionLoadMore } from "../components/collection-load-more.js";
import { EmptyState } from "../components/empty-state.js";
import { QueryErrorState } from "../components/query-error-state.js";
import { PriorityBadge, StaleBadge } from "../components/state-badge.js";
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
import { fetchReview } from "../lib/api.js";
import { formatAbsolute, formatDurationShort } from "../lib/format.js";
import { useApiQuery } from "../hooks/use-api-query.js";
import { useLoadMoreCollection } from "../hooks/use-load-more-collection.js";

function loadReview(signal: AbortSignal): Promise<ReviewResponseDTO> {
  return fetchReview({}, { signal });
}

export function ReviewPage() {
  const { data, error, loading, retry } = useApiQuery<ReviewResponseDTO>(loadReview);
  const loadMorePage = useCallback(
    (page: number, signal: AbortSignal) =>
      fetchReview({ page }, { signal }).then((response) => ({
        items: response.tickets,
        pagination: response.pagination,
      })),
    [],
  );
  const collection = useLoadMoreCollection(
    data?.tickets ?? [],
    data?.pagination ?? null,
    loadMorePage,
    "review",
  );
  // `collection.pagination` (not `data.pagination`) is this page's one
  // source of truth for the total count: it starts as `data.pagination`
  // but is reassigned after every "load more", and — like everything else
  // this hook returns — is explicitly nullable, so a caller can't
  // accidentally assume the wire shape always includes it.
  const total = collection.pagination?.total ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Review</h1>
        {data && (
          <p className="text-sm text-muted-foreground">
            {total} ticket{total === 1 ? "" : "s"} awaiting review, longest-waiting first. Stale
            threshold: {data.config.defaults.review_stale_after}.
          </p>
        )}
      </div>

      {loading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}

      {error && <QueryErrorState title="Review queue unavailable" error={error} onRetry={retry} />}

      {data && total === 0 && (
        <EmptyState
          icon={GitPullRequestArrow}
          title="Nothing awaiting review"
          description="Every open review has been resolved."
        />
      )}

      {data && total > 0 && (
        <div className="flex flex-col gap-3">
          <Table aria-busy={collection.pending}>
            <TableHeader>
              <TableRow>
                <TableHead>Priority</TableHead>
                <TableHead>Ticket</TableHead>
                <TableHead>MR</TableHead>
                <TableHead>Requested by</TableHead>
                <TableHead>Awaiting</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {collection.items.map((ticket) => (
                <TableRow key={ticket.id}>
                  <TableCell>
                    <PriorityBadge priority={ticket.priority} />
                  </TableCell>
                  <TableCell className="font-medium">
                    <TicketLink ticket={ticket} />
                  </TableCell>
                  <TableCell>
                    {ticket.review?.mr ? (
                      ticket.review.mr.safe_url ? (
                        <a
                          href={ticket.review.mr.safe_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline-offset-2 hover:underline"
                        >
                          {ticket.review.mr.url}
                        </a>
                      ) : (
                        <span
                          className="text-muted-foreground"
                          title="Unsafe URL scheme — shown as text"
                        >
                          {ticket.review.mr.url}
                        </span>
                      )
                    ) : (
                      <span className="text-muted-foreground">no MR link</span>
                    )}
                  </TableCell>
                  <TableCell>{ticket.review?.by.name}</TableCell>
                  <TableCell
                    title={ticket.review ? formatAbsolute(ticket.review.requested_at) : undefined}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {ticket.review ? formatDurationShort(ticket.review.awaiting_ms) : "—"}
                      {ticket.overlay.stale && <StaleBadge />}
                    </span>
                  </TableCell>
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
