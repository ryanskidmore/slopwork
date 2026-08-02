import { GitPullRequestArrow } from "lucide-react";
import type { ReviewResponseDTO } from "../../api/types.js";
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

function loadReview(signal: AbortSignal): Promise<ReviewResponseDTO> {
  return fetchReview({ signal });
}

export function ReviewPage() {
  const { data, error, loading, retry } = useApiQuery<ReviewResponseDTO>(loadReview);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Review</h1>
        {data && (
          <p className="text-sm text-muted-foreground">
            {data.tickets.length} ticket{data.tickets.length === 1 ? "" : "s"} awaiting review,
            longest-waiting first. Stale threshold: {data.config.defaults.review_stale_after}.
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

      {data && data.tickets.length === 0 && (
        <EmptyState
          icon={GitPullRequestArrow}
          title="Nothing awaiting review"
          description="Every open review has been resolved."
        />
      )}

      {data && data.tickets.length > 0 && (
        <Table>
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
            {data.tickets.map((ticket) => (
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
      )}
    </div>
  );
}
