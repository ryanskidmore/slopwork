import { AlertCircle, RotateCcw } from "lucide-react";
import { Button } from "./ui/button.js";

export function QueryErrorState({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: Error;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-32 flex-col items-start justify-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-5 text-sm"
    >
      <div className="flex items-center gap-2 font-medium text-destructive">
        <AlertCircle className="size-4" aria-hidden="true" />
        {title}
      </div>
      <p className="max-w-2xl text-muted-foreground">{error.message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCcw aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}
