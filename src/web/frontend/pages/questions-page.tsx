import { HelpCircle } from "lucide-react";
import type { QuestionsResponseDTO } from "../../api/types.js";
import { EmptyState } from "../components/empty-state.js";
import { QueryErrorState } from "../components/query-error-state.js";
import { StateBadge } from "../components/state-badge.js";
import { TicketLink } from "../components/ticket-link.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { useNow } from "../hooks/use-now.js";
import { useApiQuery } from "../hooks/use-api-query.js";
import { fetchQuestions } from "../lib/api.js";
import { formatAbsolute, formatRelative } from "../lib/format.js";

function loadQuestions(signal: AbortSignal): Promise<QuestionsResponseDTO> {
  return fetchQuestions({ signal });
}

/**
 * `/questions` — the elicitations inbox (G4, t-jggg9): every unanswered
 * question across the project, oldest first, grouped by ticket — the web
 * counterpart of `slop questions`. Mirrors `/review`'s "longest-waiting
 * -first" panel shape, but grouped (a ticket can have more than one open
 * question, unlike review's one-MR-per-ticket).
 */
export function QuestionsPage() {
  const { data, error, loading, retry } = useApiQuery<QuestionsResponseDTO>(loadQuestions);
  const now = useNow();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Questions</h1>
        {data && (
          <p className="text-sm text-muted-foreground">
            {data.total_questions} unanswered question{data.total_questions === 1 ? "" : "s"} across{" "}
            {data.groups.length} ticket{data.groups.length === 1 ? "" : "s"}, oldest first.
          </p>
        )}
      </div>

      {loading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {error && <QueryErrorState title="Questions unavailable" error={error} onRetry={retry} />}

      {data && data.groups.length === 0 && (
        <EmptyState
          icon={HelpCircle}
          title="No open questions"
          description="Nothing is waiting on a human answer right now."
        />
      )}

      {data &&
        data.groups.map((group) => (
          <Card key={group.ticket.id}>
            <CardContent className="flex flex-col gap-3 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <StateBadge state={group.ticket.state} />
                <span className="font-medium">
                  <TicketLink ticket={group.ticket} />
                </span>
                <span className="text-xs text-muted-foreground">
                  {group.questions.length} question{group.questions.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="flex flex-col gap-3">
                {group.questions.map((q) => (
                  <li key={q.id} className="rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm">{q.text}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        asked by {q.asked_by.name}
                      </span>
                      <time
                        dateTime={q.asked_at}
                        title={formatAbsolute(q.asked_at)}
                        className="shrink-0 font-mono text-xs text-muted-foreground"
                      >
                        {formatRelative(q.asked_at, now)}
                      </time>
                    </div>
                    {q.options.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {q.options.map((option) => (
                          <span
                            key={option}
                            className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                          >
                            {option}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
    </div>
  );
}
