import { Loader2 } from "lucide-react";
import type { PaginationDTO } from "../../api/types.js";
import { Button } from "./ui/button.js";

export function CollectionLoadMore({
  pagination,
  loaded,
  pending,
  error,
  onLoadMore,
  noun = "items",
}: {
  pagination: PaginationDTO | null;
  loaded: number;
  pending: boolean;
  error: Error | null;
  onLoadMore: () => void;
  noun?: string;
}) {
  if (!pagination || pagination.total === 0) return null;
  const hasMore = pagination.next_page !== null;
  return (
    <div className="flex min-h-10 flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
      <span className="text-xs text-muted-foreground" aria-live="polite">
        Showing {loaded} of {pagination.total} {noun}
      </span>
      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>Could not load more: {error.message}</span>
          <Button variant="outline" size="sm" onClick={onLoadMore}>
            Retry
          </Button>
        </div>
      ) : hasMore ? (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          aria-busy={pending}
          onClick={onLoadMore}
        >
          {pending && <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />}
          {pending ? "Loading" : "Load more"}
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">All loaded</span>
      )}
    </div>
  );
}
