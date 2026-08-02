import { TimerReset } from "lucide-react";
import type { StaleResponseDTO } from "../../api/types.js";
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
import { fetchStale } from "../lib/api.js";
import { formatAbsolute, formatRelative } from "../lib/format.js";

function loadStale(signal: AbortSignal): Promise<StaleResponseDTO> {
  return fetchStale({ signal });
}

export function StalePage() {
  const { data, error, loading, retry } = useApiQuery<StaleResponseDTO>(loadStale);
  const now = useNow();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Stale / resumable</h1>
        {data && (
          <p className="text-sm text-muted-foreground">
            {data.rows.length} ticket{data.rows.length === 1 ? "" : "s"} idle past threshold
            (in_progress: {data.config.defaults.stale_after}, review:{" "}
            {data.config.defaults.review_stale_after}), longest-idle first.
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

      {data && data.rows.length === 0 && (
        <EmptyState
          icon={TimerReset}
          title="Nothing stale right now"
          description="Everything in progress or in review is moving."
        />
      )}

      {data && data.rows.length > 0 && (
        <Table>
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
            {data.rows.map(({ ticket, since }) => (
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
      )}
    </div>
  );
}
